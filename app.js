/**
 * ══════════════════════════════════════════════════════════════════════════
 * PORTAL DE REUNIONES BIONIC MIND — Frontend
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Un solo archivo, pero por módulos separados (Cfg · API · Reloj · Sesion ·
 * Audio · Confeti · UI · Jitsi · Sala · Dashboard · Asistencia · Config · App).
 *
 * Por qué NO son módulos ES separados: el requisito es que index.html funcione
 * abriéndolo directo con doble clic, y desde file:// el navegador bloquea los
 * `import` (los trata como petición cross-origin). Con <script> clásicos anda en
 * los dos lados. La separación es real igual — cada módulo es un IIFE que expone
 * solo lo suyo.
 */

/* eslint-env browser */
(function () {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   Cfg — configuración
   ══════════════════════════════════════════════════════════════════════════ */
var Cfg = (function () {
  var LLAVE_API = 'portal_api_url';

  return {
    /*
     * La app web de Apps Script del portal (Bionic Mind, ago 2026).
     *
     * Si algún día se vuelve a publicar el backend con "Nueva implementación" en
     * vez de "Gestionar implementaciones → editar", la URL CAMBIA y hay que
     * actualizarla acá. Desde la pestaña Configuración se puede pisar sin tocar el
     * código: lo que se guarde en el navegador tiene prioridad sobre esta línea.
     */
    URL_POR_DEFECTO: 'https://script.google.com/macros/s/AKfycbx8-OHPoWQhw6_4p0HcUFs-jQln8rll0tyA3MNdrtShpRWnvubfaAPm_B-FBYJUbcMcyQ/exec',

    /*
     * 🔴 DOS cadencias, y la lenta NO es lenta. Adentro de una sala no existe el
     * modo barato, aunque parezca que no está pasando nada.
     *
     * Hubo una tercera cadencia de 10 s "para cuando la sala está cerrada" y el
     * test con dos navegadores la mató: el asesor se pasó el countdown ENTERO
     * viendo "el festejo se habilita cuando la sala esté abierta" y se enteró
     * recién en el cierre. El razonamiento fallado era que con la sala cerrada no
     * hay nada que perderse — pero lo que se está esperando ahí es justo que la
     * sala se abra, y el sondeo que iba a notarlo estaba a 10 segundos.
     *
     * En una reunión eso se ve como "no me dio tiempo a anotar mi venta", nunca
     * como un error, y el que lo sufre es el que vendió. Los pedidos que se
     * ahorraban eran de una lectura de caché: nada, al lado de eso.
     *
     * El sondeo barato vive en el DASHBOARD (12 s), que es donde de verdad no
     * hay nada urgente que mirar.
     */
    POLL_ACTIVO_MS: 2000,    // countdown o destape en curso
    POLL_SALA_MS: 3500,      // cualquier otro momento dentro de una sala
    ASIS_PING_MS: 60000,     // un latido por minuto con la cámara encendida
    COUNTDOWN_MS: 30000,     // tiene que coincidir con el backend (solo para el anillo)
    MOD_AVISO_MS: 18000,     // sin ser moderador después de esto, se explica cómo

    url: function () {
      try { return localStorage.getItem(LLAVE_API) || this.URL_POR_DEFECTO; }
      catch (e) { return this.URL_POR_DEFECTO; }
    },
    guardarUrl: function (u) {
      try { localStorage.setItem(LLAVE_API, String(u || '').trim()); } catch (e) {}
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   API — el puente con Google Apps Script
   ══════════════════════════════════════════════════════════════════════════ */
var API = (function () {

  /**
   * 🔴 El Content-Type es text/plain A PROPÓSITO, aunque el cuerpo sea JSON.
   *
   * Con application/json el navegador manda antes un preflight OPTIONS, y Apps
   * Script no puede contestarlo: ContentService no deja poner headers, así que no
   * hay forma de responder el CORS. Con text/plain la petición es "simple", no
   * hay preflight, y el backend hace JSON.parse del cuerpo igual.
   *
   * ⚠️ Si alguien lo "corrige" a application/json, el portal deja de funcionar
   * entero desde el navegador y sigue andando perfecto desde curl o Postman.
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 🔴 El transporte de Apps Script es de UN SOLO USO. Por eso hay reintentos.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * `/exec` no devuelve datos: devuelve un 302 a
   * `script.googleusercontent.com/macros/echo?user_content_key=…`, y esa clave se
   * CONSUME en la primera lectura (comprobado contra el backend de producción:
   * primera lectura 200, segunda 302 y después 404).
   *
   * Si el navegador pide esa URL dos veces —reintento silencioso de conexión, la
   * carrera QUIC/TCP de Chrome la primera vez que habla con ese host, la pestaña
   * ocupada montando Jitsi— la segunda llega con la clave gastada y sale un 404.
   * No es un fallo del portal ni del despliegue: es cómo funciona Apps Script, y
   * pasa MÁS AL PRINCIPIO, que es cuando la conexión todavía se está armando.
   *
   * Sin esto el síntoma era: recargar la página tiraba la sesión guardada a la
   * pantalla de login sin ningún mensaje, y el intento siguiente acusaba al
   * despliegue con un cartel rojo que no tenía nada que ver.
   */
  var REINTENTOS = 2;
  var ESPERA_MS  = [400, 1200];

  /*
   * 🔴 Qué se puede reintentar y qué NO.
   *
   * Cuando el navegador ve el 404, EL BACKEND YA CORRIÓ. Repetir la llamada la
   * ejecuta de nuevo. Los GET son todos de lectura, así que van todos. Los POST
   * escriben, y solo entran los que repetir NO CAMBIA NADA OBSERVABLE:
   *
   *   · login            — repetir emite un segundo token y nada más. El contador
   *                        de intentos fallidos no se infla: una contraseña mala
   *                        vuelve HTTP 200 con {ok:false}, que no es un fallo
   *                        transitorio y por lo tanto no se reintenta.
   *   · pingAsistencia   — `pingAsistencia_` descarta los latidos separados por
   *                        menos de 51 s (ASIS_PING_MS * 0.85), así que el
   *                        reintento es un no-op por construcción del backend.
   *   · confirmarModerador — pone un booleano en su valor final (idempotente). Lo
   *                        único que repite es una fila del registro de anfitrión,
   *                        que el propio backend documenta como "registro, no
   *                        estado". Ese costo es NADA al lado de lo que evita: si
   *                        esta llamada se pierde, la sala NO SE ABRE PARA NADIE y
   *                        toda la filial queda esperando al moderador.
   *
   * ⚠️ `registrarProduccion` NO está y no puede estar: un reintento anotaría la
   * matrícula DOS VECES en pleno festejo, y nadie lo notaría hasta cuadrar los
   * números. Tampoco `iniciarRonda` ni `reclamarAnfitrion`. Los tres fallan a la
   * vista (toast rojo) y con el botón ahí para volver a apretar.
   *
   * La lista corta es a propósito: cada entrada es una promesa de que repetir es
   * inofensivo. Antes de agregar una, hay que poder escribir el porqué acá.
   */
  var POST_REPETIBLE = { login: true, pingAsistencia: true, confirmarModerador: true };

  function post(data) {
    var url = Cfg.url();
    if (!url) return Promise.reject(new Error('Falta configurar la dirección del backend.'));
    var repetible = !!(data && POST_REPETIBLE[data.accion]);
    return conReintento(function () {
      return pedir(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(data),
        redirect: 'follow'
      });
    }, repetible);
  }

  function get(params) {
    var url = Cfg.url();
    if (!url) return Promise.reject(new Error('Falta configurar la dirección del backend.'));
    var qs = Object.keys(params)
      .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    // Todas las acciones GET del backend son de lectura: reintentar es gratis.
    return conReintento(function () {
      return pedir(url + '?' + qs, { method: 'GET', redirect: 'follow' });
    }, true);
  }

  /**
   * Una petición, con el fallo de red convertido en error marcado.
   *
   * ⚠️ El segundo argumento de `.then` atrapa SOLO el rechazo de `fetch` (red
   * caída, CORS), nunca lo que lance `leer`. Con un `.catch` encadenado se
   * tragaría también la sesión vencida y el reintento la repetiría al pedo.
   */
  function pedir(url, opciones) {
    return fetch(url, opciones).then(leer, function () {
      throw transitorio_(new Error('No se pudo contactar con el servidor. Revise la conexión.'));
    });
  }

  /**
   * Reintenta solo lo que se marcó como transitorio, y solo si repetirlo es
   * seguro. Un error de negocio o de sesión sale derecho, sin esperas inútiles.
   */
  function conReintento(hacer, repetible) {
    function intento(n) {
      return hacer().catch(function (e) {
        if (!repetible || !e || !e.transitorio || n >= REINTENTOS) throw e;
        return new Promise(function (listo) { setTimeout(listo, ESPERA_MS[n]); })
          .then(function () { return intento(n + 1); });
      });
    }
    return intento(0);
  }

  function transitorio_(e) { e.transitorio = true; return e; }

  /**
   * 🔴 El STATUS se mira ANTES que el cuerpo.
   *
   * Mientras no se miraba, un 404 entraba como texto, `JSON.parse` fallaba, y como
   * el cuerpo del 404 de Google ES HTML se disparaba la rama de abajo: el usuario
   * veía "se publicó con acceso restringido" y salía a revisar un despliegue que
   * estaba perfecto. El mensaje de acceso restringido vale solo con HTTP 200,
   * que es como llega de verdad el HTML del login de Google.
   */
  function leer(res) {
    if (!res.ok) throw errorHttp_(res.status);

    return res.text().then(function (txt) {
      var r;
      try {
        r = JSON.parse(txt);
      } catch (e) {
        // El síntoma clásico de haber publicado con el acceso equivocado: en vez
        // de JSON llega el HTML del inicio de sesión de Google. Sin este mensaje,
        // el error que se ve es un críptico "Unexpected token <".
        if (/<!DOCTYPE|<html/i.test(txt)) {
          throw new Error('El backend respondió una página web en vez de datos. Suele ser que la app web se publicó con acceso restringido: tiene que estar en "Cualquier persona".');
        }
        throw new Error('El backend respondió algo que no se pudo leer.');
      }
      // Sesión vencida: se distingue de un error cualquiera para no mostrar un
      // cartel rojo inútil cuando lo que hay que hacer es volver a entrar.
      if (r && r.error === 'auth') { Sesion.caida(); throw new Error(r.message || 'Sesión vencida.'); }
      Reloj.sincronizar(r);
      return r;
    });
  }

  /**
   * El mensaje es el que la persona ve DESPUÉS de que los reintentos se agotaron,
   * así que no dice "reintentando": dice qué pasó y qué hacer.
   */
  function errorHttp_(status) {
    if (status === 404) {
      return transitorio_(new Error('Google no entregó la respuesta (404). Suele ser pasajero: vuelva a intentar.'));
    }
    if (status === 429) {
      return transitorio_(new Error('El servidor está saturado. Espere unos segundos y vuelva a intentar.'));
    }
    if (status >= 500) {
      return transitorio_(new Error('El servidor de Google falló (' + status + '). Vuelva a intentar.'));
    }
    return new Error('El servidor respondió ' + status + '.');
  }

  return { post: post, get: get };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Reloj — desfase contra el servidor
   ══════════════════════════════════════════════════════════════════════════ */
var Reloj = (function () {
  /*
   * El countdown NO se descuenta en el servidor: el backend manda `finTs`
   * (un instante absoluto) y `serverNow`. Acá se guarda la diferencia contra el
   * reloj local y el número se descuenta sin pedir nada por red.
   *
   * Así el reloj corre suave a 1 tick por segundo aunque la respuesta tarde, y
   * —lo importante— todas las pantallas de la sala marcan lo mismo, porque todas
   * apuntan al mismo instante absoluto en vez de contar cada una por su cuenta.
   */
  var desfase = 0;
  var sincronizado = false;

  /* Un salto por debajo de esto se toma como demora de la red, no como que el
     reloj se corrió de verdad. */
  var TOLERANCIA_MS = 2000;

  return {
    /*
     * ⚠️ El desfase se fija UNA vez y solo se corrige ante una diferencia grande.
     *
     * Recalcularlo en cada respuesta parece lo más exacto, pero `serverNow` se
     * mide antes de que la respuesta viaje: cada consulta llega con una demora
     * distinta (200 ms, 600 ms, 300 ms…) y el desfase se mueve con ella. Con el
     * redondeo hacia arriba del contador, eso hace que el número repita o saltee
     * segundos — un reloj que titubea, y en la pantalla que toda la sala está
     * mirando fijo. Se prefiere un desfase estable y levemente conservador antes
     * que uno exacto y nervioso.
     */
    sincronizar: function (r) {
      if (!r || typeof r.serverNow !== 'number') return;
      var nuevo = r.serverNow - Date.now();
      if (!sincronizado || Math.abs(nuevo - desfase) > TOLERANCIA_MS) {
        desfase = nuevo;
        sincronizado = true;
      }
    },
    ahora: function () { return Date.now() + desfase; },
    /** Segundos que faltan hasta un instante del servidor, nunca negativos. */
    faltan: function (finTs) {
      if (!finTs) return 0;
      return Math.max(0, Math.ceil((finTs - this.ahora()) / 1000));
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Sesion
   ══════════════════════════════════════════════════════════════════════════ */
var Sesion = (function () {
  var LLAVE = 'portal_token';

  /*
   * Dónde se guarda el token depende de "mantener la sesión iniciada":
   *
   *   sin marcar → sessionStorage: muere al cerrar la pestaña. Es lo correcto en
   *                una computadora compartida, que en la oficina es lo normal.
   *   marcado    → localStorage: sobrevive, y el servidor emite un token de 30
   *                días en vez de 12 h.
   *
   * 🔴 Lo que se guarda es el TOKEN, NUNCA la contraseña. Los paneles del CRM
   * arrastran de antes la costumbre de guardar contraseñas en el navegador; acá
   * no se repite. El token se puede vencer y se revalida contra la hoja en cada
   * llamada; una contraseña guardada no se puede deshacer.
   *
   * El portal vive en github.io, otro dominio que los paneles del CRM, así que su
   * almacenamiento es independiente: no hay forma de que pise las llaves de sesión
   * de los otros paneles.
   */
  function leer(almacen) {
    try { return almacen.getItem(LLAVE); } catch (e) { return null; }
  }

  return {
    token: null,
    usuario: null,

    recuperar: function () {
      // Primero el recordado, después el de esta pestaña.
      this.token = leer(localStorage) || leer(sessionStorage);
      return this.token;
    },
    guardar: function (token, usuario, recordar) {
      this.token = token; this.usuario = usuario;
      try {
        // Se limpian los DOS antes de escribir: si alguien entra sin marcar
        // "recordar" después de haberlo marcado, el token viejo tiene que
        // desaparecer del almacenamiento persistente, no quedar ahí vigente.
        localStorage.removeItem(LLAVE);
        sessionStorage.removeItem(LLAVE);
        (recordar ? localStorage : sessionStorage).setItem(LLAVE, token);
      } catch (e) {}
    },
    limpiar: function () {
      this.token = null; this.usuario = null;
      try { sessionStorage.removeItem(LLAVE); } catch (e) {}
      try { localStorage.removeItem(LLAVE); } catch (e) {}
    },
    /** La sesión venció mientras se usaba el portal. */
    caida: function () {
      if (!this.token) return;
      this.limpiar();
      App.mostrarLogin('Su sesión venció. Ingrese de nuevo.');
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Audio — porteado de audioCelebration.ts (Web Audio API)
   ══════════════════════════════════════════════════════════════════════════ */
var Audio_ = (function () {
  var ctx = null;
  var desbloqueado = false;

  function contexto() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  /**
   * 🔴 Se llama desde el clic de ingresar, y no cuando suena el primer festejo.
   *
   * Los navegadores no dejan reproducir nada hasta que la persona interactuó con
   * la página. Si el AudioContext se creara recién en el destape, la PRIMERA
   * sirena —la única que importa, con toda la sala mirando— saldría muda, y la
   * segunda ya andaría. Un fallo que no se puede reproducir probando.
   */
  function desbloquear() {
    if (desbloqueado) return;
    var c = contexto();
    if (!c) return;
    try {
      var b = c.createBuffer(1, 1, 22050);
      var s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
      desbloqueado = true;
    } catch (e) {}
  }

  /** Ruido blanco con picos, filtrado en banda: suena a gente aplaudiendo. */
  function aplausos(c, inicio, duracion, volMax) {
    var muestras = Math.floor(c.sampleRate * duracion);
    var buffer = c.createBuffer(2, muestras, c.sampleRate);
    var izq = buffer.getChannelData(0);
    var der = buffer.getChannelData(1);
    for (var i = 0; i < muestras; i++) {
      var pico = Math.random() > 0.985 ? Math.random() * 3 : 1;   // el golpe de una palmada
      izq[i] = (Math.random() * 2 - 1) * pico;
      der[i] = (Math.random() * 2 - 1) * pico;
    }

    var ruido = c.createBufferSource();
    ruido.buffer = buffer;

    var gain = c.createGain();
    gain.gain.setValueAtTime(0, inicio);
    gain.gain.linearRampToValueAtTime(volMax, inicio + 0.2);
    gain.gain.setValueAtTime(volMax, inicio + duracion - 0.8);
    gain.gain.exponentialRampToValueAtTime(0.001, inicio + duracion);

    [{ f: 1400, q: 1.2 }, { f: 2800, q: 2.0 }].forEach(function (cfg) {
      var filtro = c.createBiquadFilter();
      filtro.type = 'bandpass';
      filtro.frequency.setValueAtTime(cfg.f, inicio);
      filtro.Q.setValueAtTime(cfg.q, inicio);
      ruido.connect(filtro);
      filtro.connect(gain);
    });

    gain.connect(c.destination);
    ruido.start(inicio);
    ruido.stop(inicio + duracion);
  }

  /** Abono: arpegio ascendente corto + aplausos. */
  function sonidoAbono() {
    var c = contexto(); if (!c) return;
    var t0 = c.currentTime;
    [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach(function (freq, i) {
      var osc = c.createOscillator(), gain = c.createGain();
      var t = t0 + i * 0.1;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.3, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t); osc.stop(t + 1.2);
    });
    aplausos(c, t0 + 0.2, 2.5, 0.15);
  }

  /** Matrícula: sirena doble + fanfarria de metales + aplausos. */
  function sonidoMatricula() {
    var c = contexto(); if (!c) return;
    var t0 = c.currentTime;
    var dur = 4.8;

    [{ base: 450, det: 0 }, { base: 540, det: 12 }].forEach(function (s) {
      var osc = c.createOscillator(), gain = c.createGain(), filtro = c.createBiquadFilter();
      osc.type = 'sawtooth';
      osc.detune.setValueAtTime(s.det, t0);
      filtro.type = 'lowpass';
      filtro.frequency.setValueAtTime(2200, t0);
      for (var i = 0; i < 4; i++) {
        var ini = t0 + i * (dur / 4);
        var med = ini + (dur / 4) * 0.5;
        var fin = ini + (dur / 4);
        osc.frequency.setValueAtTime(s.base, ini);
        osc.frequency.exponentialRampToValueAtTime(s.base * 2.2, med);
        osc.frequency.exponentialRampToValueAtTime(s.base, fin);
      }
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.2);
      gain.gain.setValueAtTime(0.22, t0 + dur - 0.5);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(filtro); filtro.connect(gain); gain.connect(c.destination);
      osc.start(t0); osc.stop(t0 + dur);
    });

    [
      { t: 0.3, notas: [261.63, 329.63, 392.00, 523.25], largo: 0.6 },
      { t: 0.9, notas: [349.23, 440.00, 523.25, 698.46], largo: 0.6 },
      { t: 1.5, notas: [392.00, 493.88, 587.33, 783.99], largo: 0.7 },
      { t: 2.3, notas: [523.25, 659.25, 783.99, 1046.50, 1318.51], largo: 2.2 }
    ].forEach(function (acorde) {
      acorde.notas.forEach(function (freq) {
        var osc = c.createOscillator(), gain = c.createGain(), filtro = c.createBiquadFilter();
        var t = t0 + acorde.t;
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t);
        filtro.type = 'lowpass';
        filtro.frequency.setValueAtTime(1800, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + acorde.largo);
        osc.connect(filtro); filtro.connect(gain); gain.connect(c.destination);
        osc.start(t); osc.stop(t + acorde.largo);
      });
    });

    aplausos(c, t0 + 0.1, dur, 0.25);
  }

  return {
    desbloquear: desbloquear,
    tocar: function (tipo) {
      try { tipo === 'matricula' ? sonidoMatricula() : sonidoAbono(); } catch (e) {}
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Confeti
   ══════════════════════════════════════════════════════════════════════════ */
var Confeti = (function () {
  function tirar(tipo) {
    if (typeof window.confetti !== 'function') return;   // el CDN no cargó: se sigue sin papelitos
    var cfg = tipo === 'matricula'
      ? { particleCount: 110, spread: 90, colors: ['#2563eb', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'] }
      : { particleCount: 70,  spread: 70, colors: ['#f59e0b', '#10b981', '#3b82f6'] };
    cfg.origin = { y: 0.62 };
    try {
      window.confetti(cfg);
      setTimeout(function () {
        window.confetti(Object.assign({}, cfg, { angle: 60, origin: { x: 0, y: 0.7 } }));
        window.confetti(Object.assign({}, cfg, { angle: 120, origin: { x: 1, y: 0.7 } }));
      }, 220);
    } catch (e) {}
  }
  return { tirar: tirar };
})();


/* ══════════════════════════════════════════════════════════════════════════
   UI — helpers de pantalla
   ══════════════════════════════════════════════════════════════════════════ */
var UI = (function () {
  function $(sel) { return document.querySelector(sel); }
  function id(x) { return document.getElementById(x); }

  /** Todo lo que viene de la hoja pasa por acá antes de tocar innerHTML. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mostrar(el, si) {
    if (!el) return;
    el.classList.toggle('oculto', !si);
  }

  var ICONO = { ok: 'check_circle', error: 'error', info: 'info' };

  function toast(mensaje, tipo) {
    tipo = tipo || 'info';
    var cont = id('toasts');
    if (!cont) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + tipo;
    el.innerHTML = '<span class="material-symbols-rounded">' + ICONO[tipo] + '</span><span>' + esc(mensaje) + '</span>';
    cont.appendChild(el);
    setTimeout(function () {
      el.classList.add('saliendo');
      setTimeout(function () { el.remove(); }, 220);
    }, tipo === 'error' ? 6000 : 3800);
  }

  /** "Natalia Romay" → "NR". Lo que se muestra cuando no hay foto cargada. */
  function iniciales(nombre) {
    var p = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  /**
   * Avatar de una persona: su foto, o sus iniciales.
   *
   * ⚠️ Las fotos son enlaces de Drive (drive.google.com/thumbnail?id=…) y dependen
   * de que ese archivo esté compartido. Si uno no carga, se cae a las iniciales en
   * vez de dejar el ícono de imagen rota: media empresa sin foto se vería peor que
   * media empresa con iniciales.
   */
  function avatar(foto, nombre, clase) {
    var cls = 'avatar' + (clase ? ' ' + clase : '');
    /*
     * 🔴 Las iniciales van SIEMPRE, y la foto las tapa cuando termina de cargar.
     *
     * Al revés —foto primero, iniciales solo si falla— el círculo se ve VACÍO todo
     * el tiempo que tarda la descarga. Son fotos de Drive: en la oficina cargan al
     * instante, pero con internet flojo se ve un hueco, y el internet flojo es
     * justo el de la reunión. Así nunca hay un momento sin nada.
     *
     * Si la imagen no llega, se saca y quedan las iniciales, que ya estaban.
     */
    return '<span class="' + cls + '"><i>' + esc(iniciales(nombre)) + '</i>' +
      (foto ? '<img src="' + esc(foto) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
      '</span>';
  }

  function hora(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
  }

  return { $: $, id: id, esc: esc, mostrar: mostrar, toast: toast, hora: hora, avatar: avatar, iniciales: iniciales };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Jitsi — la videollamada, y la detección REAL de moderador
   ══════════════════════════════════════════════════════════════════════════ */
var Jitsi = (function () {
  var api = null;
  var miId = null;
  var salaMontada = null;
  var avisoModTimer = null;

  function disponible() { return typeof window.JitsiMeetExternalAPI === 'function'; }

  /*
   * 🔴 La sala se monta con un PERMISO firmado por el servidor, no sola.
   *
   * Con JaaS, quien entra tiene que traer un permiso (un JWT) que el backend firma
   * con la clave privada de la empresa. Eso trae dos cosas que con meet.jit.si eran
   * imposibles: el moderador lo decide el PORTAL —según el gate de cargo contra la
   * hoja Ejecutivos— y el permiso vale para UNA sala, no para todas.
   *
   * Por eso `montar` recibe `entrada`, que es lo que devolvió `videoEntrada` del
   * backend: el dominio, el nombre completo de la sala (con el App ID adelante) y
   * el permiso firmado.
   */
  function montar(entrada, usuario) {
    if (salaMontada === entrada.sala && api) return;
    desmontar();

    var cont = UI.id('jitsiCont');
    if (!cont || !disponible()) return;

    var opciones = {
      roomName: entrada.sala,
      jwt: entrada.jwt,
      width: '100%',
      height: '100%',
      parentNode: cont,
      configOverwrite: {
        startWithVideoMuted: true,
        startWithAudioMuted: true,
        prejoinPageEnabled: true,
        disableDeepLinking: true,
        enableWelcomePage: false,
        // Jitsi trae su propia interfaz y por defecto la sirve en inglés: el cartel
        // de 'no moderators have yet arrived' aparecía así en pleno arranque de la
        // reunión. Es la pantalla que más gente va a leer del portal sin que la
        // hayamos escrito nosotros, así que va en el idioma de la casa.
        defaultLanguage: 'es',
        /*
         * ════════════════════════════════════════════════════════════════════
         * 🔴 ESTO ES UNA LISTA BLANCA: lo que no esté acá DESAPARECE de la barra.
         * ════════════════════════════════════════════════════════════════════
         *
         * Es la lista COMPLETA de Jitsi (config.js del proyecto, 32 botones) menos
         * DOS. Se escribe entera a propósito, aunque sea larga: la primera versión
         * listó solo los 13 que se me ocurrieron y **borró 18 funciones sin que
         * nadie lo pidiera** — entre ellas compartir video por enlace, que el dueño
         * usaba, y el cambio de cámara del teléfono. Nadie ve un error: las
         * funciones simplemente ya no están, y hay que acordarse de que existían.
         *
         * Los que se sacan, y por qué. Cada uno tiene que poder justificarse acá:
         *
         *   · `fullscreen` — la pantalla completa de Jitsi maximiza SOLO su iframe y
         *     deja afuera los botones de producción, la cuenta regresiva y el
         *     festejo: quien la usara perdería justo lo que vino a mirar. El portal
         *     pone la suya, que agranda el contenedor entero.
         *   · `feedback` — encuesta de 8x8, ajena a la empresa. Pedido del dueño.
         *   · `download` — ofrece bajarse la app de Jitsi, y ahí NO EXISTEN el
         *     festejo ni la asistencia: es un botón que saca a la gente de la propia
         *     herramienta. Decisión del dueño (ago 2026).
         *
         * 🔴 Y estos tres, porque EL PERMISO QUE FIRMAMOS YA LOS DESHABILITA. Ver
         * `features` en `jaasToken_` (gas-backend.gs): `recording`, `livestreaming` y
         * `transcription` van en false. Dejarlos en la barra es prometer algo que al
         * apretarlo no pasa — y en una reunión eso se lee como que el portal falla:
         *
         *   · `recording`      — grabar          (features.recording: false)
         *   · `livestreaming`  — transmitir      (features.livestreaming: false)
         *   · `closedcaptions` — subtítulos      (features.transcription: false)
         *
         * ⚠️ Si algún día se habilita alguna de esas tres en el permiso, hay que
         * devolver su botón acá: si no, la función queda pagada y escondida.
         *
         * ⚠️ Si Jitsi agrega un botón nuevo, NO va a aparecer hasta que se sume acá.
         * Es el precio de poder esconder esos dos: no existe una lista negra.
         *
         * ⚠️ `toggle-camera` cambia entre la cámara de adelante y la de atrás y SOLO
         * sale en el teléfono: en la computadora no se nota si falta, y en el celular
         * ata a la persona a la cámara que le tocó.
         *
         * ⚠️ Nada de nombres inventados: `filmstrip` estuvo en la primera versión y
         * NO existe en el catálogo de Jitsi — se ignoraba en silencio, dando la
         * falsa impresión de que esa función estaba contemplada.
         */
        toolbarButtons: [
          'camera', 'chat', 'desktop', 'embedmeeting', 'etherpad',
          'hangup', 'help', 'highlight', 'invite', 'linktosalesforce',
          'microphone', 'noisesuppression', 'participants-pane', 'profile',
          'raisehand', 'security', 'select-background', 'settings',
          'shareaudio', 'sharedvideo', 'shortcuts', 'stats', 'tileview',
          'toggle-camera', 'videoquality', 'whiteboard'
        ]
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false,
        DEFAULT_REMOTE_DISPLAY_NAME: 'Participante Bionic Mind',
        LANG_DETECTION: false
      },
      userInfo: {
        // El cargo va en el nombre, decisión del dueño: en la reunión se ve de
        // quién es cada recuadro sin tener que preguntarlo.
        displayName: usuario.nombre + (usuario.cargo ? ' (' + String(usuario.cargo).toUpperCase() + ')' : '')
      }
    };

    try { api = new window.JitsiMeetExternalAPI(entrada.dominio, opciones); }
    catch (e) { api = null; return; }

    salaMontada = entrada.sala;

    try {
      var iframe = api.getIFrame();
      if (iframe) iframe.setAttribute('allow', 'camera; microphone; display-capture; autoplay; clipboard-write');
    } catch (e) {}

    api.addEventListener('videoConferenceJoined', function (ev) {
      miId = ev && ev.id;
      Sala.alEntrarAJitsi();
    });

    /*
     * 🔴 Acá se decide si la sala se abre para todos.
     *
     * Se espera el HECHO, no la intención.
     *
     * Con JaaS el permiso de entrada ya viene firmado diciendo quién es moderador,
     * así que este evento llega solo y al instante — el anfitrión ya no tiene que
     * iniciar sesión en ningún lado. Aun así el portal NO destapa el video porque
     * alguien apretó el botón: si por lo que fuera el permiso no llegara a valer
     * (clave vencida, sala mal armada), los demás caerían en "esperando al
     * moderador" sin ningún error a la vista y sin saber a quién reclamarle.
     */
    api.addEventListener('participantRoleChanged', function (ev) {
      if (!ev || ev.id !== miId) return;
      Sala.alCambiarRol(ev.role === 'moderator');
    });

    // Cámara encendida/apagada → es lo que alimenta el registro de asistencia.
    api.addEventListener('videoMuteStatusChanged', function (ev) {
      Sala.alCambiarCamara(!(ev && ev.muted));
    });

    api.addEventListener('videoConferenceLeft', function () {
      Sala.alCambiarCamara(false);
    });

    /*
     * 🔴 Colgar tiene que devolver al listado de filiales, no dejar una pantalla en
     * blanco.
     *
     * Jitsi avisa con `readyToClose` que ya terminó y que lo saquemos de la página.
     * Mientras nadie escuchaba ese aviso, el iframe se quedaba mostrando SU pantalla
     * de despedida —la blanca— y el portal seguía como si la reunión continuara:
     * sondeando la sala, con la pestaña "Reunión" activa y sin ninguna salida a la
     * vista salvo tocar "Volver".
     *
     * ⚠️ Se sale por `setTimeout` a propósito: acá adentro seguimos dentro del
     * despacho del evento de Jitsi, y lo primero que hace la salida es `dispose()`
     * sobre esta misma instancia. Destruir el objeto mientras corre uno de sus
     * handlers es pedirle que reviente en la única pantalla donde el usuario ya no
     * puede hacer nada.
     *
     * Cubre las tres formas de terminar: colgar, cancelar en la pantalla previa, y
     * que el anfitrión termine la reunión para todos.
     */
    api.addEventListener('readyToClose', function () {
      setTimeout(function () { Sala.alColgar(); }, 0);
    });

    // Si en un rato largo no llegó el rol de moderador, el permiso firmado no fue
    // aceptado. Se avisa en vez de dejar la sala trabada en silencio.
    clearTimeout(avisoModTimer);
    avisoModTimer = setTimeout(function () { Sala.avisarModeradorDemorado(); }, Cfg.MOD_AVISO_MS);
  }

  function desmontar() {
    clearTimeout(avisoModTimer);
    if (api) { try { api.dispose(); } catch (e) {} }
    api = null; miId = null; salaMontada = null;
    var cont = UI.id('jitsiCont');
    if (cont) cont.innerHTML = '';
  }

  /**
   * Termina la videollamada PARA TODOS. Solo la acepta Jitsi si quien la manda
   * tiene la corona, y el permiso de la corona lo firma el servidor.
   *
   * ⚠️ Jitsi IGNORA EN SILENCIO un comando que no conoce: si esta orden no llegara
   * a existir en la versión servida, acá no pasa nada y no hay error que ver. Por
   * eso el llamador libera la sala igual — pase lo que pase con el comando, el
   * portal queda coherente: la reunión figura terminada y la sala, libre.
   */
  function terminarParaTodos() {
    if (!api) return false;
    try { api.executeCommand('endConference'); return true; } catch (e) { return false; }
  }

  /** Cuántos hay en la llamada, para poder decirlo en la confirmación. */
  function cuantos() {
    if (!api) return 0;
    try { return api.getNumberOfParticipants() || 0; } catch (e) { return 0; }
  }

  return {
    montar: montar, desmontar: desmontar, disponible: disponible,
    montada: function () { return !!api; },
    terminarParaTodos: terminarParaTodos, cuantos: cuantos
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Sala — el corazón: polling, countdown y festejo
   ══════════════════════════════════════════════════════════════════════════ */
var Sala = (function () {
  var S = {
    sala: null,          // {id, nombre, roomCode, ...}
    estado: null,        // última respuesta de estadoSala
    registreEn: null,    // rondaId donde YO anoté (memoria local de esta pestaña)
    ultimoDestape: null, // rondaId:revelados ya festejado, para no repetirlo en cada poll
    timerPoll: null,
    timerTick: null,
    timerAsis: null,
    camaraOn: false,
    modAvisado: false,
    enviando: false,
    asisValidada: false, // asistencia ya registrada EN ESTA SALA
    redCaida: false,     // para no repetir el aviso de conexión en cada sondeo
    asisFaltan: null,
    ultimoItem: null,    // para el botón de repetir sirena
    ceroPedido: null     // finTs para el que ya se pidió la consulta del segundo cero
  };

  /* ── ciclo de vida ─────────────────────────────────────────────────── */

  function entrar(salaId) {
    salir();
    S.sala = { id: salaId };
    // Hasta que llegue la primera respuesta no se sabe el nombre. Sin esto queda
    // el título de la sala ANTERIOR unos segundos, que es peor que no decir nada.
    UI.id('salaTitulo').textContent = 'Cargando…';
    UI.id('salaManager').textContent = '';
    S.registreEn = null;
    S.ultimoDestape = null;
    S.modAvisado = false;
    // ⚠️ Igual que `asisValidada`: el rol de moderador es POR SALA. Sin este reset,
    // quien pasa de una sala a otra arrastra el "Jitsi ya me dio moderador" de la
    // anterior y el sondeo empieza a reintentar la apertura de una sala en la que
    // todavía no entró — un POST cada 3,5 s que nadie pidió.
    S.soyModeradorJitsi = false;
    S.modConfirmado = false;
    S.modRechazado = false;
    S.modEnviando = false;
    // ⚠️ La asistencia se cuenta POR SALA. Sin este reset, quien pasa de una sala
    // a otra arrastra el "ya validada" de la anterior y su asistencia a la segunda
    // reunión no se registra nunca — sin ningún error a la vista.
    S.asisValidada = false;
    S.asisFaltan = null;
    S.redCaida = false;
    S.ceroPedido = null;
    // "Ya se decidió algo sobre esta sala en esta visita". Ver `autoTomarSala`.
    S.autoTomaResuelta = false;
    poll();
    S.timerTick = setInterval(tick, 1000);
  }

  /*
   * Colgó (o lo colgaron). Se vuelve al listado de filiales.
   *
   * El guard de `S.sala` no es de más: `readyToClose` también llega cuando la salida
   * ya la disparó otra cosa —"Volver", cerrar sesión, entrar a otra sala—, y sin él
   * un aviso tardío tiraría al usuario al dashboard cuando ya está en otro lado.
   */
  function alColgar() {
    if (!S.sala) return;
    UI.toast('Salió de la reunión.', 'info');
    App.irA('dashboard');   // irA se encarga de llamar a salir()
  }

  function salir() {
    // Va acá y no en el botón "Salas": por esta función pasan TODOS los caminos de
    // salida —colgar, cerrar sesión, la sesión vencida, cambiar de sala— y cualquiera
    // de ellos deja la pantalla completa puesta sobre una vista escondida.
    Pantalla.apagar();
    clearTimeout(S.timerPoll); clearInterval(S.timerTick); clearInterval(S.timerAsis);
    S.timerPoll = S.timerTick = S.timerAsis = null;
    S.camaraOn = false;
    Jitsi.desmontar();
    cerrarCelebracion();
    S.sala = null; S.estado = null;
  }

  /* ── polling ───────────────────────────────────────────────────────── */

  /*
   * 🔴 UNA sola consulta en vuelo y UNA sola cadena de sondeo. No es prolijidad.
   *
   * Tres lugares piden una consulta inmediata además del temporizador: el tick
   * cuando el reloj llega a cero, cada acción del usuario, y la confirmación del
   * moderador. Sin el freno de `enVuelo`, cualquiera de esos disparado mientras
   * ya había una consulta en curso deja DOS cadenas corriendo: cada una agenda su
   * propio temporizador al terminar y la segunda pisa la referencia de la
   * primera, que queda armada igual y ya nadie puede cancelar.
   *
   * Se duplica en cada segundo cero, o sea una vez por ronda: 2 cadenas, 4, 8…
   * A la quinta ronda son 32 consultas cada 2 segundos contra un Apps Script que
   * admite 30 ejecuciones simultáneas. El portal se pone lento y empieza a fallar
   * justo cuando más se lo usa, y el motivo no se ve por ningún lado.
   */
  var enVuelo = false;

  function poll() {
    if (!S.sala || enVuelo) return;
    enVuelo = true;
    API.get({ accion: 'estadoSala', token: Sesion.token, salaId: S.sala.id })
      .then(function (r) {
        if (!S.sala) return;
        if (!r || !r.ok) { avisarCaida((r && r.message) || 'No se pudo leer la sala.'); return; }
        avisarRecuperada();
        aplicar(r);
      })
      .catch(function (e) { if (S.sala) avisarCaida(e.message || 'Error de conexión.'); })
      .then(function () {
        enVuelo = false;
        if (!S.sala) return;
        clearTimeout(S.timerPoll);                     // por si quedó alguno vivo
        S.timerPoll = setTimeout(poll, cadencia());
      });
  }

  /**
   * Pedir una consulta YA, sin romper la cadena.
   *
   * Si justo hay una en vuelo, `poll()` no hace nada — y está bien: esa consulta
   * va a agendar la siguiente al terminar. Lo que NO se puede hacer es cancelar
   * el temporizador y quedarse sin nadie que agende el próximo, porque el panel
   * se congela en silencio.
   */
  function pollYa() {
    clearTimeout(S.timerPoll);
    S.timerPoll = null;
    poll();
  }

  /*
   * El aviso de conexión se da UNA vez, no en cada intento.
   *
   * Dentro de una sala se pregunta cada 2-3,5 s: con el backend caído, avisar en
   * cada vuelta llena la pantalla de carteles rojos durante una reunión que suele
   * estar proyectada en la pared. Se avisa al caer, y se avisa al volver — que es
   * el dato que la persona necesita para saber si puede seguir trabajando.
   */
  function avisarCaida(mensaje) {
    if (S.redCaida) return;
    S.redCaida = true;
    UI.toast(mensaje, 'error');
  }

  function avisarRecuperada() {
    if (!S.redCaida) return;
    S.redCaida = false;
    UI.toast('Conexión restablecida.', 'ok');
  }

  function cadencia() {
    var fase = S.estado && S.estado.ronda && S.estado.ronda.fase;
    return (fase === 'countdown' || fase === 'reveal') ? Cfg.POLL_ACTIVO_MS : Cfg.POLL_SALA_MS;
  }

  function aplicar(r) {
    /*
     * 🔴 Si me sacaron la sala, tengo que enterarme por un cartel, no por deducirlo.
     *
     * Al desplazado el panel le cambia solo —el botón "Liberar la sala" se va y
     * aparece la ficha del otro— y sin aviso eso se lee como que el portal se rompió,
     * justo en la persona que estaba conduciendo la reunión.
     *
     * ⚠️ Se compara contra el estado ANTERIOR y se exige que HAYA otro anfitrión: al
     * liberar la sala uno mismo, `anfitrion` queda en null y ahí no hay nada que
     * avisar. Esa distinción es lo que evita el cartel absurdo de "le sacaron la
     * sala" cuando la soltó usted.
     */
    if (S.estado && S.estado.soyAnfitrion && !r.soyAnfitrion && r.anfitrion) {
      UI.toast(r.anfitrion.nombre + ' tomó el control de la sala.', 'info');
    }

    S.estado = r;
    S.sala = r.sala;

    autoTomarSala(r);

    // El título se escribe en CADA respuesta, no solo en la primera. Antes iba
    // atado a un flag de "primera consulta": si esa fallaba —justo lo que pasa con
    // la red floja— el encabezado se quedaba en "Cargando…" para siempre, aunque
    // el resto del panel funcionara bien.
    UI.id('salaTitulo').textContent = r.sala.nombre;
    UI.id('salaManager').textContent = r.sala.manager || '';

    // El video se monta si la sala ya está abierta, o si soy yo el anfitrión que
    // todavía tiene que abrirla (necesito entrar para que Jitsi me dé moderador).
    if (r.sala.abierta || r.soyAnfitrion) {
      pedirEntradaYMontar();
    } else {
      Jitsi.desmontar();
    }

    // Red de seguridad de la apertura de sala: ver el comentario de
    // `confirmarModeradorEnServidor`. Si la confirmación se perdió, esto la
    // reintenta hasta que el servidor diga que la sala está abierta.
    if (S.soyModeradorJitsi && r.soyAnfitrion && !r.sala.abierta) confirmarModeradorEnServidor();

    detectarDestape(r.ronda);
    render();
  }

  /*
   * Pide el permiso de entrada al servidor y monta la videollamada.
   *
   * ⚠️ Se pide UNA sola vez por sala, no en cada sondeo: el permiso se firma con
   * la clave privada de la empresa y pedirlo cada 2 segundos sería hacer trabajar
   * al servidor —y a la firma RSA— para nada. Si la sala ya está montada, `montar`
   * corta solo.
   *
   * Si el permiso no se puede firmar (falta una propiedad en el script, la clave
   * está en un formato que no acepta), el mensaje del servidor se muestra tal cual.
   * Sin eso el síntoma sería una pantalla negra sin explicación.
   */
  var pidiendoEntrada = false;

  function pedirEntradaYMontar() {
    if (Jitsi.montada() || pidiendoEntrada || !S.sala) return;
    pidiendoEntrada = true;
    API.get({ accion: 'videoEntrada', token: Sesion.token, salaId: S.sala.id })
      .then(function (r) {
        if (!S.sala) return;
        if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo abrir la videollamada.', 'error'); return; }
        Jitsi.montar(r, Sesion.usuario);
        render();
      })
      .catch(function (e) { if (S.sala) UI.toast(e.message || 'No se pudo abrir la videollamada.', 'error'); })
      .then(function () { pidiendoEntrada = false; });
  }

  /**
   * Un destape se festeja UNA vez. La clave es ronda + cuántos van, así que el
   * mismo destape leído en cinco polls seguidos no vuelve a sonar, y dos destapes
   * del mismo tipo y la misma persona en una ronda sí se festejan por separado.
   */
  function detectarDestape(ronda) {
    if (!ronda || ronda.fase !== 'reveal' || !ronda.itemActual) {
      if (!ronda || ronda.fase !== 'reveal') cerrarCelebracion();
      return;
    }
    var clave = ronda.rondaId + ':' + ronda.revelados;
    if (clave === S.ultimoDestape) return;
    S.ultimoDestape = clave;
    celebrar(ronda.itemActual);
  }

  /* ── el tick local del reloj ───────────────────────────────────────── */

  function tick() {
    if (!S.estado || !S.estado.ronda) return;
    var ronda = S.estado.ronda;
    if (ronda.fase !== 'countdown') return;

    var seg = Reloj.faltan(ronda.finTs);
    pintarReloj(seg);

    /*
     * Llegó a cero: el servidor ya cambió de fase. Se pregunta enseguida en vez
     * de esperar el próximo sondeo, para que el destape no llegue tarde.
     *
     * ⚠️ UNA sola vez por countdown. El tick corre cada segundo y `seg` se queda
     * en 0 hasta que el servidor conteste la fase nueva: sin recordar que ya se
     * preguntó, se dispara una consulta por segundo mientras tanto — y son los
     * segundos en que TODA la sala está mirando la misma pantalla, o sea el peor
     * momento para multiplicar los pedidos.
     */
    if (seg === 0 && S.ceroPedido !== ronda.finTs) {
      S.ceroPedido = ronda.finTs;
      pollYa();
    }
  }

  function pintarReloj(seg) {
    var num = UI.id('relojNum');
    var barra = UI.id('relojBarra');
    var caja = UI.id('reloj');
    if (!num || !barra || !caja) return;

    num.textContent = seg;
    var total = Cfg.COUNTDOWN_MS / 1000;
    var largo = 2 * Math.PI * 64;
    barra.style.strokeDasharray = largo;
    barra.style.strokeDashoffset = largo * (1 - Math.min(1, seg / total));
    caja.classList.toggle('urgente', seg <= 10 && seg > 5);
    caja.classList.toggle('critico', seg <= 5);
  }

  /* ── render del panel lateral ──────────────────────────────────────── */

  function render() {
    if (!S.estado) return;
    renderEspera();
    renderAnfitrion();
    renderFestejo();
    renderAsistencia();
  }

  /**
   * Repinta un bloque SOLO si su contenido lógico cambió.
   *
   * 🔴 No es una optimización: `render()` corre en cada respuesta del servidor
   * (cada 2 s durante la ronda). Repintando siempre, a quien está escribiendo su
   * contraseña para reclamar la sala se le borra el campo cada dos segundos y no
   * llega a apretar el botón nunca — y el reloj perdería su animación en cada
   * vuelta. La firma lleva solo lo que cambia la ESTRUCTURA; los segundos del
   * countdown los actualiza `pintarReloj` sobre el DOM que ya está puesto.
   *
   * @return {boolean} true si repintó (hay que volver a enganchar los handlers)
   */
  function pintarSi(el, firma, html) {
    if (!el || el.getAttribute('data-firma') === firma) return false;
    el.setAttribute('data-firma', firma);
    el.innerHTML = html;
    return true;
  }

  function renderEspera() {
    var r = S.estado;
    var hayVideo = Jitsi.montada();
    UI.mostrar(UI.id('videoEspera'), !hayVideo);
    if (hayVideo) return;

    var icono = UI.id('esperaIcono'), titulo = UI.id('esperaTitulo'), txt = UI.id('esperaTexto');
    var accion = UI.id('esperaAccion');
    accion.innerHTML = '';

    if (!Jitsi.disponible()) {
      icono.textContent = 'wifi_off';
      titulo.textContent = 'No se pudo cargar el video';
      txt.textContent = 'Jitsi no respondió. Revise la conexión y recargue la página; el resto del portal sigue funcionando.';
      return;
    }
    if (r.anfitrion) {
      icono.textContent = 'hourglass_top';
      titulo.textContent = 'Abriendo la sala…';
      // textContent NO necesita escapado (no interpreta HTML); pasarlo por esc()
      // mostraría "&amp;" literal en un apellido con "&".
      txt.textContent = r.anfitrion.nombre + ' está tomando el control de la reunión.';
    } else {
      icono.textContent = 'lock_clock';
      titulo.textContent = 'Esperando al anfitrión';
      txt.textContent = r.puedoReclamar
        ? 'Puede tomar esta sala usted: use el panel de la derecha.'
        : 'La videollamada se abre cuando un responsable toma la sala.';
    }
  }

  function renderAnfitrion() {
    var r = S.estado;
    var cont = UI.id('anfitrionCuerpo');
    var mod = !!(r.anfitrion && r.anfitrion.moderadorOk);
    var firma = [
      r.soyAnfitrion ? 'yo' : (r.anfitrion ? 'otro' : 'nadie'),
      r.anfitrion ? r.anfitrion.nombre : '',
      r.anfitrion ? !!r.anfitrion.ausente : false,
      mod, r.puedoReclamar, r.puedoDesplazar
    ].join('|');

    if (r.soyAnfitrion) {
      if (!pintarSi(cont, firma,
        '<div class="aviso ' + (mod ? 'aviso-ok' : 'aviso-info') + '" style="margin-bottom:12px">' +
          '<span class="material-symbols-rounded">' + (mod ? 'verified' : 'hourglass_top') + '</span>' +
          '<span>' + (mod
            ? 'Tiene el control de la sala.'
            : 'Entre a la videollamada para terminar de abrir la sala.') + '</span>' +
        '</div>' +
        (mod ? '' :
          '<p style="font-size:12.5px;color:var(--txt-dim);margin-bottom:12px">' +
          'Si tarda en abrir, recargue la página.</p>') +
        '<button class="btn btn-bloque" id="btnLiberar">' +
          '<span class="material-symbols-rounded">logout</span> Liberar la sala</button>' +
        /*
         * Terminar para todos solo aparece con la sala YA ABIERTA: sin reunión
         * montada no hay nada que terminar, y el botón sería una promesa que no se
         * cumple. Va en rojo y SEGUNDO: liberar la sala es lo de todos los días,
         * esto es lo que no tiene vuelta atrás.
         */
        (mod
          ? '<button class="btn btn-peligro btn-bloque" id="btnTerminar" style="margin-top:8px">' +
              '<span class="material-symbols-rounded">call_end</span> Finalizar reunión</button>' +
            '<p style="font-size:12px;color:var(--txt-dim);margin-top:8px">' +
              'Cierra la videollamada para todos los participantes.</p>'
          : ''))) return;
      UI.id('btnLiberar').onclick = liberar;
      if (UI.id('btnTerminar')) UI.id('btnTerminar').onclick = terminarReunion;
      return;
    }

    if (r.anfitrion) {
      var ficha =
        '<div class="anfitrion-cara">' + UI.avatar(r.anfitrion.foto, r.anfitrion.nombre) +
          '<div><strong>' + UI.esc(r.anfitrion.nombre) + '</strong>' +
          '<span>' + UI.esc(r.anfitrion.cargo || '') + '</span></div></div>' +
        '<div class="dato-fila"><span class="k">Desde</span>' +
        '<span class="v">' + UI.hora(r.anfitrion.desde) + '</span></div>' +
        /*
         * Que dejó de responder lo ve TODO EL MUNDO, no solo quien puede rescatar la
         * sala. El asesor es el que más rato se queda mirando una reunión donde no
         * pasa nada: sin este renglón no tiene forma de saber si el anfitrión se cayó
         * o si simplemente todavía no pidió producción, y lo natural es suponer que
         * el portal se rompió.
         */
        (r.anfitrion.ausente
          ? '<div class="dato-fila"><span class="k">Conexión</span>' +
            '<span class="v" style="color:var(--ambar,#f59e0b)">Sin señal</span></div>'
          : '');

      /*
       * El anfitrión dejó de dar señales: se cayó su internet o se fue. El botón NO
       * habla de cargos —acá no se le saca la sala a nadie, no hay nadie— y por eso
       * dice qué pasó: si apareciera un "Tomar la sala" a secas, el que lo aprieta
       * no sabría si está destrabando una reunión o pisando a un compañero.
       *
       * Quién puede lo decide el SERVIDOR (`puedoReclamar`). El frontend no rehace
       * ni la cuenta de los minutos ni la comparación de cargos: serían una segunda
       * copia de reglas que ya viven en un solo lugar.
       */
      if (r.anfitrion.ausente && r.puedoReclamar) {
        if (!pintarSi(cont, firma, ficha +
          '<div class="aviso aviso-info" style="margin:12px 0 10px">' +
            '<span class="material-symbols-rounded">network_check</span>' +
            '<span>' + UI.esc(r.anfitrion.nombre) + ' dejó de responder. ' +
            'Puede tomar la sala para seguir con la reunión.</span></div>' +
          '<button class="btn btn-primario btn-bloque" id="btnReclamar">' +
            '<span class="material-symbols-rounded">shield_person</span> Tomar la sala</button>')) return;
        UI.id('btnReclamar').onclick = reclamar;
        return;
      }

      /*
       * Sala ocupada por otro que SÍ está. Antes acá se terminaba: quien llegaba
       * después no tenía NADA que hacer salvo esperar a que el otro la liberara, o
       * a que venciera el TTL de 2 h.
       */
      if (!r.puedoDesplazar) { pintarSi(cont, firma, ficha); return; }

      if (!pintarSi(cont, firma, ficha +
        '<p style="font-size:12.5px;color:var(--txt-dim);margin:12px 0 10px">' +
          'Su cargo es superior: puede tomarle la sala. ' +
          UI.esc(r.anfitrion.nombre) + ' deja de conducir la reunión, pero ' +
          '<strong>la videollamada no se corta</strong>.</p>' +
        '<div class="campo" style="margin-bottom:10px">' +
          '<input type="password" id="passAnfitrion" placeholder="Su contraseña" autocomplete="current-password">' +
        '</div>' +
        '<button class="btn btn-primario btn-bloque" id="btnDesplazar">' +
          '<span class="material-symbols-rounded">shield_person</span> Tomar la sala</button>')) return;

      UI.id('btnDesplazar').onclick = desplazar;
      UI.id('passAnfitrion').onkeydown = function (e) { if (e.key === 'Enter') desplazar(); };
      return;
    }

    if (!r.puedoReclamar) {
      pintarSi(cont, firma, '<p style="font-size:13px;color:var(--txt-dim)">' +
        'Todavía nadie tomó esta sala. La abre un responsable de Sub Gerencia para arriba.</p>');
      return;
    }

    /*
     * Sala LIBRE: sin contraseña. No se le quita nada a nadie y soltarla es un clic,
     * así que el gesto de apretar el botón ya es la intención — pedir la contraseña
     * encima era el trámite que hacía que abrir la reunión costara dos pantallas.
     *
     * ⚠️ La contraseña sigue viva donde importa: para sacarle la sala a OTRO. Si
     * este panel volviera a pedirla, quedaría pidiendo algo que el servidor ya no
     * exige — y el portal enseñaría una regla que no es la que aplica.
     *
     * Normalmente ni se ve: al entrar, la sala se toma sola. Este botón queda para
     * cuando esa toma automática no salió (un 404 del transporte) o después de
     * haberla liberado a mano.
     */
    if (!pintarSi(cont, firma,
      '<p style="font-size:13px;color:var(--txt-dim);margin-bottom:12px">' +
        'Esta sala está libre. Tómela para abrir la videollamada.</p>' +
      '<button class="btn btn-primario btn-bloque" id="btnReclamar">' +
        '<span class="material-symbols-rounded">shield_person</span> Tomar la sala</button>')) return;

    UI.id('btnReclamar').onclick = reclamar;
  }

  function renderFestejo() {
    var r = S.estado;
    var cont = UI.id('festejoCuerpo');
    var ronda = r.ronda || {};
    var firma = [
      r.sala.abierta, ronda.fase, ronda.rondaId, r.soyAnfitrion,
      S.registreEn === ronda.rondaId
    ].join('|');

    if (!r.sala.abierta) {
      pintarSi(cont, firma, '<p style="font-size:13px;color:var(--txt-dim)">' +
        'El festejo se habilita cuando la sala esté abierta.</p>');
      return;
    }

    if (ronda.fase === 'countdown') { renderCountdown(ronda, cont, firma); return; }

    if (ronda.fase === 'reveal') {
      pintarSi(cont, firma, '<div class="aviso aviso-ok">' +
        '<span class="material-symbols-rounded">celebration</span>' +
        '<span>¡Festejando!</span></div>');
      return;
    }

    // idle / fin
    var cerro = ronda.fase === 'fin';
    var html = '';
    if (cerro) {
      html += '<div class="aviso aviso-ok" style="margin-bottom:12px">' +
        '<span class="material-symbols-rounded">emoji_events</span>' +
        '<span><strong>¡No hay más producción!</strong><br>¡Gran reunión, equipo! 🎉</span></div>';
    }
    if (r.soyAnfitrion) {
      html += '<button class="btn btn-verde btn-grande btn-bloque" id="btnPedir">' +
        '<span class="material-symbols-rounded">campaign</span> ' +
        (cerro ? 'Nueva ronda' : 'Pedir producción') + '</button>';
    } else if (!cerro) {
      html += '<p style="font-size:13px;color:var(--txt-dim)">' +
        'Esperando a que el anfitrión pida producción.</p>';
    }
    if (!pintarSi(cont, firma, html)) return;
    // Se le pasa el BOTÓN, no el evento: pedirProduccion lo deshabilita y le cambia
    // el texto mientras la petición viaja.
    if (UI.id('btnPedir')) UI.id('btnPedir').onclick = function () { pedirProduccion(this); };
  }

  /**
   * 🔴 El countdown se ve EXACTAMENTE IGUAL sea el real o el de teatro, y los
   * botones se muestran en los dos.
   *
   * Si en el de teatro los botones desaparecieran, toda la sala sabría al
   * instante que ya no queda nada por anotar y el suspenso —que es el punto
   * entero del festejo— se cae en el primer segundo.
   *
   * Y no se le miente a nadie: si alguien aprieta durante el teatro, el servidor
   * rechaza y esa persona ve un mensaje claro, en privado. Se entera quien
   * apretó, no la sala. Lo único inaceptable sería aceptarle el clic sin
   * registrar nada: creería que su venta quedó anotada.
   */
  function renderCountdown(ronda, cont, firma) {
    var yaAnote = S.registreEn === ronda.rondaId;

    var html =
      '<div class="countdown">' +
        '<div class="reloj" id="reloj">' +
          '<svg viewBox="0 0 144 144">' +
            '<circle class="pista" cx="72" cy="72" r="64"></circle>' +
            '<circle class="barra" id="relojBarra" cx="72" cy="72" r="64"></circle>' +
          '</svg>' +
          '<div class="num" id="relojNum">–</div>' +
        '</div>' +
        '<p class="countdown-txt">' +
          (yaAnote ? 'Producción anotada.' : '¿Producción para festejar?') +
        '</p>' +
      '</div>';

    html += yaAnote
      ? '<div class="ya-registre"><span class="material-symbols-rounded">check_circle</span>' +
        'Nadie más la ve hasta el destape.</div>'
      : '<div class="botones-produccion">' +
          '<button class="btn-produccion btn-matricula" data-tipo="matricula">' +
            '<span class="material-symbols-rounded">workspace_premium</span> ¡Tengo Matrícula!</button>' +
          '<button class="btn-produccion btn-abono" data-tipo="abono">' +
            '<span class="material-symbols-rounded">savings</span> ¡Tengo Abono!</button>' +
        '</div>';

    if (pintarSi(cont, firma, html)) {
      Array.prototype.forEach.call(cont.querySelectorAll('.btn-produccion'), function (b) {
        b.onclick = function () { anotar(b.getAttribute('data-tipo'), b); };
      });
    }
    pintarReloj(Reloj.faltan(ronda.finTs));
  }

  function renderAsistencia() {
    var cont = UI.id('asistenciaCuerpo');
    // `latirAsistencia` llama acá desde su respuesta: si mientras tanto se salió
    // de la sala, `S.estado` ya es null. El `.catch` de esa promesa se tragaba el
    // TypeError sin decir nada, que es peor que el error mismo.
    if (!S.estado || !S.estado.sala) return;
    if (!S.estado.sala.abierta) {
      cont.innerHTML = '<p style="font-size:13px;color:var(--txt-dim)">Se registra durante la reunión.</p>';
      return;
    }
    if (S.asisValidada) {
      cont.innerHTML = '<div class="aviso aviso-ok">' +
        '<span class="material-symbols-rounded">verified</span>' +
        '<span>Asistencia registrada.</span></div>';
      return;
    }
    /*
     * Los minutos los dice el SERVIDOR (`estado.asistencia.minutos`): la reunión de
     * la tarde pide menos que la de la mañana, y el navegador no puede deducir el
     * turno por su cuenta sin volverse una segunda copia de la regla del corte.
     * Mientras no haya llegado el estado se dice "unos minutos" en vez de arriesgar
     * un número que después cambie en pantalla.
     */
    var mins = S.estado.asistencia && S.estado.asistencia.minutos;
    var cuanto = mins ? (mins === 1 ? 'un minuto' : mins + ' minutos') : 'unos minutos';

    var faltan = S.asisFaltan;   // minutos, ya calculados por el servidor

    if (S.camaraOn) {
      cont.innerHTML = '<div class="aviso aviso-info">' +
        '<span class="material-symbols-rounded">videocam</span>' +
        '<span>Cámara encendida. ' +
        (faltan != null
          ? (faltan <= 1 ? 'Falta menos de un minuto.' : 'Faltan ' + faltan + ' min.')
          : 'Contando…') +
        '</span></div>';
      return;
    }

    /*
     * 🔴 Con la cámara apagada A MITAD de la cuenta NO se dice "manténgala N
     * minutos": el servidor conserva lo que ya lleva, así que ese texto le pediría
     * empezar de nuevo algo que no se perdió — y quien crea que perdió el progreso
     * es probable que ni lo intente.
     */
    if (faltan != null && faltan > 0 && faltan < mins) {
      cont.innerHTML = '<div class="aviso aviso-info">' +
        '<span class="material-symbols-rounded">hourglass_top</span>' +
        '<span>Se pausó: lo que lleva no se pierde. Vuelva a encender la cámara — ' +
        (faltan <= 1 ? 'falta menos de un minuto' : 'faltan ' + faltan + ' min') +
        '.</span></div>';
      return;
    }

    cont.innerHTML = '<p style="font-size:13px;color:var(--txt-dim)">' +
      'Encienda la cámara y manténgala ' + cuanto +
      ' para que quede registrada su asistencia.</p>';
  }

  /* ── acciones ──────────────────────────────────────────────────────── */

  // Devuelve SIEMPRE una promesa, incluso al cortar por reentrada: los llamadores
  // encadenan un .then para volver a habilitar su botón, y devolver undefined lo
  // dejaría deshabilitado para siempre por un doble clic.
  function accion(payload, alOk) {
    if (S.enviando) return Promise.resolve();
    S.enviando = true;
    return API.post(payload)
      .then(function (r) {
        if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo completar.', 'error'); return; }
        if (alOk) alOk(r);
        pollYa();
      })
      .catch(function (e) { UI.toast(e.message || 'Error de conexión.', 'error'); })
      .then(function () { S.enviando = false; });
  }

  /* Tomar una sala LIBRE. Sin contraseña: ver el comentario de `renderAnfitrion`. */
  function reclamar() {
    // Cuenta como decisión: si sale mal, no se reintenta sola en el próximo sondeo.
    S.autoTomaResuelta = true;
    accion({ accion: 'reclamarAnfitrion', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Tomó la sala.', 'ok'); });
  }

  /*
   * Sacarle la sala a otro. Pide confirmación aparte de la contraseña: la contraseña
   * responde "¿es usted?" y esto responde "¿seguro que quiere sacársela a él?", que
   * son dos preguntas distintas. Es una acción sobre el trabajo de otra persona,
   * delante de toda la filial.
   */
  function desplazar() {
    var input = UI.id('passAnfitrion');
    var pass = input ? input.value : '';
    if (!pass) { UI.toast('Escriba su contraseña.', 'error'); return; }

    var quien = (S.estado && S.estado.anfitrion) ? S.estado.anfitrion.nombre : 'el anfitrión actual';
    if (!window.confirm('La sala la está conduciendo ' + quien + '.\n\n' +
                        '¿Tomarla usted? ' + quien + ' deja de poder pedir producción.')) return;

    accion({ accion: 'reclamarAnfitrion', token: Sesion.token, salaId: S.sala.id,
             password: pass, desplazar: true },
      function (r) { UI.toast('Tomó la sala' + (r.desplazado ? ' (era de ' + r.desplazado + ')' : '') + '.', 'ok'); });
  }

  /*
   * Entrar a una sala LIBRE siendo quien puede abrirla la toma sola.
   *
   * Abrir la reunión costaba dos pantallas: entrar a la sala y después escribir la
   * contraseña en el panel de la derecha. Con toda la filial esperando el video,
   * esa segunda pantalla es puro trámite: la sala está vacía, no se le quita nada a
   * nadie y soltarla es un clic.
   *
   * 🔴 UNA sola vez por visita a la sala, y LIBERAR también cuenta como decidido.
   *
   * Esto no es prolijidad: sin la marca, soltar la sala estando adentro la volvía a
   * tomar en el sondeo siguiente —dos segundos después— y no había manera de
   * liberarla sin salirse de la reunión. Lo encontró el test, no el razonamiento.
   *
   * El mismo freno evita que un rechazo del servidor se convierta en un POST cada
   * 2 s durante toda la reunión, y encima sobre una acción que ESCRIBE.
   *
   * ⚠️ Y solo con la sala VACÍA. Si ya la tiene otro, el camino es el de desplazar
   * —con contraseña y confirmación—, nunca este.
   */
  function autoTomarSala(r) {
    if (S.autoTomaResuelta) return;
    if (!r.puedoReclamar || r.anfitrion || r.soyAnfitrion) return;
    S.autoTomaResuelta = true;

    accion({ accion: 'reclamarAnfitrion', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Abriendo la sala…', 'info'); });
  }

  /*
   * Terminar la reunión para todos. No tiene vuelta atrás y se ejecuta sobre gente
   * que está trabajando, así que pide confirmación con el número de participantes
   * adelante — "¿terminar la reunión?" a secas no dice a cuántos afecta.
   */
  function terminarReunion() {
    var n = Jitsi.cuantos();
    if (!window.confirm('Se va a cerrar la videollamada' +
        (n > 1 ? ' para las ' + n + ' personas que están adentro' : '') + '.\n\n' +
        'Esto no se puede deshacer. ¿Terminar la reunión?')) return;

    /*
     * 🔴 Se libera la sala PASE LO QUE PASE con el comando.
     *
     * Jitsi ignora en silencio una orden que no conoce, así que "terminó" no se
     * puede dar por cierto. Liberando igual, el portal queda coherente en los dos
     * casos: la sala vuelve a estar disponible y nadie queda conduciendo una
     * reunión que ya no existe. Si el comando SÍ funcionó, a cada uno le llega el
     * aviso de Jitsi y el portal lo devuelve al listado (ver `readyToClose`).
     */
    Jitsi.terminarParaTodos();
    S.autoTomaResuelta = true;
    accion({ accion: 'liberarAnfitrion', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Reunión terminada.', 'ok'); });
  }

  function liberar() {
    // Soltar la sala es una decisión: no se la vuelve a tomar sola en el próximo
    // sondeo. Se marca ANTES de mandar, o el sondeo que corre en paralelo llega
    // primero a `autoTomarSala` con la sala ya libre.
    S.autoTomaResuelta = true;
    accion({ accion: 'liberarAnfitrion', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Sala liberada.', 'ok'); });
  }

  /*
   * Pedir producción tarda: el clic viaja a Apps Script y hasta que vuelve no pasa
   * NADA en pantalla. El anfitrión, con toda la filial mirándolo, no sabe si su clic
   * entró — y vuelve a apretar.
   *
   * 🔴 Que se deshabilite al instante no es solo cortesía: `iniciarRonda` ESCRIBE, y
   * los POST que escriben no se reintentan solos justamente porque repetirlos
   * duplica (ver POST_REPETIBLE). El doble clic ya lo frenaba `S.enviando`, pero en
   * silencio: el segundo clic no hacía nada y tampoco se veía que el primero seguía
   * en camino.
   */
  function pedirProduccion(boton) {
    S.ultimoDestape = null;
    var etiqueta = boton ? boton.innerHTML : '';
    var salioBien = false;

    if (boton) {
      boton.disabled = true;
      boton.innerHTML = '<span class="material-symbols-rounded girando">sync</span> Sincronizando sala…';
    }

    var restaurar = function () {
      if (!boton || !boton.isConnected) return;
      boton.disabled = false;
      boton.innerHTML = etiqueta;
    };

    /*
     * Si salió bien NO se restaura: la ronda arranca y el repintado reemplaza este
     * botón por el countdown. Restaurarlo acá haría parpadear "Pedir producción"
     * entre medio, que es justo la duda que veníamos a sacar.
     *
     * ⚠️ Pero el repintado solo ocurre si el estado CAMBIA (`pintarSi` compara una
     * firma). Un "ok" del servidor sin ronda a la vista dejaría el botón trabado
     * para siempre, y sin manera de pedir producción en toda la reunión. Por eso el
     * plazo: si a los 10 s el botón sigue diciendo "Sincronizando", vuelve solo.
     */
    accion({ accion: 'iniciarRonda', token: Sesion.token, salaId: S.sala.id },
      function () { salioBien = true; })
      .then(function () {
        if (!salioBien) { restaurar(); return; }
        setTimeout(restaurar, 10000);
      });
  }

  function anotar(tipo, boton) {
    if (boton) boton.disabled = true;
    var rondaId = S.estado && S.estado.ronda ? S.estado.ronda.rondaId : null;
    accion({ accion: 'registrarProduccion', token: Sesion.token, salaId: S.sala.id, tipo: tipo },
      function () {
        S.registreEn = rondaId;
        UI.toast('Anotada. Se destapa cuando termine el conteo.', 'ok');
      }
    ).then(function () { if (boton) boton.disabled = false; });
  }

  /* ── Jitsi ─────────────────────────────────────────────────────────── */

  function alEntrarAJitsi() { render(); }

  function alCambiarRol(esModerador) {
    if (!S.estado || !S.estado.soyAnfitrion) return;
    if (!esModerador) return;
    S.modAvisado = true;
    S.soyModeradorJitsi = true;
    confirmarModeradorEnServidor();
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 🔴 Si esta confirmación se pierde, LA SALA NO SE ABRE PARA NADIE.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * `abierta` es exactamente `moderadorOk` del anfitrión (ver `estadoSala_`), y
   * eso solo lo pone esta llamada. Jitsi dispara `participantRoleChanged` UNA vez,
   * así que si el POST se perdía no había nada que lo volviera a intentar: toda la
   * filial se quedaba en "esperando al moderador" y el anfitrión no veía ningún
   * error — el `.catch` estaba VACÍO. Con el 404 del transporte de Apps Script
   * pasando justo en el momento de entrar a la videollamada, esto no era teórico.
   *
   * Ahora se cura solo: mientras Jitsi me dé moderador, yo sea el anfitrión y el
   * servidor siga diciendo que la sala está cerrada, cada sondeo lo reintenta.
   * Repetirlo es inofensivo (pone un booleano en su valor final).
   *
   * Los tres frenos son distintos a propósito:
   *   · confirmado → listo, no se toca más.
   *   · rechazado  → el servidor dijo que no (no soy el anfitrión). Reintentarlo
   *                  cada 2 s no lo va a convencer, y llenaría la pantalla.
   *   · enviando   → una sola en vuelo, como el sondeo.
   *
   * El fallo de TRANSPORTE no avisa acá: el sondeo que corre en paralelo ya pinta
   * "Error de conexión" una vez, y el próximo intento sale solo en 2-3,5 s. Avisar
   * también acá sería el segundo cartel rojo por el mismo problema.
   */
  function confirmarModeradorEnServidor() {
    if (!S.sala || S.modEnviando || S.modConfirmado || S.modRechazado) return;
    S.modEnviando = true;
    API.post({ accion: 'confirmarModerador', token: Sesion.token, salaId: S.sala.id, esModerador: true })
      .then(function (r) {
        if (!S.sala) return;
        if (r && r.ok) {
          S.modConfirmado = true;
          UI.toast('Sala abierta para todos.', 'ok');
          pollYa();
          return;
        }
        S.modRechazado = true;
        UI.toast((r && r.message) || 'El servidor no aceptó abrir la sala.', 'error');
      })
      .catch(function () { /* transporte: lo reintenta el próximo sondeo */ })
      .then(function () { S.modEnviando = false; });
  }

  function avisarModeradorDemorado() {
    if (S.modAvisado || !S.estado || !S.estado.soyAnfitrion) return;
    if (S.estado.anfitrion && S.estado.anfitrion.moderadorOk) return;
    S.modAvisado = true;
    UI.toast('La videollamada no terminó de abrir. Pruebe recargando la página.', 'error');
  }

  function alCambiarCamara(encendida) {
    S.camaraOn = !!encendida;
    clearInterval(S.timerAsis);
    S.timerAsis = null;
    if (S.camaraOn && !S.asisValidada) {
      latirAsistencia();
      S.timerAsis = setInterval(latirAsistencia, Cfg.ASIS_PING_MS);
    }
    render();
  }

  /*
   * ⚠️ Un latido por vez. El de la cámara al encenderse y el del intervalo pueden
   * salir juntos, y el servidor —que no toma candado para esto— contaría los dos:
   * la asistencia se validaría un minuto antes, o quedaría la fila duplicada en la
   * planilla. No es grave, pero una persona listada dos veces en el control de
   * asistencia es justo el tipo de cosa que después hay que explicar.
   */
  var latiendo = false;

  function latirAsistencia() {
    if (!S.sala || latiendo) return;
    latiendo = true;
    API.post({ accion: 'pingAsistencia', token: Sesion.token, salaId: S.sala.id, camaraActiva: S.camaraOn })
      .then(function (r) {
        if (!r || !r.ok) return;
        S.asisFaltan = (r.faltanMin != null) ? r.faltanMin : r.faltan;
        if (r.validado) {
          S.asisValidada = true;
          clearInterval(S.timerAsis); S.timerAsis = null;
          UI.toast('Asistencia registrada.', 'ok');
        }
        renderAsistencia();
      })
      .catch(function () {})
      .then(function () { latiendo = false; });
  }

  /* ── celebración ───────────────────────────────────────────────────── */

  function celebrar(item) {
    var esMat = item.tipo === 'matricula';
    var ov = UI.id('celebracion');
    UI.id('celFoto').innerHTML = UI.avatar(item.foto, item.ejecutivo, 'avatar-cel') +
      '<span class="cel-insignia">' + (esMat ? '🏆' : '💰') + '</span>';
    UI.id('celTipo').textContent = esMat ? 'MATRÍCULA' : 'ABONO';
    UI.id('celNombre').textContent = item.ejecutivo || '';
    UI.id('celCargo').textContent = item.cargo || '';
    UI.id('celCaja').style.setProperty('--acento-cel', esMat ? 'var(--ambar)' : 'var(--verde)');
    UI.mostrar(ov, true);
    Audio_.tocar(item.tipo);
    Confeti.tirar(item.tipo);
    S.ultimoItem = item;
  }

  function cerrarCelebracion() { UI.mostrar(UI.id('celebracion'), false); }

  function repetirSirena() { if (S.ultimoItem) { Audio_.tocar(S.ultimoItem.tipo); Confeti.tirar(S.ultimoItem.tipo); } }

  return {
    entrar: entrar, salir: salir,
    activa: function () { return !!S.sala; },
    alEntrarAJitsi: alEntrarAJitsi,
    alColgar: alColgar,
    alCambiarRol: alCambiarRol,
    alCambiarCamara: alCambiarCamara,
    avisarModeradorDemorado: avisarModeradorDemorado,
    cerrarCelebracion: cerrarCelebracion,
    repetirSirena: repetirSirena
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Pantalla completa — la del PORTAL, no la de Jitsi
   ══════════════════════════════════════════════════════════════════════════ */
/*
 * 🔴 Por qué existe: la pantalla completa de Jitsi maximiza SOLO su iframe.
 *
 * Todo lo que el portal dibuja —los botones de producción, la cuenta regresiva, el
 * festejo— vive FUERA de ese iframe, así que al maximizar desaparecía justo en el
 * momento en que más se mira la pantalla. Por eso se esconde la de Jitsi (ver
 * `toolbarButtons`) y se agranda el contenedor entero.
 */
var Pantalla = (function () {
  var DESTINO = '.sala-layout';
  var guardados = [];

  function elemento() { return document.querySelector(DESTINO); }
  function activa() { return !!document.fullscreenElement; }

  /*
   * 🔴 Los avisos y el festejo viven FUERA de la sala en el árbol de la página, y en
   * pantalla completa el navegador dibuja SOLO lo que está adentro del elemento
   * maximizado. Sin mudarlos, al entrar en pantalla completa desaparecen los dos —
   * o sea que se perdería el festejo, que es exactamente lo que este cambio viene a
   * salvar, y encima sin ningún error.
   *
   * Se mudan al entrar y se devuelven al salir. Se guarda de dónde salió cada uno
   * en vez de suponer que era `body`: suponerlo funciona hasta que alguien los
   * mueva, y ahí falla en silencio.
   */
  function mudar(hacia) {
    // Idempotente: `fullscreenchange` puede llegar más de una vez estando ya
    // maximizado, y mudar dos veces dejaría `guardados` con entradas repetidas.
    if (guardados.length) return;
    ['toasts', 'celebracion'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      guardados.push({ el: el, padre: el.parentNode });
      try { hacia.appendChild(el); } catch (e) {}
    });
  }

  function devolver() {
    guardados.forEach(function (g) {
      try { g.padre.appendChild(g.el); } catch (e) {}
    });
    guardados = [];
  }

  /*
   * 🔴 iPhone NO deja poner en pantalla completa un elemento cualquiera: Safari en
   * iOS solo la da para un <video>. El botón ahí no puede funcionar nunca.
   *
   * Se esconde por CAPACIDAD (`document.fullscreenEnabled`), no adivinando el
   * teléfono por su user-agent: la lista de excepciones envejece y hoy falla al
   * revés en las tablets. Un botón que no hace nada es peor que no tenerlo: la
   * persona lo aprieta en medio de la reunión y cree que el portal se colgó.
   */
  function ajustarDisponibilidad() {
    var b = UI.id('btnPantalla');
    if (!b) return;
    var puede = (typeof document.fullscreenEnabled === 'undefined') || document.fullscreenEnabled;
    b.style.display = puede ? '' : 'none';
  }

  function alternar() {
    var el = elemento();
    if (!el) return;
    if (activa()) {
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    var pedir = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!pedir) { UI.toast('Su navegador no permite pantalla completa acá.', 'info'); return; }
    // Puede rechazarse (permisos, un gesto que el navegador no considera válido):
    // se avisa en vez de dejar un botón que no hace nada.
    Promise.resolve(pedir.call(el)).catch(function () {
      UI.toast('El navegador no dejó abrir la pantalla completa.', 'error');
    });
  }

  function alternarPanel() {
    var el = elemento();
    if (!el) return;
    // El icono lo alterna el CSS a partir de esta clase: ver `.ico-full`.
    var oculto = el.classList.toggle('panel-oculto');
    var b = UI.id('btnPanel');
    if (b) {
      var txt = oculto ? 'Mostrar el panel' : 'Esconder el panel';
      b.title = txt;
      b.setAttribute('aria-label', txt);
    }
  }

  function alCambiar() {
    var el = elemento();
    // El icono lo alterna el CSS con `:fullscreen`: no hay estado que sincronizar.
    if (activa() && el) mudar(el);
    else {
      devolver();
      // Al salir, el panel vuelve a ser una columna del layout: dejarlo escondido
      // dejaría un hueco al costado y ningún botón a la vista para recuperarlo
      // (el de esconderlo solo se ve en pantalla completa).
      if (el) el.classList.remove('panel-oculto');
    }
  }

  /*
   * 🔴 Salir de la sala DEBE apagar la pantalla completa, y no es cosmético.
   *
   * El elemento maximizado es la vista de la sala. Al salir, esa vista se esconde
   * pero la pantalla completa sigue puesta: queda el navegador maximizado mostrando
   * NADA, y sin más salida que Escape. Peor todavía, los avisos y el festejo están
   * mudados adentro de esa vista escondida, así que el portal se queda SIN AVISOS
   * en todas las pantallas — un portal a medio funcionar, sin un solo error.
   *
   * Se comprobó con una sonda: salir con "Salas" dejaba las tres cosas rotas a la vez.
   */
  function apagar() {
    if (activa() && document.exitFullscreen) {
      try { document.exitFullscreen(); } catch (e) {}
    }
  }

  return {
    alternar: alternar, alternarPanel: alternarPanel,
    alCambiar: alCambiar, activa: activa, apagar: apagar,
    ajustarDisponibilidad: ajustarDisponibilidad
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Dashboard
   ══════════════════════════════════════════════════════════════════════════ */
var Dashboard = (function () {
  var timer = null;

  /*
   * Las salas que ya vinieron en la respuesta de arranque (`login` o `yo`).
   *
   * 🔴 Lleva marca de tiempo y se usa UNA sola vez. El dato es efímero —el estado
   * de una sala cambia solo, con quien la toma o la libera—, así que pintar una
   * precarga vieja mostraría salas "sin abrir" que ya están en vivo, sin ningún
   * error y justo en la pantalla que se mira para decidir a cuál entrar.
   */
  var precarga = null;

  function precargar(salas) {
    precarga = salas ? { salas: salas, ts: Date.now() } : null;
  }

  var ESTADO = {
    live:    { chip: 'chip-verde', txt: 'En vivo' },
    pending: { chip: 'chip-ambar', txt: 'Pendiente' },
    offline: { chip: 'chip', txt: 'Sin abrir' }
  };

  function cargar() {
    API.get({ accion: 'salas', token: Sesion.token })
      .then(function (r) {
        if (!r || !r.ok) return;
        pintar(r.salas);
      })
      .catch(function (e) { UI.toast(e.message || 'No se pudieron leer las salas.', 'error'); });
  }

  /*
   * Las portadas viven en el repo (img/), no en la nube de quien las generó.
   *
   * El prototipo apuntaba a URLs de AI Studio (lh3.googleusercontent.com/aida-public/…),
   * que es alojamiento temporal: responden hoy y pueden desaparecer sin aviso. Una
   * tarjeta rota en la pantalla de entrada, en plena reunión, por un servidor que no
   * es nuestro. Están descargadas y versionadas al lado del resto.
   *
   * El mapa es del FRONTEND a propósito: la portada es identidad visual, no un dato
   * del negocio, y no tiene por qué viajar en cada respuesta del servidor.
   */
  var PORTADA = { sirari: 'img/sirari.svg', leones: 'img/leones.svg', jaguares: 'img/jaguares.svg' };

  function pintar(salas) {
    var cont = UI.id('grillaSalas');
    cont.innerHTML = salas.map(function (s) {
      var e = ESTADO[s.estado] || ESTADO.offline;
      var img = PORTADA[s.id];
      return '' +
        '<button class="sala-card" data-sala="' + UI.esc(s.id) + '" style="--acento:' + UI.esc(s.color) + '">' +
          '<div class="sala-portada">' +
            (img ? '<img src="' + UI.esc(img) + '" alt="" loading="lazy">' : '') +
            '<span class="chip ' + e.chip + ' sala-estado">' +
              (s.estado === 'live' ? '<span class="latido"></span>' : '') + e.txt +
            '</span>' +
          '</div>' +
          '<div class="sala-cuerpo">' +
            '<span class="sala-badge">' + UI.esc(s.badge) + '</span>' +
            '<h3>' + UI.esc(s.nombre) + '</h3>' +
            '<div class="manager">' +
              '<span class="material-symbols-rounded">manage_accounts</span>' +
              UI.esc(s.manager) +
            '</div>' +
            '<div class="pie">' +
              '<span>' + (s.anfitrion
                ? '<span class="material-symbols-rounded" style="font-size:15px">shield_person</span> ' + UI.esc(s.anfitrion.nombre)
                : 'Sin anfitrión') + '</span>' +
              '<span class="sala-entrar">Entrar a la sala' +
                '<span class="material-symbols-rounded">arrow_forward</span></span>' +
            '</div>' +
          '</div>' +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(cont.querySelectorAll('.sala-card'), function (c) {
      c.onclick = function () { App.irASala(c.getAttribute('data-sala')); };
    });

    /*
     * Si una portada no carga: primero se prueba el PNG, y si tampoco, se saca.
     *
     * Los emblemas van en SVG —vector, la mitad de peso y filoso proyectado en la
     * pared—, y el PNG queda al lado como red. Que un navegador raro del equipo no
     * dibuje un SVG es improbable, pero el costo de cubrirlo son dos líneas y el
     * costo de NO cubrirlo es una tarjeta sin escudo proyectada en la reunión.
     * Sacarla del todo es mejor que dejar el ícono de imagen rota: la tarjeta se
     * ve bien igual con su fondo y nadie nota que faltaba algo.
     */
    Array.prototype.forEach.call(cont.querySelectorAll('.sala-portada img'), function (im) {
      im.onerror = function () {
        if (im.getAttribute('data-respaldo')) { im.remove(); return; }
        im.setAttribute('data-respaldo', '1');
        // Sin expresión regular a propósito: sabemos que la ruta termina en '.svg',
        // y una regex acá ya se escribió mal dos veces al pasar el parche por el
        // shell (quedó /.svg$/, con el punto sin escapar). Cortar los 4 caracteres
        // finales no tiene forma de salir mal.
        im.src = im.src.slice(0, -4) + '.png';
      };
    });
  }

  return {
    activar: function () {
      /*
       * Si el arranque ya trajo las salas, se pintan en el acto y se ahorra el
       * segundo viaje a Apps Script. El plazo es el mismo del sondeo: más viejo que
       * eso ya lo habríamos refrescado, así que no vale pintarlo.
       */
      /*
       * ⚠️ Se exige que la precarga traiga el ESTADO de cada sala, no solo su nombre.
       *
       * El backend viejo devolvía en el login la lista pelada, sin estado ni
       * anfitrión. Si el frontend se publica antes que el backend —y son dos
       * despliegues distintos, así que va a pasar— pintar esa lista mostraría TODAS
       * las filiales como "Sin abrir", incluida la que está en vivo, justo en la
       * pantalla que se mira para decidir a cuál entrar. Se corrige sola al primer
       * sondeo, pero esos segundos son los del arranque de la reunión.
       *
       * Con este control, el orden de despliegue deja de importar: si la precarga no
       * sirve, se pide la lista como antes.
       */
      var completa = precarga && precarga.salas &&
        precarga.salas.length && precarga.salas.every(function (s) { return !!s.estado; });
      var fresca = completa && (Date.now() - precarga.ts) < 12000;
      if (fresca) pintar(precarga.salas); else cargar();
      precarga = null;
      timer = setInterval(cargar, 12000);
    },
    precargar: precargar,
    desactivar: function () { clearInterval(timer); timer = null; }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Asistencia
   ══════════════════════════════════════════════════════════════════════════ */
var Asistencia = (function () {
  function cargar() {
    var cont = UI.id('asistenciaTabla');
    cont.innerHTML = '<div class="vacio"><span class="material-symbols-rounded">hourglass_top</span>Cargando…</div>';
    API.get({ accion: 'asistencia', token: Sesion.token, limite: 300 })
      .then(function (r) {
        if (!r || !r.ok) { cont.innerHTML = '<div class="vacio">No se pudo cargar.</div>'; return; }
        pintar(r.logs);
      })
      .catch(function (e) {
        cont.innerHTML = '<div class="vacio"><span class="material-symbols-rounded">error</span>' +
          UI.esc(e.message || 'Error de conexión.') + '</div>';
      });
  }

  function pintar(logs) {
    var cont = UI.id('asistenciaTabla');
    if (!logs || !logs.length) {
      cont.innerHTML = '<div class="vacio"><span class="material-symbols-rounded">event_busy</span>' +
        'Todavía no hay asistencias registradas.</div>';
      return;
    }
    cont.innerHTML =
      '<div class="tabla-scroll"><table><thead><tr>' +
        '<th>Fecha</th><th>Turno</th><th>Nombre</th><th>Cargo</th><th>Sala</th><th>Hora</th><th>Estado</th>' +
      '</tr></thead><tbody>' +
      logs.map(function (l) {
        return '<tr>' +
          '<td>' + UI.esc(l.fecha) + '</td>' +
          '<td><span class="chip">' + UI.esc(l.turno || '—') + '</span></td>' +
          '<td style="font-weight:600">' + UI.esc(l.nombre) + '</td>' +
          '<td style="color:var(--txt-dim);font-size:12.5px">' + UI.esc(l.cargo) + '</td>' +
          '<td style="color:var(--txt-dim)">' + UI.esc(l.sala) + '</td>' +
          '<td>' + UI.hora(l.timestamp) + '</td>' +
          '<td><span class="chip ' + (l.validado ? 'chip-verde' : 'chip-ambar') + '">' +
            (l.validado ? 'Validado' : 'Parcial') + '</span></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  return { cargar: cargar };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Config
   ══════════════════════════════════════════════════════════════════════════ */
var Config = (function () {
  function activar() { UI.id('apiUrl').value = Cfg.url(); }

  function guardar() {
    var v = UI.id('apiUrl').value.trim();
    // /dev también se acepta: es la URL de "Probar implementaciones", la que se
    // usa mientras se ajusta el backend antes de publicar la definitiva.
    if (v && !/^https:\/\/script\.google\.com\/.*\/(exec|dev)$/.test(v)) {
      UI.toast('La dirección debería empezar con https://script.google.com/ y terminar en /exec.', 'error');
      return;
    }
    Cfg.guardarUrl(v);
    UI.toast('Dirección guardada.', 'ok');
    UI.mostrar(UI.id('loginSinApi'), !Cfg.url());
  }

  function probar() {
    var caja = UI.id('apiResultado');
    caja.innerHTML = '<div class="aviso aviso-info"><span class="material-symbols-rounded">sync</span>' +
      '<span>Probando…</span></div>';
    API.get({ accion: 'ping' })
      .then(function (r) {
        caja.innerHTML = (r && r.ok)
          ? '<div class="aviso aviso-ok"><span class="material-symbols-rounded">check_circle</span>' +
            '<span>El backend responde correctamente.</span></div>'
          : '<div class="aviso aviso-error"><span class="material-symbols-rounded">error</span>' +
            '<span>Respondió, pero con un error.</span></div>';
      })
      .catch(function (e) {
        caja.innerHTML = '<div class="aviso aviso-error"><span class="material-symbols-rounded">error</span>' +
          '<span>' + UI.esc(e.message) + '</span></div>';
      });
  }

  return { activar: activar, guardar: guardar, probar: probar };
})();


/* ══════════════════════════════════════════════════════════════════════════
   App — router y arranque
   ══════════════════════════════════════════════════════════════════════════ */
var App = (function () {
  var vista = 'dashboard';

  function irA(nombre) {
    // La pestaña "Reunión" no tiene sentido sin una sala elegida: sin este guard
    // muestra el cascarón de la última sala (o vacío) y no sondea a nadie, lo que
    // se ve como un portal roto en vez de como un paso que falta.
    if (nombre === 'sala' && !Sala.activa()) {
      UI.toast('Elija primero una sala.', 'info');
      nombre = 'dashboard';
    }

    if (vista === 'dashboard') Dashboard.desactivar();
    if (vista === 'sala' && nombre !== 'sala') Sala.salir();

    vista = nombre;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('activo', t.getAttribute('data-vista') === nombre);
    });
    ['dashboard', 'sala', 'asistencia', 'config'].forEach(function (v) {
      UI.mostrar(UI.id('vista-' + v), v === nombre);
    });

    if (nombre === 'dashboard') Dashboard.activar();
    if (nombre === 'asistencia') Asistencia.cargar();
    if (nombre === 'config') Config.activar();
  }

  /*
   * ⚠️ El ORDEN importa: primero se toma la sala, después se navega.
   *
   * Al revés —que era como estaba— el guard de `irA` se mira `Sala.activa()`
   * cuando todavía no hay ninguna sala tomada, rebota al listado, y entrar a una
   * sala deja de funcionar por completo. La pantalla se queda en el dashboard sin
   * ningún error: parece que el clic no hizo nada.
   */
  function irASala(salaId) {
    Sala.entrar(salaId);
    irA('sala');
  }

  function mostrarLogin(mensaje) {
    Sala.salir();
    Dashboard.desactivar();
    UI.mostrar(UI.id('app'), false);
    UI.mostrar(UI.id('login'), true);
    if (mensaje) avisoLogin(mensaje);
    UI.mostrar(UI.id('loginSinApi'), !Cfg.url());
  }

  function avisoLogin(msg) {
    UI.id('loginAvisoTxt').textContent = msg;
    UI.mostrar(UI.id('loginAviso'), !!msg);
  }

  function entrarApp(usuario, salas) {
    // Antes de pintar nada: `irA('dashboard')` activa el Dashboard, y si las salas
    // llegan después ya disparó su propio pedido y el ahorro se pierde.
    Dashboard.precargar(salas);
    Sesion.usuario = usuario;
    UI.id('uFoto').innerHTML = UI.avatar(usuario.fotoUrl, usuario.nombre);
    UI.id('uNombre').textContent = usuario.nombre;
    UI.id('uCargo').textContent = usuario.cargo || '—';
    UI.mostrar(UI.id('login'), false);
    UI.mostrar(UI.id('app'), true);
    irA('dashboard');
  }

  function login(e) {
    if (e) e.preventDefault();
    Audio_.desbloquear();   // 🔴 acá y no en el primer festejo: ver el comentario en Audio_

    var email = UI.id('loginEmail').value.trim();
    var pass = UI.id('loginPass').value;
    var recordar = UI.id('loginRecordar').checked;
    var btn = UI.id('loginBtn');
    avisoLogin('');

    if (!Cfg.url()) { avisoLogin('Falta configurar la dirección del backend.'); return; }

    btn.disabled = true;
    API.post({ accion: 'login', email: email, password: pass, recordar: recordar })
      .then(function (r) {
        if (!r || !r.ok) { avisoLogin((r && r.message) || 'No se pudo ingresar.'); return; }
        Sesion.guardar(r.token, r.usuario, recordar);
        UI.id('loginPass').value = '';
        entrarApp(r.usuario, r.salas);
      })
      .catch(function (err) { avisoLogin(err.message || 'Error de conexión.'); })
      .then(function () { btn.disabled = false; });
  }

  function salir() {
    // El token es firmado y sin almacén, así que no hay nada que revocar del lado
    // del servidor: vence solo a las 12 h. Se borra de la pestaña y listo.
    Sesion.limpiar();
    mostrarLogin('');
  }

  /** Sesión guardada en la pestaña: se reanuda sin volver a pedir contraseña. */
  function reanudar() {
    if (!Sesion.recuperar() || !Cfg.url()) { mostrarLogin(''); return; }
    API.get({ accion: 'yo', token: Sesion.token })
      .then(function (r) {
        if (r && r.ok) entrarApp(r.usuario, r.salas);
        else mostrarLogin('');
      })
      /*
       * 🔴 Un fallo de RED acá NO es una sesión vencida, y decirlo importa.
       *
       * Esto es la PRIMERA llamada después de cargar la página — justo donde más
       * pega el 404 del transporte de Apps Script (ver el comentario largo en API).
       * Mientras el catch mandaba a `mostrarLogin('')` a secas, un 404 tiraba la
       * sesión guardada a la pantalla de login SIN NINGÚN MENSAJE: la persona
       * escribía la contraseña de nuevo creyendo que se le había vencido. Ese era
       * el "al principio cuesta ingresar".
       *
       * El token NO se borra —`mostrarLogin` no limpia la sesión—, así que recargar
       * vuelve a entrar solo. Por eso el mensaje dice recargar y no reingresar.
       */
      .catch(function (e) {
        // Si la sesión venció DE VERDAD, `Sesion.caida()` ya pintó el login con su
        // propio mensaje y borró el token. Pisarlo sería mentirle a la persona.
        if (!Sesion.token) return;
        mostrarLogin(e && e.transitorio
          ? 'No se pudo contactar con el servidor. Su sesión sigue guardada: recargue la página en unos segundos.'
          : 'No se pudo verificar la sesión. Ingrese de nuevo.');
      });
  }

  /** Muestra la pantalla técnica, con o sin sesión iniciada. */
  function abrirConfig() {
    UI.mostrar(UI.id('login'), false);
    UI.mostrar(UI.id('app'), true);
    irA('config');
  }

  function iniciar() {
    /*
     * 🔴 El audio se desbloquea con el PRIMER gesto que haga la persona, sea cual
     * sea, no solo con el clic de "Entrar".
     *
     * Los navegadores no dejan sonar nada hasta que hubo una interacción. Estaba
     * atado únicamente al botón de ingresar, y eso deja afuera el camino más común
     * en plena reunión: recargar la página. Ahí se entra por la sesión guardada,
     * sin ningún clic, y la PRIMERA sirena sale muda — la única que importa, con
     * toda la sala mirando. La segunda ya sonaría, así que es un fallo que no se
     * reproduce probando dos veces.
     *
     * `desbloquear` no hace nada si ya se hizo, así que sobra con dejar los tres
     * escuchas puestos.
     */
    ['click', 'keydown', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, Audio_.desbloquear, { once: true, capture: true });
    });

    /*
     * La pantalla técnica no tiene pestaña: se entra poniendo #config al final de
     * la dirección. Funciona incluso sin sesión iniciada, que es justo cuando hace
     * falta — si la URL del backend quedara mal, el portal no deja ingresar y sin
     * esta puerta habría que republicar el sitio para arreglarlo.
     */
    if (location.hash === '#config') abrirConfig();
    window.addEventListener('hashchange', function () {
      if (location.hash === '#config') abrirConfig();
    });

    UI.id('loginForm').addEventListener('submit', login);
    UI.id('btnSalir').addEventListener('click', salir);
    UI.id('btnVolverSalas').addEventListener('click', function () { irA('dashboard'); });
    UI.id('btnRecargarAsistencia').addEventListener('click', Asistencia.cargar);
    UI.id('btnGuardarApi').addEventListener('click', Config.guardar);
    UI.id('btnProbarApi').addEventListener('click', Config.probar);
    UI.id('btnCerrarCel').addEventListener('click', Sala.cerrarCelebracion);
    UI.id('btnPantalla').addEventListener('click', Pantalla.alternar);
    UI.id('btnPanel').addEventListener('click', Pantalla.alternarPanel);
    /*
     * Se escucha el CAMBIO, no solo el clic: de la pantalla completa también se sale
     * con Escape o con el botón del navegador, y ahí nadie pasa por `alternar`. Sin
     * este escucha, el icono quedaría diciendo "salir" fuera de pantalla completa y
     * —peor— los avisos y el festejo se quedarían mudados adentro de un contenedor
     * que ya no está maximizado.
     */
    document.addEventListener('fullscreenchange', Pantalla.alCambiar);
    Pantalla.ajustarDisponibilidad();
    UI.id('btnRepetirSirena').addEventListener('click', Sala.repetirSirena);

    UI.id('linkConfig').addEventListener('click', function (ev) { ev.preventDefault(); abrirConfig(); });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { irA(t.getAttribute('data-vista')); });
    });

    // Al salir de la página se corta todo: nada de timers latiendo en una pestaña
    // que ya nadie mira.
    window.addEventListener('beforeunload', function () { Sala.salir(); });

    reanudar();
  }

  return {
    iniciar: iniciar, irA: irA, irASala: irASala,
    mostrarLogin: mostrarLogin
  };
})();

// Expuesto solo lo que otros módulos necesitan nombrar entre sí.
window.App = App;
window.Sala = Sala;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', App.iniciar);
else App.iniciar();

})();
