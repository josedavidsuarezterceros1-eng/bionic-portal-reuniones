/**
 * ══════════════════════════════════════════════════════════════════════════
 * PORTAL DE REUNIONES BIONIC MIND — Frontend
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Un solo archivo, pero por módulos separados (Cfg · API · Reloj · Sesion ·
 * Audio · Confeti · UI · Sala · Dashboard · Asistencia · Config · App).
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
   * carrera QUIC/TCP de Chrome la primera vez que habla con ese host, una pestaña
   * ocupada— la segunda llega con la clave gastada y sale un 404.
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
   *
   * ⚠️ `registrarProduccion` NO está y no puede estar: un reintento anotaría la
   * matrícula DOS VECES en pleno festejo, y nadie lo notaría hasta cuadrar los
   * números. Tampoco `iniciarRonda` ni `reclamarAnfitrion`. Los tres fallan a la
   * vista (toast rojo) y con el botón ahí para volver a apretar.
   *
   * La lista corta es a propósito: cada entrada es una promesa de que repetir es
   * inofensivo. Antes de agregar una, hay que poder escribir el porqué acá.
   */
  /*
   * `abrirSala` es REPETIBLE y tiene que serlo: solo enciende una marca, así que
   * mandarla dos veces deja la sala abierta las dos veces. Sin esto, el 404 del
   * transporte —que pega sobre todo al arrancar, justo cuando el anfitrión abre la
   * sala— le haría creer que no se abrió y toda la filial esperaría de más.
   */
  var POST_REPETIBLE = { login: true, pingAsistencia: true, abrirSala: true };

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

  /*
   * Un aviso CORTO, para cuando arranca una ronda.
   *
   * 🔴 Existe por Google Meet: la reunión vive en OTRA PESTAÑA, así que cuando el
   * anfitrión pide producción nadie está mirando el portal. Sin un aviso que se
   * oiga, el asesor se entera del countdown cuando ya está por la mitad — o no se
   * entera y pierde su propia venta, sin que en pantalla falle nada.
   *
   * ⚠️ Es deliberadamente distinto del festejo: dos notas secas de medio segundo,
   * no la sirena. Si sonara parecido, la sala no distinguiría "empezó la ronda" de
   * "destaparon a alguien" y el suspenso se arruina.
   *
   * ⚠️ Suena TAMBIÉN en los countdowns de teatro, y tiene que ser así: el teatro es
   * indistinguible del real a propósito. Un aviso que solo sonara en los reales le
   * contaría a toda la sala cuándo queda producción.
   */
  function sonidoAviso() {
    var c = contexto(); if (!c) return;
    var t0 = c.currentTime;
    [[880, 0], [1320, 0.18]].forEach(function (par) {
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(par[0], t0 + par[1]);
      gain.gain.setValueAtTime(0, t0 + par[1]);
      gain.gain.linearRampToValueAtTime(0.16, t0 + par[1] + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + par[1] + 0.3);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t0 + par[1]); osc.stop(t0 + par[1] + 0.32);
    });
  }

  return {
    desbloquear: desbloquear,
    aviso: function () { try { sonidoAviso(); } catch (e) {} },
    tocar: function (tipo) {
      try { tipo === 'matricula' ? sonidoMatricula() : sonidoAbono(); } catch (e) {}
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Tema — claro por defecto, oscuro si lo eligió esta persona
   ══════════════════════════════════════════════════════════════════════════

   🔴 El tema ya viene puesto ANTES de que este archivo corra: lo hace un script
   chiquito en el <head> de index.html. Acá solo está el interruptor.

   Si esto lo hiciera app.js, que se carga con `defer`, la página se dibujaría con
   el claro y un instante después cambiaría entera — un parpadeo en cada carga, y
   proyectado en la reunión se ve roto.

   ⚠️ NO se consulta `prefers-color-scheme`: el dueño pidió que arranque en claro,
   punto. Mirar la preferencia del sistema dejaría a media oficina en oscuro sin
   haberlo elegido, y encima con la pantalla de reunión distinta para cada uno.
   ══════════════════════════════════════════════════════════════════════════ */
var Tema = (function () {
  var LLAVE = 'portal_tema';

  function actual() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function poner(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    /*
     * ⚠️ Guardar puede LANZAR (ventana privada, almacenamiento bloqueado). El tema
     * ya cambió en pantalla; que no se pueda recordar no puede tirar el clic.
     */
    try { localStorage.setItem(LLAVE, t); } catch (e) {}
  }

  return {
    actual: actual,
    alternar: function () { poner(actual() === 'dark' ? 'light' : 'dark'); }
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

  /**
   * Rastro en la consola de las decisiones que MUEVEN al usuario de lugar.
   *
   * 🔴 No es depuración olvidada: es lo único que contesta "¿por qué me sacó de la
   * sala?" cuando pasa en una reunión de verdad. Los carteles duran segundos y la
   * persona está mirando el video, no la esquina; el registro del navegador queda.
   *
   * Va con prefijo fijo para que se pueda filtrar escribiendo `[portal]` en la
   * consola, entre lo que escriban las librerías de terceros.
   *
   * Se anota SOLO lo que decide algo —entrar a una sala, salir, quién es
   * anfitrión— y nunca datos de personas ni el enlace de la reunión.
   */
  function rastro(que, detalle) {
    try {
      console.log('[portal] ' + que, detalle === undefined ? '' : detalle);
    } catch (e) {}
  }

  /**
   * @param {number} [ms] Cuánto queda en pantalla. Sin esto, todos duran lo mismo
   *   y un aviso que EXPLICA POR QUÉ pasó algo se va antes de que la persona
   *   termine de mirar la pantalla. Le pasó al dueño: lo sacó de una sala, vio un
   *   cartel y no llegó a leerlo — así que no se pudo saber si lo había sacado el
   *   portal o la videollamada.
   */
  function toast(mensaje, tipo, ms) {
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
    }, ms || (tipo === 'error' ? 6000 : 3800));
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

  /*
   * 🔴 Formato de 24 HORAS, siempre.
   *
   * `es-BO` sin `hour12:false` devuelve "03:02 p. m." — y la oficina habla de las
   * 8:00 y las 14:00, igual que el manual y que el modelo operativo. Justo en la
   * pantalla que existe para que nadie discuta una hora, un "p. m." obliga a
   * traducir mentalmente y deja lugar a la duda que veníamos a sacar. De paso,
   * ese formato termina en punto y dejaba un ".." al lado del texto.
   */
  function hora(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return { $: $, id: id, esc: esc, mostrar: mostrar, toast: toast, rastro: rastro,
           hora: hora, avatar: avatar, iniciales: iniciales };
})();



/* ══════════════════════════════════════════════════════════════════════════
   Pozo — lo que cada uno deja cargado para que se cante en la reunión
   ══════════════════════════════════════════════════════════════════════════

   🔴 Existe para matar la carrera contra el reloj. Hasta sep 2026 había que
   apretar "¡Tengo Matrícula!" DENTRO de los 30 segundos del conteo: quien tenía
   internet lento perdía su venta por medio segundo, delante de toda la filial y
   sin forma de reclamar.

   Ahora se carga antes —tranquilo, desde el celular, cuando se quiera— y el
   anfitrión saca una por pulsación.

   ⚠️ Las reglas que DECIDEN viven en el servidor: que el lead esté en MATRICULA o
   ABONO, que no se cargue lo mismo dos veces, y que el detalle salga de la
   planilla del CRM. Acá solo se pide y se muestra.
   ══════════════════════════════════════════════════════════════════════════ */
var Pozo = (function () {
  var P = { pendientes: [], destapadas: [], abierto: false, enviando: false, recientes: null };

  function cuantas() { return P.pendientes.length; }

  function aplicar(pozo) {
    if (!pozo) return;
    P.pendientes = pozo.pendientes || [];
    P.destapadas = pozo.destapadas || [];
    if (P.abierto) pintar();
    Sala.repintarFestejo();
  }

  /** Refresca desde el servidor. Se llama al entrar a una sala y tras cada cambio. */
  function refrescar() {
    return API.get({ accion: 'pozoMio', token: Sesion.token })
      .then(function (r) { if (r && r.ok) aplicar(r.pozo); })
      .catch(function () { /* el pozo no puede tirar abajo la sala */ });
  }

  /*
   * ⚠️ Las del CRM se piden al ABRIR, no en cada sondeo: es una lectura de otra
   * planilla —la del CRM— y solo hace falta cuando la persona va a cargar. En el
   * sondeo serían decenas de lecturas por minuto de una hoja ajena.
   */
  function pedirRecientes() {
    P.recientes = null;
    if (P.abierto) pintar();
    return API.get({ accion: 'pozoRecientes', token: Sesion.token })
      .then(function (r) { P.recientes = (r && r.ok) ? (r.items || []) : []; })
      .catch(function () { P.recientes = []; })
      .then(function () { if (P.abierto) pintar(); });
  }

  function abrir() { P.abierto = true; UI.mostrar(UI.id('pozoModal'), true); pintar(); pedirRecientes(); }
  function cerrar() { P.abierto = false; UI.mostrar(UI.id('pozoModal'), false); }

  function chip(tipo) {
    return '<span class="chip ' + (tipo === 'matricula' ? 'chip-ambar' : 'chip-verde') + '">' +
      (tipo === 'matricula' ? 'Matrícula' : 'Abono') + '</span>';
  }

  function pintar() {
    var c = UI.id('pozoCuerpo');
    if (!c) return;
    var html = '<h4>Esperando turno</h4>';

    html += P.pendientes.length
      ? P.pendientes.map(function (it) {
          return '<div class="pozo-fila">' + chip(it.tipo) +
            '<span class="pozo-quien">' + UI.esc(it.alumno || '(sin nombre del usuario)') +
              (it.ciudad ? ' · ' + UI.esc(it.ciudad) : '') + '</span>' +
            '<span class="pozo-tel">' + UI.esc(it.telefono || '') + '</span>' +
            '<button class="btn" data-quitar="' + UI.esc(it.id) + '" title="Sacar del pozo">' +
              '<span class="material-symbols-rounded">cancel</span></button>' +
          '</div>';
        }).join('')
      : '<p class="pozo-vacio">Nada cargado todavía.</p>';

    if (P.destapadas.length) {
      html += '<h4>Ya se cantó hoy</h4>' + P.destapadas.map(function (it) {
        return '<div class="pozo-fila pozo-hecha">' +
          '<span class="material-symbols-rounded">check_circle</span>' +
          '<span class="pozo-quien">' + UI.esc(it.alumno || '(sin nombre del usuario)') + '</span></div>';
      }).join('');
    }

    /*
     * ⚠️ Las del CRM se OFRECEN, no se cargan solas. Cargarlas automáticamente
     * pondría en el festejo algo que la persona no pidió — y una venta caída o mal
     * registrada saldría proyectada igual, delante de toda la filial.
     */
    html += '<h4>Sus matrículas de las últimas 48 h</h4>';
    if (P.recientes === null) html += '<p class="pozo-vacio">Buscando en el CRM…</p>';
    else if (!P.recientes.length) html += '<p class="pozo-vacio">No hay ninguna sin cargar.</p>';
    else html += P.recientes.map(function (it) {
      return '<div class="pozo-fila">' + chip(it.tipo) +
        '<span class="pozo-quien">' + UI.esc(it.alumno || it.titular || '(sin nombre)') +
          (it.ciudad ? ' · ' + UI.esc(it.ciudad) : '') + '</span>' +
        '<span class="pozo-tel">' + UI.esc(it.telefonoCorto || '') + '</span>' +
        '<button class="btn btn-primario" data-toque="' + UI.esc(it.telefono) + '"' +
          ' data-tipo="' + UI.esc(it.tipo) + '">Cargar</button>' +
      '</div>';
    }).join('');

    c.innerHTML = html;
    Array.prototype.forEach.call(c.querySelectorAll('[data-quitar]'), function (b) {
      b.onclick = function () { quitar(b.getAttribute('data-quitar'), b); };
    });
    Array.prototype.forEach.call(c.querySelectorAll('[data-toque]'), function (b) {
      b.onclick = function () {
        cargar({ tipo: b.getAttribute('data-tipo'), telefono: b.getAttribute('data-toque') }, b);
      };
    });
  }

  /*
   * 🔴 Cargar ESCRIBE, así que no se reintenta sola (ver POST_REPETIBLE) — y por
   * eso mismo el doble clic se frena acá: dos POST salen antes de que vuelva el
   * primero, y esa persona quedaría ocupando dos turnos del festejo mientras el
   * resto de la sala espera sin entender por qué.
   */
  function cargar(datos, boton) {
    if (P.enviando) return Promise.resolve();
    P.enviando = true;
    if (boton) boton.disabled = true;
    return API.post({
      accion: 'pozoCargar', token: Sesion.token,
      tipo: datos.tipo, telefono: datos.telefono,
      alumno: datos.alumno || '', ciudad: datos.ciudad || ''
    }).then(function (r) {
      /*
       * ⚠️ El rechazo dura 7 s, no los 3,8 de siempre: acá el servidor explica QUÉ
       * hacer —"ese lead está en EN SEGUIMIENTO, se cambia en el CRM"— y un aviso
       * que se va antes de que lo lean no avisó nada.
       */
      if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo cargar.', 'error', 7000); return; }
      UI.toast('Cargada. Se canta cuando el anfitrión pida producción.', 'ok');
      if (r.aviso) UI.toast(r.aviso, 'info', 6000);
      aplicar(r.pozo);
      pedirRecientes();
    }).catch(function (e) {
      UI.toast(e.message || 'Error de conexión.', 'error');
    }).then(function () {
      P.enviando = false;
      if (boton) boton.disabled = false;
    });
  }

  function quitar(id, boton) {
    if (P.enviando) return;
    P.enviando = true;
    if (boton) boton.disabled = true;
    API.post({ accion: 'pozoQuitar', token: Sesion.token, id: id })
      .then(function (r) {
        if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo quitar.', 'error'); return; }
        aplicar(r.pozo);
        pedirRecientes();
      })
      .catch(function (e) { UI.toast(e.message || 'Error de conexión.', 'error'); })
      .then(function () { P.enviando = false; if (boton) boton.disabled = false; });
  }

  /** Lo cargado a mano: para quien todavía no llenó el formulario de matrícula. */
  function cargarDelForm() {
    var tipo = UI.$('input[name="pozoTipo"]:checked');
    cargar({
      tipo: tipo ? tipo.value : '',
      telefono: UI.id('pozoTel').value,
      alumno: UI.id('pozoAlumno').value,
      ciudad: UI.id('pozoCiudad').value
    }, UI.id('btnPozoGuardar')).then(function () {
      UI.id('pozoTel').value = '';
      UI.id('pozoAlumno').value = '';
      UI.id('pozoCiudad').value = '';
    });
  }

  return {
    abrir: abrir, cerrar: cerrar, cuantas: cuantas,
    refrescar: refrescar, cargarDelForm: cargarDelForm,
    /* ⚠️ Al salir de la sala se limpia: el pozo es de la PERSONA, pero la pantalla
       no puede quedar mostrando lo de la sesión anterior tras cerrar sesión. */
    limpiar: function () { P.pendientes = []; P.destapadas = []; P.recientes = null; cerrar(); }
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   Sala — el corazón: polling, countdown y festejo
   ══════════════════════════════════════════════════════════════════════════ */
var Sala = (function () {
  var S = {
    sala: null,          // {id, nombre, ...}
    estado: null,        // última respuesta de estadoSala
    ultimoDestape: null, // rondaId:revelados ya festejado, para no repetirlo en cada poll
    timerPoll: null,
    timerTick: null,
    timerAsis: null,
    enReunion: false,   // apretó "Entrar a la reunión" (ver Sala.alEntrarAReunion)
    enviando: false,
    asisValidada: false, // asistencia ya registrada EN ESTA SALA
    redCaida: false,     // para no repetir el aviso de conexión en cada sondeo
    asisFaltan: null,
    asisIngreso: null,   // a qué hora quedó registrado (lo dice el servidor)
    asisTarde: false,    // …y si esa hora llegó tarde a la reunión
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
    S.ultimoDestape = null;
    // ⚠️ La asistencia se cuenta POR SALA. Sin este reset, quien pasa de una sala
    // a otra arrastra el "ya validada" de la anterior y su asistencia a la segunda
    // reunión no se registra nunca — sin ningún error a la vista.
    S.asisValidada = false;
    S.asisFaltan = null;
    S.asisIngreso = null;
    S.asisTarde = false;
    S.redCaida = false;
    S.ceroPedido = null;
    // "Ya se decidió algo sobre esta sala en esta visita". Ver `autoTomarSala`.
    S.autoTomaResuelta = false;
    /*
     * ⚠️ El pozo se pide UNA vez al entrar, no en cada sondeo: es una lectura de
     * hoja y el contenido solo cambia cuando esta persona carga o quita algo —o
     * cuando el anfitrión destapa, que ya trae su propio repintado.
     */
    Pozo.refrescar();
    poll();
    S.timerTick = setInterval(tick, 1000);
  }

  function salir() {
    // Va acá y no en el botón "Salas": por esta función pasan TODOS los caminos de
    // salida —colgar, cerrar sesión, la sesión vencida, cambiar de sala— y cualquiera
    // de ellos deja la pantalla completa puesta sobre una vista escondida.
    Pantalla.apagar();
    // ⚠️ Y el título vuelve a lo que era: si no, quien sale en mitad de una ronda
    // se queda con la pestaña gritando "¡PRODUCCIÓN!" para siempre.
    tituloSegunRonda(false);
    Pozo.limpiar();
    clearTimeout(S.timerPoll); clearInterval(S.timerTick); clearInterval(S.timerAsis);
    S.timerPoll = S.timerTick = S.timerAsis = null;
    S.enReunion = false;
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

  /** ¿Hay algo que mirar en el panel ahora mismo? Cuenta regresiva o destape.
   *  Lo usan la cadencia del sondeo y la apertura automática del panel. */
  /*
   * El título de la pestaña grita mientras hay ronda.
   *
   * 🔴 Es lo ÚNICO del portal que se ve desde la pestaña de Meet. Con la reunión
   * afuera, el panel más lindo del mundo no sirve si está en una pestaña de fondo.
   *
   * ⚠️ Se guarda el título original en vez de escribirlo a mano: si mañana cambia
   * el <title>, esto lo sigue solo en vez de restaurar un texto que ya no es.
   */
  var TITULO_BASE = document.title;

  function tituloSegunRonda(hay) {
    try {
      document.title = hay ? '🔴 ¡PRODUCCIÓN! · ' + TITULO_BASE : TITULO_BASE;
    } catch (e) { /* un título que no se puede escribir no puede tirar el sondeo */ }
  }

  function hayShow(est) {
    var f = est && est.ronda && est.ronda.fase;
    return f === 'countdown' || f === 'reveal';
  }

  function cadencia() {
    var fase = S.estado && S.estado.ronda && S.estado.ronda.fase;
    return (fase === 'countdown' || fase === 'reveal') ? Cfg.POLL_ACTIVO_MS : Cfg.POLL_SALA_MS;
  }

  function aplicar(r) {
    // Se leen ANTES de pisar S.estado: las dos cosas van por TRANSICIÓN.
    var eraAnfitrion = !!(S.estado && S.estado.soyAnfitrion);
    // Se lee ANTES de pisar S.estado: la apertura del panel va por transición.
    var showAntes = hayShow(S.estado);
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

    /*
     * 🔴 ACÁ YA NO SE MONTA NINGÚN VIDEO (sep 2026).
     *
     * Google Meet no se puede incrustar, así que la videollamada vive en otra
     * pestaña y el portal solo guarda el enlace. Lo que el servidor manda en
     * `r.sala.meetUrl` es todo lo que hace falta: `renderEspera` pinta el botón de
     * entrar cuando la sala está abierta.
     *
     * Y por eso desapareció de acá el reintento de "confirmar moderador": eso
     * existía porque el aviso de Jitsi llegaba UNA sola vez y podía perderse. Ahora
     * la sala la abre el anfitrión con un botón, así que si el clic no llega, lo
     * ve él en pantalla y vuelve a apretar. No hay nada que reintentar a ciegas.
     */

    /*
     * El estado de la asistencia viaja TAMBIÉN en el sondeo, no solo en la
     * respuesta del latido.
     *
     * 🔴 El latido se APAGA al validar y no corre con la cámara apagada, así que
     * quien vuelve a entrar a la sala se quedaba sin saber si ya estaba anotado ni
     * a qué hora: el panel le pedía encender la cámara a alguien que ya había
     * cumplido. Manda el servidor, que es el único que lo sabe de verdad.
     */
    if (r.asistencia) {
      if (r.asistencia.validado) S.asisValidada = true;
      if (r.asistencia.ingreso) S.asisIngreso = r.asistencia.ingreso;
      S.asisTarde = !!r.asistencia.tarde;
      if (S.asisFaltan == null && r.asistencia.faltanMin != null) {
        S.asisFaltan = r.asistencia.faltanMin;
      }
    }

    /*
     * 🔴 El panel se ABRE SOLO cuando arranca el show, y se vuelve a esconder al
     * terminar. Para TODOS, no solo para el anfitrión.
     *
     * En pantalla completa el panel arranca escondido (pantalla limpia, decisión
     * del dueño ago 2026). Sin esta apertura automática, el anfitrión pedía
     * producción y quien tuviera el panel escondido **no veía nada**: ni la cuenta
     * regresiva ni los botones de "¡Tengo Matrícula!". Un asesor nuevo ni siquiera
     * sabe que existe el ojito, así que se perdía su propia venta sin entender por
     * qué — y nadie se entera, porque en pantalla no falla nada.
     *
     * Se dispara por TRANSICIÓN, no por estado: si se llamara en cada sondeo,
     * volvería a abrir el panel dos segundos después de que la persona lo cierre a
     * mano en medio de la ronda.
     */
    // Recién ahora se sabe que es anfitrión: si está en pantalla completa con la
    // pantalla limpia, le falta el botón de pedir producción.
    if (!eraAnfitrion && r.soyAnfitrion) Pantalla.alAscenderAAnfitrion();

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 🔴 QUE LA RONDA LLEGUE A QUIEN ESTÁ MIRANDO MEET, NO EL PORTAL.
     * ══════════════════════════════════════════════════════════════════════
     *
     * Este es el agujero que abrió Google Meet: la reunión vive en OTRA PESTAÑA,
     * así que cuando el anfitrión pide producción **nadie está mirando el portal**.
     * El panel se abre solo, sí — pero en una pestaña que está de fondo, y lo único
     * que llega hasta la pestaña de al lado son el TÍTULO y el SONIDO.
     *
     * Sin esto, el asesor se entera del countdown cuando ya está por la mitad, o no
     * se entera y pierde su propia venta sin que en pantalla falle nada.
     *
     * ⚠️ Va por TRANSICIÓN, como la apertura del panel: por estado sonaría en cada
     * sondeo, o sea cada 2 segundos durante toda la ronda.
     */
    if (showAntes !== hayShow(r)) {
      if (hayShow(r)) { Pantalla.abrirPorRonda(); Audio_.aviso(); } else Pantalla.cerrarPorRonda();
      tituloSegunRonda(hayShow(r));
      /*
       * 🔴 El pozo se relee en la TRANSICIÓN de la ronda, no en cada sondeo.
       *
       * Leerlo por sondeo sería una lectura de hoja por persona cada 2-3,5 s, y
       * `estadoSala` está escrito para no tocar Sheets ni una vez — con la filial
       * adentro son decenas por minuto contra las 30 ejecuciones simultáneas que
       * Apps Script le da a todo el proyecto.
       *
       * La transición es justo el momento en que el dato importa: al terminar la
       * vuelta, lo que se cantó tiene que salir de "esperando turno" en la pantalla
       * de su dueño, aunque el destape lo haya disparado otro.
       *
       * ⚠️ Límite conocido: si la misma persona carga desde el celular, la
       * computadora se entera recién en la ronda siguiente. Es cosmético —el
       * contador— y cargar dos veces lo rechaza el servidor con un mensaje claro.
       */
      Pozo.refrescar();
    }

    detectarDestape(r.ronda);
    render();
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

    /*
     * 🔴 Durante la ANTESALA no se le pregunta nada al servidor.
     *
     * Su cero no cambia de fase —la ronda ya está en `countdown` desde el anuncio—,
     * así que un `pollYa` ahí sería un pedido por persona y por ronda que no aporta
     * nada, justo en el momento en que toda la filial está mirando la misma pantalla.
     */
    if (actualizarReloj(ronda)) return;

    var seg = Reloj.faltan(ronda.finTs);

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

  /**
   * @param {number} seg   segundos a mostrar
   * @param {number} [total] segundos que representa el anillo lleno. En la ANTESALA
   *   va `null`: el anillo se deja entero y sin los colores de urgencia, porque ahí
   *   no se está agotando nada — se está anunciando. Pintarlo como si corriera el
   *   tiempo haría creer que ya hay que apurarse, y todavía no empezó.
   */
  function pintarReloj(seg, total) {
    var num = UI.id('relojNum');
    var barra = UI.id('relojBarra');
    var caja = UI.id('reloj');
    if (!num || !barra || !caja) return;

    var anuncio = (total === null);
    num.textContent = seg;
    var tot = anuncio ? 1 : (total || Cfg.COUNTDOWN_MS / 1000);
    var largo = 2 * Math.PI * 64;
    barra.style.strokeDasharray = largo;
    barra.style.strokeDashoffset = anuncio ? 0 : largo * (1 - Math.min(1, seg / tot));
    caja.classList.toggle('antesala', anuncio);
    caja.classList.toggle('urgente', !anuncio && seg <= 10 && seg > 5);
    caja.classList.toggle('critico', !anuncio && seg <= 5);
  }

  /**
   * Pinta el reloj según el momento, y devuelve si estamos en la ANTESALA.
   *
   * 🔴 La antesala existe porque la noticia de que empezó la ronda NO le llega a
   * todos junta: medido contra producción, hasta ~9 s tarde. Como el reloj apunta a
   * un instante absoluto, el que se enteraba tarde veía el conteo aparecer ya en 21
   * — y si en cambio le diéramos 30 desde que se entera, apretaría creyendo que le
   * quedan 5 segundos y el servidor le rechazaría la venta. Se anuncia antes y
   * arranca para todos parejo.
   */
  function actualizarReloj(ronda) {
    var ahora = Reloj.ahora();
    var enAntesala = !!(ronda.inicioTs && ahora < ronda.inicioTs);
    var txt = UI.id('relojTxt');

    /*
     * ⚠️ Acá se escondían los dos botones de producción durante el anuncio. Con el
     * pozo (sep 2026) no hay botones en ningún momento del conteo: se carga antes
     * y esto es puro suspenso.
     */
    if (txt) {
      txt.textContent = enAntesala
        ? '¡Atención! Viene producción'
        : '¿Quién tiene producción?';
    }

    if (enAntesala) {
      pintarReloj(Math.max(0, Math.ceil((ronda.inicioTs - ahora) / 1000)), null);
    } else {
      pintarReloj(Reloj.faltan(ronda.finTs));
    }
    return enAntesala;
  }

  /* ── render del panel lateral ──────────────────────────────────────── */

  function render() {
    if (!S.estado) return;
    /*
     * 🔴 CON RONDA EN CURSO, Producción ocupa el ANCHO COMPLETO.
     *
     * Fuera de la ronda el panel son tres tarjetas repartidas a lo ancho y no hay
     * mucho que hacer —la reunión está en la otra pestaña—. Pero el countdown y
     * los dos botones de "¡Tengo Matrícula!" son EL momento de esta pantalla, y
     * en una columna de 400 px quedaban del mismo tamaño que un aviso cualquiera.
     *
     * ⚠️ Va por ESTADO y no por transición, al revés que `Pantalla.abrirPorRonda`:
     * ahí el motivo es que el usuario puede cerrar el panel a mano y el estado se
     * lo volvería a abrir. Acá no hay nada que el usuario decida, y por estado
     * queda bien también para quien ENTRA a la sala con la ronda ya empezada.
     */
    var panel = UI.$('.panel-lado');
    if (panel) panel.classList.toggle('con-ronda', hayShow(S.estado));
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

  /**
   * El panel de entrada a la reunión. Reemplaza al recuadro del video (sep 2026).
   *
   * 🔴 Google Meet NO se puede incrustar, así que acá no hay video: hay un botón
   * que la abre en otra pestaña. Este panel es ahora la única puerta a la reunión,
   * y eso es deliberado — pasar por el portal es lo que hace que la asistencia se
   * cuente y que el festejo llegue.
   *
   * ⚠️ El botón se pinta con `pintarSi`, no reescribiendo el HTML en cada sondeo:
   * el sondeo corre cada 2 s y un botón reemplazado justo entre el apretar y el
   * soltar se come el clic, sin que se vea nada raro.
   */
  function renderEspera() {
    var r = S.estado;
    // Ya no hay video que pueda taparlo: este panel está siempre.
    UI.mostrar(UI.id('videoEspera'), true);

    var icono = UI.id('esperaIcono'), titulo = UI.id('esperaTitulo'), txt = UI.id('esperaTexto');
    var cajaAccion = UI.id('esperaAccion');
    var url = (r.sala && r.sala.meetUrl) || '';
    var firma = [r.sala.abierta, !!url, S.enReunion, r.soyAnfitrion].join('|');

    /* ── la sala está abierta: se puede entrar ──────────────────────────── */
    if (r.sala.abierta && url) {
      icono.textContent = S.enReunion ? 'how_to_reg' : 'videocam';
      titulo.textContent = S.enReunion ? 'Está en la reunión' : 'La reunión está abierta';
      /*
       * 🔴 Se le pide explícitamente que NO cierre esta pantalla, y hay que
       * decirlo: la cuenta regresiva, los botones de producción y el conteo de
       * asistencia viven acá, no en Meet. Quien cierre el portal creyendo que ya
       * está adentro de la reunión se queda sin asistencia y sin festejo, y nada
       * se lo avisa.
       */
      txt.textContent = S.enReunion
        ? 'Deje esta pantalla abierta: acá salen la cuenta regresiva, los botones de producción y su asistencia.'
        : 'Se abre en otra pestaña. Vuelva a esta pantalla para el festejo de producción.';
      /*
       * ⚠️ El botón queda aunque ya se haya entrado, y dice "Volver a la reunión":
       * quien cierre la pestaña de Meet por error necesita poder volver sin salir
       * de la sala y entrar de nuevo.
       */

      if (pintarSi(cajaAccion, firma,
        '<button class="btn btn-primario btn-bloque" id="btnEntrarReunion">' +
          '<span class="material-symbols-rounded">open_in_new</span> ' +
          (S.enReunion ? 'Volver a la reunión' : 'Entrar a la reunión') + '</button>')) {
        UI.id('btnEntrarReunion').onclick = entrarAReunion;
      }
      return;
    }

    /*
     * 🔴 El vaciado de la caja de acción va POR RAMA, no acá arriba.
     *
     * Mientras estuvo suelto antes de las ramas, dejaba la firma ya escrita: la
     * rama de RESCATE llamaba después a `pintarSi` con esa misma firma, `pintarSi`
     * la veía igual y devolvía false — así que el botón «Abrir la sala» NO SE
     * PINTABA NUNCA. Sin ningún error: un anfitrión con la sala trabada y sin
     * ninguna forma de destrabarla.
     */
    var sinAccion = function () {
      cajaAccion.setAttribute('data-firma', firma);
      cajaAccion.innerHTML = '';
    };

    /* ── abierta pero SIN enlace cargado ───────────────────────────────── */
    /*
     * 🔴 Esta rama existe porque sin ella el portal MIENTE.
     *
     * Si la sala está abierta y el enlace no está cargado, el código caía en "falta
     * abrir la sala" — o sea que al anfitrión que acababa de abrirla le seguía
     * pidiendo abrirla. Apretaría el botón una y otra vez, el panel de al lado le
     * diría que está abierta, y no habría ninguna pista de que el problema es una
     * propiedad del proyecto que solo un administrador puede cargar.
     *
     * Lo encontró una CAPTURA, con la suite entera en verde. Ver el README.
     */
    if (r.sala.abierta) {
      sinAccion();
      icono.textContent = 'error';
      titulo.textContent = 'Falta el enlace de la reunión';
      /*
       * ⚠️ El texto decía "se carga una sola vez, en la configuración del portal",
       * que era cierto con el enlace a mano. Desde Google Meet lo pone la
       * sincronización del calendario, así que una organización recién fundada no
       * tiene enlace hasta la corrida de la madrugada — y el cartel mandaba al
       * administrador a buscar una propiedad que no tiene nada que ver.
       */
      txt.textContent = 'La sala está abierta pero todavía no tiene reunión creada. ' +
        'Avise a un administrador: se crea sola con la sincronización del calendario, ' +
        'y se puede adelantar ejecutando «sincronizarCalendario».';
      return;
    }

    /* ── la tengo yo y quedó sin abrir: RESCATE ────────────────────────── */
    /*
     * 🔴 Desde sep 2026 esta rama casi no se ve: tomar la sala la abre en el mismo
     * gesto. Se llega acá solo si ese POST se perdió en el transporte de un solo
     * uso de Apps Script, o si el registro quedó de un despliegue anterior.
     *
     * Y por eso el botón vive ACÁ y no en el panel: es un rescate, no un paso del
     * flujo. Sin él, un 404 pasajero deja al anfitrión con la sala tomada y cerrada
     * y sin ninguna forma de destrabarla salvo liberarla y volver a entrar.
     */
    if (r.soyAnfitrion) {
      icono.textContent = 'lock_clock';
      titulo.textContent = 'La sala quedó sin abrir';
      txt.textContent = 'Pasa cuando se corta la conexión justo al entrar. ' +
        'Ábrala para que su filial pueda entrar.';
      if (pintarSi(cajaAccion, firma,
        '<button class="btn btn-primario btn-bloque" id="btnAbrirSala">' +
          '<span class="material-symbols-rounded">login</span> Abrir la sala</button>')) {
        UI.id('btnAbrirSala').onclick = abrirSala;
      }
      return;
    }

    /* ── la tiene otro, todavía sin abrir ──────────────────────────────── */
    if (r.anfitrion) {
      sinAccion();
      icono.textContent = 'hourglass_top';
      titulo.textContent = 'Abriendo la sala…';
      // textContent NO necesita escapado (no interpreta HTML); pasarlo por esc()
      // mostraría "&amp;" literal en un apellido con "&".
      txt.textContent = r.anfitrion.nombre + ' está tomando el control de la reunión.';
      return;
    }

    /* ── nadie la tomó ─────────────────────────────────────────────────── */
    sinAccion();
    icono.textContent = 'lock_clock';
    titulo.textContent = 'Esperando al anfitrión';
    txt.textContent = r.puedoReclamar
      ? 'Puede tomar esta sala usted: use el panel de la derecha.'
      : 'La reunión se abre cuando un responsable toma la sala.';
  }

  /**
   * Abre Google Meet en otra pestaña y arranca el conteo de asistencia.
   *
   * ⚠️ El `window.open` va DIRECTO en el manejador del clic. Si se hiciera después
   * de una respuesta del servidor, el navegador lo trataría como una ventana
   * emergente y la bloquearía — sin ningún error visible, solo un botón que no
   * hace nada. Por eso el enlace ya viene en el sondeo y no se pide al apretar.
   */
  function entrarAReunion() {
    var url = S.estado && S.estado.sala && S.estado.sala.meetUrl;
    if (!url) { UI.toast('Todavía no hay enlace de reunión para esta sala.', 'error'); return; }
    window.open(url, '_blank', 'noopener');
    Sala.alEntrarAReunion(true);
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
      /*
       * 🔴 YA NO HAY BOTÓN «Abrir la sala» acá (sep 2026, decisión del dueño).
       *
       * Ese botón nació para reemplazar el aviso del video incrustado, que con Meet
       * en otra pestaña no llega nunca. Pero era un paso de trámite con la filial
       * mirando: no hay nada sobre la reunión de Meet que el anfitrión pueda
       * afirmar y el portal comprobar. Ahora la sala se abre en el mismo gesto de
       * tomarla (ver `reclamarAnfitrion_` en el backend).
       *
       * ⚠️ El botón sobrevive SOLO como rescate, y en la otra pantalla: si el POST
       * del reclamo se perdió en el transporte de un solo uso, `renderEspera` lo
       * ofrece. Acá arriba sería un paso de más en el 99 % de las veces.
       *
       * ⚠️ Tampoco está "Finalizar reunión": con Meet afuera esa orden no llega a
       * ninguna parte, así que prometía cerrarle la videollamada a todos y no hacía
       * nada. Un botón que miente es peor que un botón que falta. La reunión se
       * termina desde el propio Meet; acá se libera la sala.
       */
      if (!pintarSi(cont, firma,
        '<div class="aviso ' + (mod ? 'aviso-ok' : 'aviso-info') + '" style="margin-bottom:12px">' +
          '<span class="material-symbols-rounded">' + (mod ? 'verified' : 'lock_clock') + '</span>' +
          '<span>' + (mod
            ? 'Usted conduce esta reunión. Su filial ya puede entrar.'
            : 'Tomó la sala, pero todavía figura cerrada. Use «Abrir la sala» del panel de la izquierda.') + '</span>' +
        '</div>' +
        '<button class="btn btn-fantasma btn-bloque" id="btnLiberar">' +
          '<span class="material-symbols-rounded">logout</span> Liberar la sala</button>')) return;
      UI.id('btnLiberar').onclick = liberar;
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
      /*
       * 🔴 CUÁNTAS TIENE CARGADAS VA EN LA FIRMA, y sin eso el pozo no se ve.
       *
       * `pintarSi` compara esta firma y no repinta si es igual. Cargar una
       * producción no cambia NADA del estado de la sala —misma fase, misma ronda—,
       * así que sin este campo la persona carga, el servidor la guarda bien, y el
       * panel sigue diciendo "No tiene producción cargada" hasta que arranque una
       * ronda. Es la misma trampa que ya se había pisado con "ya anoté".
       */
      Pozo.cuantas()
    ].join('|');

    /*
     * 🔴 CON LA SALA CERRADA IGUAL SE PUEDE CARGAR, y esto es el punto del pozo.
     *
     * Antes este bloque cortaba acá con "el festejo se habilita cuando la sala esté
     * abierta" — correcto cuando lo único que había eran los botones del conteo.
     * Pero el pozo existe para cargar ANTES de la reunión: si el botón solo
     * apareciera con la sala abierta, habría que esperar a que el anfitrión llegue
     * para poder cargar, que es exactamente la prisa que esto vino a sacar.
     */
    if (!r.sala.abierta) {
      pintarSi(cont, firma, '<p style="font-size:13px;color:var(--txt-dim);margin-bottom:10px">' +
        'El festejo empieza cuando el anfitrión abra la sala. Mientras tanto puede dejar ' +
        'su producción cargada.</p>' + pozoHtml());
      if (UI.id('btnCargarProd')) UI.id('btnCargarProd').onclick = Pozo.abrir;
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
      /*
       * ⚠️ El botón dice SIEMPRE "Pedir producción", nunca "Siguiente" —ni siquiera
       * cuando ya hubo destapes—. Un "siguiente" delataría que queda otra, que es
       * justo lo único que el teatro está cuidando (decisión 07 del plan).
       */
      html += '<button class="btn btn-verde btn-grande btn-bloque" id="btnPedir">' +
        '<span class="material-symbols-rounded">campaign</span> Pedir producción</button>';
    }
    /*
     * 🔴 EL POZO, para todos. Acá abajo va lo que cada uno tiene cargado y el
     * botón para cargar más.
     *
     * Antes esto no existía: había que apretar DENTRO de los 30 segundos del
     * conteo, y quien tenía internet lento perdía su venta delante de toda la
     * filial. Ahora se carga antes, tranquilo, y el conteo es puro suspenso.
     */
    html += pozoHtml();
    if (!pintarSi(cont, firma, html)) return;
    // Se le pasa el BOTÓN, no el evento: pedirProduccion lo deshabilita y le cambia
    // el texto mientras la petición viaja.
    if (UI.id('btnPedir')) UI.id('btnPedir').onclick = function () { pedirProduccion(this); };
    if (UI.id('btnCargarProd')) UI.id('btnCargarProd').onclick = Pozo.abrir;
  }

  /** Lo que esta persona tiene esperando su turno, y el botón para cargar más. */
  function pozoHtml() {
    var n = Pozo.cuantas();
    return '<div class="pozo-mini">' +
      (n
        ? '<span class="chip chip-verde"><span class="material-symbols-rounded">savings</span> ' +
          n + (n === 1 ? ' esperando turno' : ' esperando turno') + '</span>'
        : '<span style="font-size:13px;color:var(--txt-dim)">No tiene producción cargada.</span>') +
      '<button class="btn btn-bloque" id="btnCargarProd" style="margin-top:10px">' +
        '<span class="material-symbols-rounded">add_circle</span> Cargar producción</button>' +
    '</div>';
  }

  /**
   * 🔴 EL CONTEO NO TIENE NADA QUE APRETAR, y ese es el cambio entero (sep 2026).
   *
   * Hasta acá los dos botones de producción vivían ACÁ ADENTRO: había que
   * apretarlos dentro de los 30 segundos, así que quien tenía internet lento
   * perdía su venta por medio segundo — delante de toda la filial y sin forma de
   * reclamar. Con el pozo se carga antes y el conteo pasó a ser puro suspenso.
   *
   * ⚠️ Se ve EXACTAMENTE IGUAL haya producción o no. Si el conteo solo apareciera
   * cuando queda algo, la filial aprendería a leerlo en dos reuniones y se acabó:
   * bastaría con mirar si arranca el reloj para saber si hay más.
   */
  function renderCountdown(ronda, cont, firma) {
    var html =
      '<div class="countdown">' +
        '<div class="reloj" id="reloj">' +
          '<svg viewBox="0 0 144 144">' +
            '<circle class="pista" cx="72" cy="72" r="64"></circle>' +
            '<circle class="barra" id="relojBarra" cx="72" cy="72" r="64"></circle>' +
          '</svg>' +
          '<div class="num" id="relojNum">–</div>' +
        '</div>' +
        // El texto lleva id porque lo alterna `actualizarReloj` cada segundo: la
        // antesala termina por RELOJ, no por una respuesta del servidor, así que
        // `pintarSi` no se enteraría de esa transición.
        '<p class="countdown-txt" id="relojTxt">¿Quién tiene producción?</p>' +
      '</div>';

    pintarSi(cont, firma, html);
    actualizarReloj(ronda);
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
    /*
     * 🔴 Se le dice a QUÉ HORA quedó registrado, y si llegó tarde.
     *
     * Decisión del dueño (ago 2026): las reuniones son a las 8:00 y a las 14:00 y
     * un minuto después ya es tarde. Un "Asistencia registrada" a secas no le
     * sirve a nadie para eso — la persona no tiene forma de saber con qué hora
     * quedó, y se entera recién si alguien se lo reclama días después.
     *
     * ⚠️ Quién llegó tarde lo decide el SERVIDOR (`asisTarde_`). Acá no se compara
     * ninguna hora: sería una segunda copia de la regla, y con el reloj del
     * navegador, que puede estar corrido. El portal solo lo muestra.
     */
    if (S.asisValidada) {
      var hIng = S.asisIngreso ? UI.hora(S.asisIngreso) : null;
      cont.innerHTML = S.asisTarde
        ? '<div class="aviso aviso-error">' +
            '<span class="material-symbols-rounded">running_with_errors</span>' +
            '<span><strong>Ingreso tardío</strong>' +
            (hIng ? '<br>Quedó registrado a las ' + UI.esc(hIng) + '.' : '') +
            '</span></div>'
        : '<div class="aviso aviso-ok">' +
            '<span class="material-symbols-rounded">verified</span>' +
            '<span><strong>Asistencia registrada</strong>' +
            (hIng ? '<br>Hora de ingreso: ' + UI.esc(hIng) + '.' : '') +
            '</span></div>';
      return;
    }
    /*
     * Los minutos los dice el SERVIDOR (`estado.asistencia.minutos`): la reunión de
     * la tarde pide menos que la de la mañana, y el navegador no puede deducir el
     * turno por su cuenta sin volverse una segunda copia de la regla del corte.
     * Mientras no haya llegado el estado se dice "unos minutos" en vez de arriesgar
     * un número que después cambie en pantalla.
     */
    /*
     * ⚠️ Los minutos los dice el SERVIDOR. Antes esto hablaba de "cámara"; con
     * Google Meet en otra pestaña el portal NO PUEDE VER LA CÁMARA DE NADIE, así
     * que decía una cosa y medía otra. Ahora se dice lo que de verdad se mide:
     * estar en la sala. Lo que la cámara no prueba lo corrige el jefe en la
     * pestaña Asistencia, con su observación al lado.
     */
    var mins = S.estado.asistencia && S.estado.asistencia.minutos;
    var cuanto = mins ? (mins === 1 ? 'un minuto' : mins + ' minutos') : 'unos minutos';

    var faltan = S.asisFaltan;   // minutos, ya calculados por el servidor

    if (S.enReunion) {
      cont.innerHTML = '<div class="aviso aviso-info">' +
        '<span class="material-symbols-rounded">how_to_reg</span>' +
        '<span>En la reunión. ' +
        (faltan != null
          ? (faltan <= 1 ? 'Falta menos de un minuto.' : 'Faltan ' + faltan + ' min.')
          : 'Contando…') +
        '</span></div>';
      return;
    }

    /*
     * 🔴 Si salió de la reunión A MITAD de la cuenta NO se dice "quédese N
     * minutos": el servidor conserva lo que ya lleva, así que ese texto le pediría
     * empezar de nuevo algo que no se perdió — y quien crea que perdió el progreso
     * es probable que ni lo intente.
     */
    if (faltan != null && faltan > 0 && faltan < mins) {
      cont.innerHTML = '<div class="aviso aviso-info">' +
        '<span class="material-symbols-rounded">hourglass_top</span>' +
        '<span>Se pausó: lo que lleva no se pierde. Vuelva a esta pantalla — ' +
        (faltan <= 1 ? 'falta menos de un minuto' : 'faltan ' + faltan + ' min') +
        '.</span></div>';
      return;
    }

    cont.innerHTML = '<p style="font-size:13px;color:var(--txt-dim)">' +
      'Deje esta pantalla abierta ' + cuanto +
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

  /**
   * Abre la sala para toda la filial. Solo el anfitrión.
   *
   * 🔴 Es lo que antes hacía solo el video incrustado al darle la corona al
   * anfitrión. Ver el comentario largo en `renderAnfitrion`.
   *
   * ⚠️ Va por `accion()`, que ya frena el doble clic y refresca el sondeo. Es
   * idempotente en el servidor: apretarlo dos veces deja la sala abierta las dos
   * veces, así que un reintento no puede romper nada.
   */
  function abrirSala() {
    accion({ accion: 'abrirSala', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Sala abierta para todos.', 'ok'); });
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
      /*
       * Dice lo que VA A PASAR, no lo que el programa está haciendo por dentro.
       * Antes decía "Sincronizando sala…", que es vocabulario nuestro y no le
       * anticipa al anfitrión que lo próximo es el anuncio y después el conteo.
       * Con la antesala eso importa más: entre su clic y el reloj hay unos
       * segundos, y el botón es lo único que mira mientras tanto.
       */
      boton.innerHTML = '<span class="material-symbols-rounded girando">sync</span> Preparando el conteo…';
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
     * plazo: si a los 10 s el botón sigue diciendo "Preparando", vuelve solo.
     */
    accion({ accion: 'iniciarRonda', token: Sesion.token, salaId: S.sala.id },
      function () { salioBien = true; })
      .then(function () {
        if (!salioBien) { restaurar(); return; }
        setTimeout(restaurar, 10000);
      });
  }

  /*
   * ⚠️ Acá vivía `anotar`, que mandaba `registrarProduccion` desde el countdown.
   * Se fue con el pozo (sep 2026): ahora se carga ANTES, con el teléfono del lead,
   * y eso lo maneja el módulo `Pozo`. El backend responde 'obsoleto' a la acción
   * vieja, con un mensaje que dice qué hacer.
   */

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 🔴 Volver a la pestaña: repintar el reloj YA, sin esperar el próximo tick.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Chromium FRENA las pestañas que no están adelante: al minuto baja los
   * temporizadores a uno por segundo y, tras unos minutos de fondo, a uno por
   * MINUTO. El reloj del portal es un `setInterval` de 1 s, así que en una pestaña
   * de fondo —o en un celular con la pantalla apagada— el número SE CONGELA.
   *
   * Lo caro no es que se congele mientras nadie mira: es que al VOLVER puede
   * quedarse mostrando un número viejo hasta un minuto, y el sondeo también está
   * frenado, así que la persona vuelve al festejo y ve una pantalla que miente.
   * El síntoma que reportó el dueño: 'se quedó clavado y después pegó un salto'.
   *
   * No se puede desactivar el frenado desde la página. Lo que sí se puede es no
   * hacerle esperar ni un segundo cuando vuelve.
   */
  function alVolverAlFrente() {
    if (!S.sala) return;
    if (S.estado && S.estado.ronda && S.estado.ronda.fase === 'countdown') {
      actualizarReloj(S.estado.ronda);
    }
    pollYa();
  }

  /**
   * "Entré a la reunión" / "salí de la reunión".
   *
   * 🔴 REEMPLAZA a `alCambiarCamara` (sep 2026). Antes esto lo disparaba el video
   * incrustado al avisar que la cámara se prendía o apagaba. Con Google Meet en
   * otra pestaña **el portal no puede ver la cámara de nadie**, así que ahora lo
   * dispara la persona al apretar "Entrar a la reunión".
   *
   * ⚠️ Es un auto-reporte más débil que el anterior y no se disimula: quien deja
   * el portal abierto y se va sigue sumando latidos. Lo corrige la lista de
   * verificación, donde el responsable confirma a su gente.
   */
  function alEntrarAReunion(entro) {
    S.enReunion = !!entro;
    clearInterval(S.timerAsis);
    S.timerAsis = null;
    if (S.enReunion && !S.asisValidada) {
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
    /*
     * ⚠️ Se manda `enReunion` Y `camaraActiva` con el mismo valor, a propósito.
     *
     * El backend y el frontend se publican por separado. Si el FRONTEND llegara
     * primero y mandara solo el nombre nuevo, el backend viejo leería undefined →
     * "no está presente" → **nadie quedaría registrado en toda la reunión**, sin un
     * solo error en pantalla. El backend nuevo acepta los dos nombres; esto cubre
     * el orden de despliegue contrario. Se saca en el paso de limpieza, cuando
     * ambos lados lleven un despliegue de convivencia.
     */
    API.post({ accion: 'pingAsistencia', token: Sesion.token, salaId: S.sala.id,
               enReunion: S.enReunion, camaraActiva: S.enReunion })
      .then(function (r) {
        if (!r || !r.ok) return;
        S.asisFaltan = (r.faltanMin != null) ? r.faltanMin : r.faltan;
        // La hora de ingreso y la puntualidad las decide el SERVIDOR; acá solo
        // se guardan para pintarlas. Ver `renderAsistencia`.
        if (r.ingreso != null) S.asisIngreso = r.ingreso;
        S.asisTarde = !!r.tarde;
        if (r.validado) {
          S.asisValidada = true;
          clearInterval(S.timerAsis); S.timerAsis = null;
          /*
           * El aviso lleva la HORA, y dura más si llegó tarde: es el momento en
           * que la persona se entera de con qué hora quedó, y un cartel de 3,8 s
           * que dice algo que después le van a reclamar no alcanza.
           */
          UI.toast(S.asisTarde
            ? 'Ingreso tardío: quedó registrado a las ' + UI.hora(S.asisIngreso) + '.'
            : 'Asistencia registrada. Hora de ingreso: ' + UI.hora(S.asisIngreso) + '.',
            S.asisTarde ? 'error' : 'ok', 8000);
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

    /*
     * El detalle de la matrícula: el usuario y de dónde es (decisión 06 del plan).
     *
     * ⚠️ Se esconde entero si no vino nada. Vacío es honesto —el plan rápido del
     * CRM no pide los datos del estudiante— pero una línea en blanco proyectada se
     * lee como que el portal perdió el dato.
     */
    var det = [item.alumno, item.ciudad].filter(function (x) { return !!x; }).join(' · ');
    UI.id('celDetalle').textContent = det;
    UI.mostrar(UI.id('celDetalle'), !!det);
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
    /* Los dos datos que `Pantalla` necesita para decidir si el panel arranca
       abierto o limpio. Se preguntan; no se copian, para que no haya una segunda
       versión del estado dando vueltas. */
    soyAnfitrion: function () { return !!(S.estado && S.estado.soyAnfitrion); },
    hayRonda: function () { return hayShow(S.estado); },
    alVolverAlFrente: alVolverAlFrente,
    alEntrarAReunion: alEntrarAReunion,
    /*
     * ⚠️ El Pozo lo llama al cargar o quitar: el contador del panel ("2 esperando
     * turno") cambia sin que cambie nada del estado de la sala, así que el sondeo
     * NO lo repintaría — `pintarSi` compara una firma y esa firma no lo incluye.
     * Sin esto, la persona carga y el panel sigue diciendo que no tiene nada.
     */
    repintarFestejo: function () { if (S.estado) renderFestejo(); },
    cerrarCelebracion: cerrarCelebracion,
    repetirSirena: repetirSirena
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Pantalla completa — la pantalla que se PROYECTA
   ══════════════════════════════════════════════════════════════════════════ */
/*
 * 🔴 Por qué existe: con Google Meet en OTRA pestaña, esta es la pantalla que la
 * filial mira junta. Acá viven la cuenta regresiva, los botones de producción y el
 * festejo, y es lo que se proyecta en la reunión.
 *
 * Nació cuando el video estaba incrustado, porque la pantalla completa de aquel
 * maximizaba solo su iframe y se llevaba puesto todo lo que dibuja el portal. Hoy
 * vale más todavía: no hay ningún video que pueda taparla.
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

  /*
   * ════════════════════════════════════════════════════════════════════════
   * EL PANEL: pantalla limpia por defecto, y se abre solo cuando hay show
   * ════════════════════════════════════════════════════════════════════════
   *
   * Decisión del dueño (ago 2026). En pantalla completa —que es como se proyecta
   * la reunión— el panel arranca ESCONDIDO: se ve el video y nada más.
   *
   * 🔴 Con UNA excepción: el ANFITRIÓN arranca con el panel abierto. El botón de
   * "Pedir producción" vive ahí adentro; si a él también le arrancara limpio,
   * tendría que acordarse de destapar el panel para poder abrir la ronda, delante
   * de toda la filial.
   *
   * Y cuando el show empieza, el panel se abre SOLO para todos (ver
   * `abrirPorRonda`, llamado desde `Sala.aplicar`), porque si no, quien lo tenía
   * escondido no ve ni la cuenta regresiva ni los botones de producción.
   *
   * ⚠️ Nada de esto se guarda entre sesiones. Alcanzaría con haberlo dejado
   * abierto una vez para que apareciera proyectado en la reunión siguiente sin que
   * nadie lo pidiera; mismo criterio que el check de agendamiento cruzado del
   * Tablero, que también arranca apagado a propósito.
   */
  var previoRonda = null;      // cómo estaba el panel ANTES del show (null = no hay show)
  var manualEnRonda = false;   // tocó el ojito DURANTE el show: su decisión gana
  var manualDesdeEntrar = false;  // tocó el ojito desde que entró a pantalla completa

  function panelOculto() {
    var el = elemento();
    return !!(el && el.classList.contains('panel-oculto'));
  }

  function ponerPanel(oculto) {
    var el = elemento();
    if (!el) return;
    // El icono lo alterna el CSS a partir de esta clase: ver `.ico-full`.
    el.classList.toggle('panel-oculto', !!oculto);
    var b = UI.id('btnPanel');
    if (b) {
      var txt = oculto ? 'Mostrar el panel' : 'Esconder el panel';
      b.title = txt;
      b.setAttribute('aria-label', txt);
    }
  }

  function alternarPanel() {
    ponerPanel(!panelOculto());
    /* Si lo tocó con el show en curso, manda él: al terminar la ronda no se le
       mueve la pantalla por debajo. Lo automático está para el que no hizo nada. */
    if (previoRonda !== null) manualEnRonda = true;
    manualDesdeEntrar = true;
  }

  /**
   * 🔴 Se volvió anfitrión DESPUÉS de entrar a pantalla completa.
   *
   * Al entrar a una sala libre, la toma automática tarda un viaje al servidor,
   * así que quien aprieta pantalla completa enseguida todavía figura como "no
   * anfitrión" y le arranca la pantalla limpia — sin el botón de "Pedir
   * producción", que es justo lo que vino a hacer. Le pasó al test del teléfono
   * antes que a nadie, y en la reunión iba a pasar igual.
   *
   * ⚠️ Solo si NO tocó el ojito desde que entró: si lo cerró a propósito, no se
   * le vuelve a abrir la pantalla por debajo.
   */
  function alAscenderAAnfitrion() {
    if (!activa() || manualDesdeEntrar || previoRonda !== null) return;
    ponerPanel(false);
  }

  /** Arranca el show: se abre el panel para todos, guardando a dónde volver. */
  function abrirPorRonda() {
    if (!activa()) return;                 // fuera de pantalla completa el panel ya se ve
    if (previoRonda === null) previoRonda = panelOculto();
    manualEnRonda = false;
    ponerPanel(false);
  }

  /** Terminó el show: vuelve a como estaba, salvo que la persona haya decidido. */
  function cerrarPorRonda() {
    var prev = previoRonda, manual = manualEnRonda;
    previoRonda = null;
    manualEnRonda = false;
    if (!activa() || prev === null || manual) return;
    ponerPanel(prev);
  }

  /**
   * Estado del panel al ENTRAR a pantalla completa.
   *
   * ⚠️ Si justo hay un show en curso se abre igual, y se anota que al terminar hay
   * que volver al default. Sin esto, entrar a pantalla completa en mitad de una
   * ronda dejaba la pantalla limpia —o sea, sin la cuenta regresiva— que es
   * exactamente lo que este cambio viene a evitar.
   */
  function arrancarPanel() {
    var limpio = !Sala.soyAnfitrion();
    manualEnRonda = false;
    manualDesdeEntrar = false;
    if (Sala.hayRonda()) {
      previoRonda = limpio;
      ponerPanel(false);
    } else {
      previoRonda = null;
      ponerPanel(limpio);
    }
  }

  function alCambiar() {
    var el = elemento();
    // El icono lo alterna el CSS con `:fullscreen`: no hay estado que sincronizar.
    if (activa() && el) {
      mudar(el);
      arrancarPanel();
    } else {
      devolver();
      // Al salir, el panel vuelve a ser una columna del layout: dejarlo escondido
      // dejaría un hueco al costado y ningún botón a la vista para recuperarlo
      // (el de esconderlo solo se ve en pantalla completa).
      if (el) el.classList.remove('panel-oculto');
      // Y se olvida el show en curso: si vuelve a entrar, `arrancarPanel` decide
      // otra vez desde cero. Guardarlo sería arrastrar un estado que ya no aplica.
      previoRonda = null;
      manualEnRonda = false;
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
    abrirPorRonda: abrirPorRonda, cerrarPorRonda: cerrarPorRonda,
    alAscenderAAnfitrion: alAscenderAAnfitrion,
    panelOculto: panelOculto,
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
        '<button class="sala-card" data-sala="' + UI.esc(s.id) + '"' +
          ' data-meet="' + UI.esc(s.meetUrl || '') + '"' +
          ' style="--acento:' + UI.esc(s.color) + '">' +
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
              '<span class="sala-entrar">' + (s.meetUrl ? 'Entrar a la reunión' : 'Entrar a la sala') +
                '<span class="material-symbols-rounded">' +
                (s.meetUrl ? 'open_in_new' : 'arrow_forward') + '</span></span>' +
            '</div>' +
          '</div>' +
        '</button>';
    }).join('');

    /*
     * ══════════════════════════════════════════════════════════════════════
     * UN SOLO CLIC (sep 2026, decisión del dueño)
     * ══════════════════════════════════════════════════════════════════════
     *
     * Antes entrar a una reunión costaba 2 clics al asesor y 3 al anfitrión, con
     * una espera ciega en el medio. Ahora el clic en la tarjeta hace las tres
     * cosas: abre Meet, entra a la sala del portal y arranca el conteo de
     * asistencia. Si además esta persona puede ser anfitrión y la sala está
     * libre, la toma y la abre sola (ver `autoTomarSala`).
     *
     * 🔴 EL ORDEN NO ES ESTÉTICO, y `window.open` va PRIMERO Y SÍNCRONO.
     *
     * El navegador solo deja abrir una pestaña dentro del manejador del clic. En
     * cuanto se hace después de un `then` —o de cualquier viaje al servidor— la
     * trata como ventana emergente y la BLOQUEA: no hay error, no hay aviso, solo
     * una tarjeta que aparenta no hacer nada. Por eso el enlace viene en la lista
     * de salas y no se pide al apretar.
     *
     * ⚠️ Y la asistencia va DESPUÉS de `irASala`: `Sala.entrar` pasa por
     * `salir()`, que pone `S.enReunion` en false. Llamándola antes, el latido
     * arranca y el cambio de sala lo apaga en el mismo gesto — sin que nada falle.
     */
    Array.prototype.forEach.call(cont.querySelectorAll('.sala-card'), function (c) {
      c.onclick = function () {
        var url = c.getAttribute('data-meet') || '';
        /*
         * Sin enlace NO se abre una pestaña en blanco: se entra igual a la sala y
         * el panel explica que falta crear la reunión (pasa con una organización
         * recién fundada, hasta la sincronización de la madrugada).
         */
        if (url) window.open(url, '_blank', 'noopener');
        App.irASala(c.getAttribute('data-sala'));
        if (url) Sala.alEntrarAReunion(true);
      };
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
  /*
   * ── La lista de verificación ───────────────────────────────────────────────
   *
   * 🔴 Todo lo que decide algo lo decide el SERVIDOR: a quién se puede tildar
   * (`personas`), si el turno sigue abierto (`puedeEditar`) y qué vale hoy para cada
   * uno (`estado`). Acá no se recalcula ninguna de las tres. Si el navegador
   * dedujera, por ejemplo, el plazo por su reloj, la pantalla mostraría los botones
   * habilitados y el servidor los rechazaría uno por uno, sin que se entienda por qué.
   *
   * ⚠️ El motivo para marcar ausente se pide EN LA FILA, no con `prompt()`: la
   * reunión se proyecta y una ventana del navegador queda encima de todo, además de
   * que algunos navegadores la bloquean y el clic no haría nada.
   */
  var V = { fecha: '', turno: '', personas: [], puedeEditar: false,
            pidiendo: '', pidiendoModo: '', enviando: '' };

  function estadoChip(p) {
    if (p.estado === 'PRESENTE') {
      return '<span class="chip chip-verde">Presente</span>' +
        (p.revisado ? '' : ' <span class="chip">sin revisar</span>');
    }
    return '<span class="chip chip-rojo">Ausente</span>' +
      (p.revisado ? '' : ' <span class="chip">sin revisar</span>');
  }

  /*
   * En qué sala se lo registró. Puede ser más de una en el mismo turno: desde sep
   * 2026 el Director usa la sala que le convenga según la estrategia del día, así
   * que "estuvo" sin "dónde" no alcanza para revisar nada.
   */
  function salasDe(p) {
    var s = p.salas || [];
    if (!s.length) return '';
    return '<br><span style="color:var(--txt-dim)">En ' + UI.esc(s.join(' · ')) + '</span>';
  }

  function origen(p) {
    var obs = p.observacion
      ? '<br><span class="verif-obs">' + UI.esc(p.observacion) + '</span>' : '';
    if (p.revisado) {
      return 'Lo marcó ' + UI.esc(p.por) + (p.cuando ? ' · ' + UI.hora(p.cuando) : '') +
        (p.motivo ? '<br><span style="color:var(--txt-dim)">Motivo: ' + UI.esc(p.motivo) + '</span>' : '') +
        obs + salasDe(p);
    }
    // Sin revisar: se dice qué vio el portal, que es de dónde sale el valor de hoy.
    return (p.automatico === 'VALIDADO'
      ? 'El portal lo registró' + (p.ingreso ? ' ' + UI.hora(p.ingreso) : '')
      : '<span style="color:var(--txt-dim)">El portal no lo registró</span>') + salasDe(p);
  }

  function pintarVerif(r) {
    var caja = UI.id('verifCaja');
    /*
     * `data-listo` marca que la respuesta LLEGÓ, se muestre o no la caja.
     *
     * ⚠️ No es decoración: sin esa marca, un check que mire si la caja está escondida
     * la encuentra escondida ANTES de que el servidor conteste y pasa siempre, diga lo
     * que diga el código. Le pasó al check del asesor, y se vio recién al romperlo a
     * propósito: el modo "mostrar la caja aunque no haya gente" seguía en verde.
     */
    caja.setAttribute('data-listo', '1');
    /*
     * 🔴 Un RECHAZO del servidor se muestra; no se esconde la caja.
     *
     * "No tengo gente a cargo" y "el servidor no aceptó lo que pediste" se veían
     * igual —la caja desaparecía—, así que elegir una fecha que el servidor rechaza
     * (una reunión que todavía no pasó) borraba la lista de la pantalla sin decir por
     * qué, y el jefe se quedaba sin forma de volver.
     */
    if (r && r.ok === false) {
      UI.mostrar(caja, true);
      UI.id('verifSubtitulo').textContent = '';
      UI.id('verifTabla').innerHTML = '';
      UI.id('verifAviso').innerHTML =
        '<div class="aviso aviso-info"><span class="material-symbols-rounded">info</span>' +
        '<span>' + UI.esc(r.message || 'No se pudo mostrar la lista.') + '</span></div>';
      return;
    }
    // Sin gente a cargo no hay nada que verificar: la caja no existe para esa persona.
    if (!r || !r.ok || !r.personas || !r.personas.length) { UI.mostrar(caja, false); return; }
    UI.mostrar(caja, true);

    V.fecha = r.fecha; V.turno = r.turno; V.personas = r.personas; V.puedeEditar = !!r.puedeEditar;
    UI.id('verifFecha').value = r.fecha;
    // El tope lo manda el servidor (ver `hoy` en verificacionLista_): una reunión que
    // todavía no pasó no se verifica, y así ni se puede elegir.
    if (r.hoy) UI.id('verifFecha').max = r.hoy;
    UI.id('verifTurno').value = r.turno;

    var faltan = r.personas.filter(function (p) { return !p.revisado; }).length;
    UI.id('verifSubtitulo').innerHTML = r.personas.length + ' en su equipo · ' +
      (faltan ? '<b>' + faltan + ' sin revisar</b>' : 'todos revisados');

    UI.id('verifAviso').innerHTML = r.puedeEditar ? '' :
      '<div class="aviso aviso-info"><span class="material-symbols-rounded">lock_clock</span>' +
      '<span>' + UI.esc(r.motivoCerrado) + '</span></div>';

    UI.id('verifTabla').innerHTML =
      '<div class="tabla-scroll"><table><thead><tr>' +
        '<th>Nombre</th><th>Cargo</th><th>Asistencia</th><th>De dónde sale</th><th></th>' +
      '</tr></thead><tbody>' +
      r.personas.map(function (p) {
        var pidiendo = V.pidiendo === p.email ? V.pidiendoModo : '';
        return '<tr data-email="' + UI.esc(p.email) + '">' +
          '<td style="font-weight:600">' + UI.esc(p.nombre) + '</td>' +
          '<td style="color:var(--txt-dim);font-size:12.5px">' + UI.esc(p.cargo) + '</td>' +
          '<td>' + estadoChip(p) + '</td>' +
          '<td style="font-size:12.5px">' + origen(p) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
            /*
             * 🔴 Lo que se escribe va EN LA FILA, nunca con `prompt()`: la reunión se
             * proyecta, una ventana del navegador queda encima de todo, y algunos
             * navegadores directamente la bloquean —el clic no haría nada—.
             *
             * Dos campos distintos a propósito (sep 2026):
             *   · MOTIVO       solo al marcar ausente, y es OBLIGATORIO: lo que queda
             *                  escrito es que un jefe afirmó que faltó.
             *   · OBSERVACIÓN  opcional y para los dos casos. Con Meet afuera el
             *                  portal no ve la cámara de nadie, así que esto es lo
             *                  único que deja constancia de "estuvo pero no encendió
             *                  cámara" o "mejorar marca personal".
             */
            (!V.puedeEditar ? '' : pidiendo === 'ausente'
              ? '<span class="verif-motivo">' +
                  '<input type="text" class="verif-texto" data-motivo="' + UI.esc(p.email) + '" ' +
                    'placeholder="¿Por qué faltó?" maxlength="120">' +
                  '<input type="text" class="verif-texto" data-obs="' + UI.esc(p.email) + '" ' +
                    'placeholder="Observación (opcional)" maxlength="300">' +
                  '<button class="btn btn-peligro" data-guardar="' + UI.esc(p.email) + '">Guardar</button>' +
                  '<button class="btn" data-cancelar="1">Cancelar</button>' +
                '</span>'
              : pidiendo === 'presente'
              ? '<span class="verif-motivo">' +
                  '<input type="text" class="verif-texto" data-obs="' + UI.esc(p.email) + '" ' +
                    'placeholder="Observación (opcional)" maxlength="300">' +
                  '<button class="btn btn-primario" data-guardar-ok="' + UI.esc(p.email) + '">Guardar</button>' +
                  '<button class="btn" data-cancelar="1">Cancelar</button>' +
                '</span>'
              : '<button class="btn" data-presente="' + UI.esc(p.email) + '" title="Estuvo en la reunión">' +
                  '<span class="material-symbols-rounded">check_circle</span> Presente</button> ' +
                '<button class="btn" data-observar="' + UI.esc(p.email) + '" title="Anotar una observación">' +
                  '<span class="material-symbols-rounded">edit_note</span></button> ' +
                '<button class="btn" data-ausente="' + UI.esc(p.email) + '" title="No estuvo">' +
                  '<span class="material-symbols-rounded">cancel</span> Ausente</button>') +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    if (V.pidiendo) {
      var caja2 = UI.$('[data-motivo="' + V.pidiendo + '"]') ||
                  UI.$('[data-obs="' + V.pidiendo + '"]');
      if (caja2) caja2.focus();
    }
  }

  /*
   * 🔴 Al ABRIR no se manda ni fecha ni turno: los elige el SERVIDOR, que es el único
   * que sabe qué reunión corre (y con qué reloj). La primera versión mandaba lo que
   * tenía el desplegable —MAÑANA, su primera opción— así que a las 14:00 la lista
   * abría en la reunión de la mañana, ya cerrada: los botones no aparecían y parecía
   * que el jefe no tenía permiso. Lo encontró el test del navegador, no el
   * razonamiento: el backend respondía perfecto a lo que se le preguntaba.
   */
  function cargarVerif(desdeControles) {
    var fecha = desdeControles ? (UI.id('verifFecha').value || '') : '';
    var turno = desdeControles ? (UI.id('verifTurno').value || '') : '';
    API.get({ accion: 'verificacion', token: Sesion.token, fecha: fecha, turno: turno })
      .then(pintarVerif)
      /*
       * 🔴 El fallo NO se traga. Antes este `catch` estaba vacío "porque el historial
       * de abajo ya avisa", y eso dejaba al jefe mirando una pantalla sin lista sin
       * saber si es que no tiene gente a cargo o si no se pudo cargar — dos cosas muy
       * distintas cuando lo que hay que hacer es revisar la asistencia de su equipo.
       */
      .catch(function (e) {
        var caja = UI.id('verifCaja');
        caja.setAttribute('data-listo', 'error');
        UI.mostrar(caja, true);
        UI.id('verifSubtitulo').textContent = '';
        UI.id('verifTabla').innerHTML = '';
        UI.id('verifAviso').innerHTML =
          '<div class="aviso aviso-error"><span class="material-symbols-rounded">error</span>' +
          '<span>No se pudo cargar la lista de su equipo. ' + UI.esc(e && e.message || '') + '</span></div>';
      });
  }

  /** Apaga o devuelve los botones de la tabla mientras una corrección viaja. */
  function botonesVerif(apagados) {
    var t = UI.id('verifTabla');
    if (!t) return;
    var bs = t.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].disabled = apagados;
  }

  function marcar(email, presente, motivo, observacion) {
    /*
     * 🔴 Escribe: NO se reintenta sola (ver POST_REPETIBLE). Un reintento agregaría
     * otra fila con la misma corrección: no cambia el resultado, pero ensucia el
     * registro de quién la hizo y cuándo.
     *
     * ⚠️ Y el DOBLE CLIC hace exactamente eso mismo, que es lo que el párrafo de
     * arriba dice querer evitar: dos POST salen igual de rápido que uno. Los botones
     * se apagan hasta que el servidor conteste; el repintado los devuelve nuevos, y
     * si la respuesta fue un rechazo se rehabilitan acá (ahí no hay repintado).
     */
    if (V.enviando) return Promise.resolve();
    V.enviando = email;
    botonesVerif(true);

    return API.post({
      accion: 'verificarAsistencia', token: Sesion.token,
      email: email, presente: presente, motivo: motivo || '',
      observacion: observacion || '',
      fecha: V.fecha, turno: V.turno
    }).then(function (r) {
      if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo guardar.', 'error'); return; }
      V.pidiendo = ''; V.pidiendoModo = '';
      pintarVerif(r);
      UI.toast(presente ? 'Marcado presente.' : 'Marcado ausente.', 'ok');
    }).catch(function (e) {
      UI.toast(e.message || 'Error de conexión.', 'error');
    }).then(function () {
      V.enviando = '';
      botonesVerif(false);
    });
  }

  /** Repinta la tabla con lo que ya está en memoria (abrir o cerrar una fila). */
  function repintarVerif() {
    pintarVerif({ ok: true, fecha: V.fecha, turno: V.turno, puedeEditar: V.puedeEditar,
                  motivoCerrado: '', personas: V.personas });
  }

  function valorDe(sel, email) {
    var caja = UI.$('[' + sel + '="' + email + '"]');
    return caja ? caja.value.trim() : '';
  }

  function alClic(ev) {
    var b = ev.target.closest && ev.target.closest('button');
    if (!b) return;

    // Confirmar presente, sin decir nada más: es el camino de todos los días.
    if (b.getAttribute('data-presente')) { marcar(b.getAttribute('data-presente'), true); return; }

    // Presente PERO con algo que decir ("no encendió cámara", "mejorar marca").
    if (b.getAttribute('data-observar')) {
      V.pidiendo = b.getAttribute('data-observar'); V.pidiendoModo = 'presente';
      repintarVerif();
      return;
    }
    if (b.getAttribute('data-ausente')) {
      V.pidiendo = b.getAttribute('data-ausente'); V.pidiendoModo = 'ausente';
      repintarVerif();
      return;
    }
    if (b.getAttribute('data-cancelar')) {
      V.pidiendo = ''; V.pidiendoModo = '';
      repintarVerif();
      return;
    }

    var okEmail = b.getAttribute('data-guardar-ok');
    if (okEmail) { marcar(okEmail, true, '', valorDe('data-obs', okEmail)); return; }

    var email = b.getAttribute('data-guardar');
    if (email) {
      var texto = valorDe('data-motivo', email);
      // El servidor lo exige igual; acá se avisa sin gastar un viaje.
      if (texto.length < 4) { UI.toast('Escriba el motivo para marcar ausente.', 'error'); return; }
      marcar(email, false, texto, valorDe('data-obs', email));
    }
  }

  function cargar() {
    cargarVerif();
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
        // "Ingreso", no "Hora": desde ago 2026 la hora guardada es la de PRENDER LA
        // CÁMARA, no la de completar los minutos. Con el rótulo viejo la columna
        // seguía diciendo lo mismo y significando otra cosa, que es la peor forma
        // de cambiar un dato que la gente usa para saber quién llegó a horario.
        '<th>Fecha</th><th>Turno</th><th>Nombre</th><th>Cargo</th><th>Sala</th><th>Ingreso</th><th>Estado</th>' +
      '</tr></thead><tbody>' +
      logs.map(function (l) {
        return '<tr>' +
          '<td>' + UI.esc(l.fecha) + '</td>' +
          '<td><span class="chip">' + UI.esc(l.turno || '—') + '</span></td>' +
          '<td style="font-weight:600">' + UI.esc(l.nombre) + '</td>' +
          '<td style="color:var(--txt-dim);font-size:12.5px">' + UI.esc(l.cargo) + '</td>' +
          '<td style="color:var(--txt-dim)">' + UI.esc(l.sala) + '</td>' +
          /*
           * 🔴 La hora se marca en ROJO si llegó tarde, y lo decide el servidor
           * (`asisTarde_`). Sin la marca, la columna es una lista de horas que hay
           * que comparar de memoria contra las 8:00 y las 14:00 fila por fila —
           * justo lo que esta pantalla existe para evitar.
           */
          '<td' + (l.tarde ? ' style="color:var(--rojo,#ef4444);font-weight:600"' : '') + '>' +
            UI.hora(l.timestamp) + (l.tarde ? ' ⚠' : '') + '</td>' +
          '<td><span class="chip ' + (l.validado ? 'chip-verde' : 'chip-ambar') + '">' +
            (l.validado ? 'Validado' : 'Parcial') + '</span>' +
            // Rojo, igual que la hora: un chip ámbar al lado de una hora roja se lee
            // como dos gravedades distintas para el mismo hecho.
            (l.tarde ? ' <span class="chip chip-rojo">Tarde</span>' : '') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  return { cargar: cargar, alClic: alClic, cargarVerif: cargarVerif };
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
    UI.id('btnTema').addEventListener('click', Tema.alternar);
    UI.id('btnPozoCerrar').addEventListener('click', Pozo.cerrar);
    UI.id('btnPozoGuardar').addEventListener('click', Pozo.cargarDelForm);
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
    /* Ver `Sala.alVolverAlFrente`: el navegador frena las pestañas de fondo y el
       reloj se queda clavado hasta que alguien lo despierta. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) Sala.alVolverAlFrente();
    });
    Pantalla.ajustarDisponibilidad();
    UI.id('btnRepetirSirena').addEventListener('click', Sala.repetirSirena);

    UI.id('linkConfig').addEventListener('click', function (ev) { ev.preventDefault(); abrirConfig(); });
    // Delegado sobre la tabla: se repinta entera en cada marcado, así que los botones
    // de cada fila no existen todavía cuando esto corre.
    UI.id('verifTabla').addEventListener('click', Asistencia.alClic);
    // `true`: acá sí manda lo que eligió la persona, que es de lo que se trata.
    UI.id('verifFecha').addEventListener('change', function () { Asistencia.cargarVerif(true); });
    UI.id('verifTurno').addEventListener('change', function () { Asistencia.cargarVerif(true); });

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
