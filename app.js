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
    POLL_ACTIVO_MS: 2000,    // llamada o destape en curso
    POLL_SALA_MS: 3500,      // cualquier otro momento dentro de una sala
    ASIS_PING_MS: 60000,     // un latido por minuto con la cámara encendida

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
   * La llamada NO se canta desde el servidor: el backend manda `finTs` (un
   * instante absoluto) y `serverNow`. Acá se guarda la diferencia contra el reloj
   * local y los golpes avanzan sin pedir nada por red.
   *
   * Así corren suaves aunque la respuesta tarde, y las pantallas de la sala van
   * casi juntas porque apuntan al mismo instante. Con el pozo el margen es
   * generoso: sin carrera, un golpe medio segundo corrido no le cuesta nada a
   * nadie — lo que sí importa es que ninguna pantalla lo cante al revés.
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
   * Un aviso CORTO, para cuando arranca la llamada.
   *
   * ⚠️ Es deliberadamente distinto del festejo: dos notas secas de medio segundo,
   * no la sirena. Si sonara parecido, la sala no distinguiría "empieza la llamada"
   * de "destaparon a alguien" y el suspenso se arruina.
   *
   * ⚠️ Suena IGUAL con el pozo vacío, y tiene que ser así: una llamada que solo
   * sonara cuando queda producción le contaría a toda la sala cuándo no queda.
   *
   * 🔴 Quién lo toca lo decide `Sala`, no este módulo: solo el ANFITRIÓN (ver
   * `sonarSiAnfitrion`). Acá vive solo el sonido.
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

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * LA LLAMADA SUENA (sep 2026): un golpe por «a la una / a las dos / a las tres»,
   * el REDOBLE desde «a las dos» hasta el destape, y el PLATILLO al destapar.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Es el sonido del prototipo que aprobó el dueño. Como todo el sonido automático,
   * lo decide `Sala.sonarSiAnfitrion`: sale de UNA máquina y viaja por Meet.
   */

  /** El golpe de cada número: una campana y un bombo grave que sube con la cuenta. */
  function sonidoGolpe(n) {
    var c = contexto(); if (!c) return;
    var t0 = c.currentTime;
    var tono = [330, 440, 554.37, 659.25][n] || 440;
    var osc = c.createOscillator(), gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(tono, t0);
    gain.gain.setValueAtTime(0.5, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t0); osc.stop(t0 + 1.25);

    var sub = c.createOscillator(), subGain = c.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110 + n * 25, t0);
    sub.frequency.exponentialRampToValueAtTime(45, t0 + 0.5);
    subGain.gain.setValueAtTime(0.55, t0);
    subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    sub.connect(subGain); subGain.connect(c.destination);
    sub.start(t0); sub.stop(t0 + 0.65);
  }

  /** El platillo del destape: un racimo metálico y un soplo de ruido brillante. */
  function sonidoPlatillo() {
    var c = contexto(); if (!c) return;
    var t0 = c.currentTime;
    [312, 420, 545, 680, 890, 1120].forEach(function (f) {
      var osc = c.createOscillator(), gain = c.createGain(), bpf = c.createBiquadFilter();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f, t0);
      bpf.type = 'bandpass';
      bpf.frequency.setValueAtTime(f * 1.5, t0);
      bpf.Q.setValueAtTime(6, t0);
      gain.gain.setValueAtTime(0.06, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8);
      osc.connect(bpf); bpf.connect(gain); gain.connect(c.destination);
      osc.start(t0); osc.stop(t0 + 1.85);
    });
    var dur = 2.4;
    var buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.7));
    var ruido = c.createBufferSource(), filtro = c.createBiquadFilter(), g = c.createGain();
    ruido.buffer = buf;
    filtro.type = 'highpass';
    filtro.frequency.setValueAtTime(4500, t0);
    filtro.frequency.linearRampToValueAtTime(2800, t0 + dur);
    g.gain.setValueAtTime(0.55, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    ruido.connect(filtro); filtro.connect(g); g.connect(c.destination);
    ruido.start(t0);
  }

  /*
   * ── El REDOBLE ──────────────────────────────────────────────────────────
   *
   * Es un archivo (`sonidos/redoble.mp3`, de Pixabay, licencia de uso libre): el que
   * eligió el dueño. Se baja y se decodifica al DESBLOQUEAR el audio —en el clic de
   * ingresar—, no cuando arranca la llamada: decodificar en ese momento lo haría
   * entrar tarde, con la sala esperando el «a las dos».
   *
   * 🔴 Si el archivo no llega (404, sin red, un navegador que no decodifica mp3),
   * suena un redoble SINTETIZADO. No hay error a la vista en ninguno de los dos
   * casos; la diferencia es solo cómo suena.
   */
  var redobleBuf = null, redobleCargando = false;
  var redobleFuente = null, redobleTimer = null;

  function cargarRedoble() {
    var c = contexto();
    if (!c || redobleBuf || redobleCargando || typeof fetch !== 'function') return;
    redobleCargando = true;
    fetch('sonidos/redoble.mp3')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) {
        return new Promise(function (ok, mal) { c.decodeAudioData(ab, ok, mal); });
      })
      .then(function (b) { redobleBuf = b; })
      .catch(function () { /* queda el sintetizado */ })
      .then(function () { redobleCargando = false; });
  }

  function redobleParar() {
    if (redobleTimer) { clearTimeout(redobleTimer); redobleTimer = null; }
    if (redobleFuente) {
      try { redobleFuente.stop(); redobleFuente.disconnect(); } catch (e) {}
      redobleFuente = null;
    }
  }

  function redobleEmpezar() {
    redobleParar();
    var c = contexto(); if (!c) return;
    if (redobleBuf) {
      var s = c.createBufferSource(), g = c.createGain();
      s.buffer = redobleBuf;
      s.loop = true;            // si la llamada se estira, el redoble no se corta
      g.gain.setValueAtTime(0.8, c.currentTime);
      s.connect(g); g.connect(c.destination);
      s.start(0);
      redobleFuente = s;
      return;
    }
    // Sintetizado: golpes de tambor cada vez más rápidos y más fuertes.
    var inicio = c.currentTime, n = 0;
    var golpe = function () {
      var ahora = c.currentTime, pasado = ahora - inicio;
      var ritmo = Math.min(36, 16 + pasado * 1.8);
      var b = c.createBuffer(1, Math.floor(c.sampleRate * 0.045), c.sampleRate);
      var d = b.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.28));
      var r = c.createBufferSource(), f = c.createBiquadFilter(), g2 = c.createGain();
      r.buffer = b;
      f.type = 'highpass'; f.frequency.value = 1100;
      var acento = n % 4 === 0 ? 1.3 : 0.88, crescendo = Math.min(1.8, 0.45 + pasado * 0.12);
      g2.gain.setValueAtTime(0.3 * acento * crescendo, ahora);
      g2.gain.exponentialRampToValueAtTime(0.001, ahora + 0.04);
      r.connect(f); f.connect(g2); g2.connect(c.destination);
      r.start(ahora);
      n++;
      redobleTimer = setTimeout(golpe, 1000 / ritmo);
    };
    golpe();
  }

  return {
    desbloquear: function () { desbloquear(); cargarRedoble(); },
    aviso: function () { try { sonidoAviso(); } catch (e) {} },
    golpe: function (n) { try { sonidoGolpe(n); } catch (e) {} },
    redobleEmpezar: function () { try { redobleEmpezar(); } catch (e) {} },
    redobleParar: function () { try { redobleParar(); } catch (e) {} },
    tocar: function (tipo) {
      try { tipo === 'matricula' ? sonidoMatricula() : sonidoAbono(); } catch (e) {}
    },
    /** El destape entero: corta el redoble, platillo, y el sonido del tipo. */
    destape: function (tipo) {
      try { redobleParar(); sonidoPlatillo(); } catch (e) {}
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
  var DORADOS = ['#D97706', '#F59E0B', '#059669', '#10B981', '#FFD700', '#FDE047'];
  var lanzador = null;

  /*
   * 🔴 El confeti se dibuja en un lienzo PROPIO, adentro de la sala (`#confetiLienzo`).
   *
   * canvas-confetti, llamado a secas, pega su lienzo en el <body>. En pantalla
   * completa el navegador dibuja SOLO lo que está adentro del elemento maximizado —
   * la sala—, así que en la pantalla que se PROYECTA el confeti no se veía nunca. Sin
   * ningún error: en la computadora de cada uno, fuera de pantalla completa, salía
   * perfecto.
   */
  function disparar(opts) {
    if (typeof window.confetti !== 'function') return;   // el CDN no cargó: se sigue sin papelitos
    if (!lanzador) {
      var lienzo = document.getElementById('confetiLienzo');
      lanzador = lienzo && typeof window.confetti.create === 'function'
        ? window.confetti.create(lienzo, { resize: true })
        : window.confetti;
    }
    try { lanzador(opts); } catch (e) {}
  }

  /** Matrícula: cinco ráfagas doradas y dos cañones; abono: una ráfaga más chica. */
  function tirar(tipo) {
    var base = { origin: { y: 0.7 }, colors: DORADOS };
    var rafaga = function (proporcion, extra, total) {
      disparar(Object.assign({}, base, extra, { particleCount: Math.floor(total * proporcion) }));
    };
    if (tipo === 'matricula') {
      rafaga(0.25, { spread: 26, startVelocity: 55 }, 200);
      rafaga(0.2, { spread: 60 }, 200);
      rafaga(0.35, { spread: 100, decay: 0.91, scalar: 1.1 }, 200);
      rafaga(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.3 }, 200);
      rafaga(0.1, { spread: 120, startVelocity: 45 }, 200);
      setTimeout(function () {
        disparar({ particleCount: 50, angle: 60, spread: 55, origin: { x: 0, y: 0.75 }, colors: DORADOS });
        disparar({ particleCount: 50, angle: 120, spread: 55, origin: { x: 1, y: 0.75 }, colors: DORADOS });
      }, 250);
    } else {
      rafaga(1, { spread: 70 }, 80);
    }
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
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * MI PRODUCCIÓN (sep 2026, paso 3): el pozo vive en la PÁGINA, no en un cuadro.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Orden de lo más rápido a lo más lento (decisión del dueño): lo que ya está en el
   * pozo; las listas del CRM, que se cargan con un toque; buscar por teléfono; y la
   * carga a mano, plegada.
   *
   * ⚠️ Solo se repintan las LISTAS (#pozoCuerpo, #pozoListas, #pozoBuscarRes). Los
   * formularios son fijos en el HTML: repintarlos le borraría a la persona lo que
   * está escribiendo cada vez que llega un sondeo.
   */
  var P = { pendientes: [], destapadas: [], enviando: false, recientes: null, recientesError: '', buscado: null };

  function cuantas() { return P.pendientes.length; }

  function aplicar(pozo) {
    if (!pozo) return;
    P.pendientes = pozo.pendientes || [];
    P.destapadas = pozo.destapadas || [];
    pintarMio();
    Sala.repintarFestejo();
  }

  function refrescar() {
    return API.get({ accion: 'pozoMio', token: Sesion.token })
      .then(function (r) { if (r && r.ok) aplicar(r.pozo); })
      .catch(function () { /* el pozo no puede tirar abajo la sala */ });
  }

  /* ⚠️ Si no se pudo leer el CRM, la lista LO DICE en vez de mostrarse vacía: "no
     hay ninguna sin cargar" le decía a la persona que ya había cargado todo. */
  function pedirRecientes() {
    P.recientes = null;
    P.recientesError = '';
    pintarListas();
    return API.get({ accion: 'pozoRecientes', token: Sesion.token })
      .then(function (r) {
        if (r && r.ok) { P.recientes = r.items || []; return; }
        P.recientes = [];
        P.recientesError = (r && r.message) || 'No se pudo leer el CRM.';
      })
      .catch(function (e) {
        P.recientes = [];
        P.recientesError = (e && e.message) || 'Error de conexión.';
      })
      .then(pintarListas);
  }

  /** Al entrar a una sala: lo mío y las listas del CRM. */
  function entrar() {
    P.buscado = null;
    pintarBuscado();
    refrescar();
    pedirRecientes();
  }

  function chip(tipo) {
    return '<span class="chip ' + (tipo === 'matricula' ? 'chip-verde' : 'chip-ambar') + '">' +
      (tipo === 'matricula' ? 'Matrícula' : 'Abono') + '</span>';
  }

  /** Una tarjeta de producción: tipo, plan, usuario(s), titular, ciudad y teléfono. */
  function tarjeta(it, derecha) {
    var usuarios = [it.alumno, it.alumno2].filter(function (x) { return !!x; });
    var plan = it.planTxt !== undefined ? it.planTxt : it.plan;
    return '<div class="pozo-tarjeta">' +
      '<div class="pt-cab">' + chip(it.tipo) +
        (plan ? '<span class="pt-plan">' + UI.esc(plan) + '</span>' : '') +
        '<span class="pt-der">' + (derecha || '') + '</span>' +
      '</div>' +
      '<p class="pt-usuario"><span>' + (usuarios.length > 1 ? 'Usuarios' : 'Usuario') + ':</span> ' +
        (usuarios.length ? UI.esc(usuarios.join(' y ')) : '<em>(sin nombre del usuario)</em>') + '</p>' +
      (it.titular ? '<p class="pt-linea">Titular: ' + UI.esc(it.titular) + '</p>' : '') +
      '<p class="pt-linea">' + [it.ciudad ? UI.esc(it.ciudad) : '', it.telefono ? 'Tel: ' + UI.esc(it.telefono) : '']
        .filter(function (x) { return !!x; }).join(' · ') + '</p>' +
    '</div>';
  }

  /** Mi producción en el pozo: lo que espera (con Quitar) y lo que se cantó hoy. */
  function pintarMio() {
    var c = UI.id('pozoCuerpo');
    if (!c) return;
    var html = P.pendientes.map(function (it) {
      return tarjeta(it, '<span class="chip chip-azul">En el pozo</span>' +
        '<button class="btn pt-quitar" data-quitar="' + UI.esc(it.id) + '" title="Sacar del pozo">' +
          '<span class="material-symbols-rounded">cancel</span> Quitar</button>');
    }).join('') + P.destapadas.map(function (it) {
      return tarjeta(it, '<span class="chip chip-verde"><span class="material-symbols-rounded">check_circle</span> ' +
        'Cantada' + (it.cantada ? ' · ' + UI.esc(it.cantada) : '') + '</span>');
    }).join('');
    c.innerHTML = html || '<p class="pozo-vacio">No tiene producción cargada.</p>';
    Array.prototype.forEach.call(c.querySelectorAll('[data-quitar]'), function (b) {
      b.onclick = function () { quitar(b.getAttribute('data-quitar'), b); };
    });
  }

  function botonCargar(it) {
    return '<button class="btn btn-verde btn-bloque pt-cargar" data-toque="' + UI.esc(it.telefono) + '"' +
      ' data-tipo="' + UI.esc(it.tipo) + '"><span class="material-symbols-rounded">add_circle</span> Cargar al pozo</button>';
  }

  function conectarToques(c) {
    Array.prototype.forEach.call(c.querySelectorAll('[data-toque]'), function (b) {
      b.onclick = function () {
        cargar({ tipo: b.getAttribute('data-tipo'), telefono: b.getAttribute('data-toque') }, b);
      };
    });
  }

  /** Listas para cantar: lo del CRM de las últimas 48 h que TODAVÍA no está en el pozo. */
  function pintarListas() {
    var c = UI.id('pozoListas');
    if (!c) return;
    var html;
    if (P.recientes === null) html = '<p class="pozo-vacio">Buscando en el CRM…</p>';
    else if (P.recientesError) {
      html = '<p class="pozo-vacio pozo-error">No se pudo revisar el CRM: ' + UI.esc(P.recientesError) +
        ' Puede buscarla por teléfono o cargarla a mano.</p>';
    }
    else if (!P.recientes.length) html = '<p class="pozo-vacio">No hay ninguna sin cargar.</p>';
    else html = P.recientes.map(function (it) { return tarjeta(it) + botonCargar(it); }).join('');
    c.innerHTML = html;
    conectarToques(c);
  }

  /** Buscar por teléfono: muestra lo que el CRM tiene, ANTES de cargar. */
  function buscar() {
    var tel = UI.id('pozoBuscarTel').value;
    P.buscado = { cargando: true };
    pintarBuscado();
    API.get({ accion: 'pozoBuscar', token: Sesion.token, telefono: tel })
      .then(function (r) {
        P.buscado = r && r.ok ? { item: r.encontrado } : { error: (r && r.message) || 'No se encontró.' };
      })
      .catch(function (e) { P.buscado = { error: (e && e.message) || 'Error de conexión.' }; })
      .then(pintarBuscado);
  }

  function pintarBuscado() {
    var c = UI.id('pozoBuscarRes');
    if (!c) return;
    var b = P.buscado;
    if (!b) { c.innerHTML = ''; return; }
    if (b.cargando) { c.innerHTML = '<p class="pozo-vacio">Buscando…</p>'; return; }
    if (b.error) { c.innerHTML = '<p class="pozo-vacio pozo-error">' + UI.esc(b.error) + '</p>'; return; }
    c.innerHTML = tarjeta(b.item) + (b.item.yaCargada
      ? '<p class="pozo-vacio">Ya está en su pozo, esperando turno.</p>'
      : botonCargar(b.item));
    conectarToques(c);
  }

  function cargar(datos, boton) {
    if (P.enviando) return Promise.resolve(false);
    P.enviando = true;
    if (boton) boton.disabled = true;
    return API.post({
      accion: 'pozoCargar', token: Sesion.token,
      tipo: datos.tipo, telefono: datos.telefono,
      alumno: datos.alumno || '', alumno2: datos.alumno2 || '', titular: datos.titular || '',
      ciudad: datos.ciudad || '', plan: datos.plan || '', usuarios: datos.usuarios || ''
    }).then(function (r) {
      if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo cargar.', 'error', 7000); return false; }
      UI.toast('Cargada. Se canta cuando el anfitrión pida producción.', 'ok');
      if (r.aviso) UI.toast(r.aviso, 'info', 6000);
      aplicar(r.pozo);
      P.buscado = null;
      pintarBuscado();
      pedirRecientes();
      return true;
    }).catch(function (e) {
      UI.toast((e && e.message) || 'Error de conexión.', 'error');
      return false;
    }).then(function (cargada) {
      P.enviando = false;
      if (boton && boton.isConnected) boton.disabled = false;
      return cargada === true;
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
      .catch(function (e) { UI.toast((e && e.message) || 'Error de conexión.', 'error'); })
      .then(function () { P.enviando = false; if (boton && boton.isConnected) boton.disabled = false; });
  }

  var marcado = function (nombre) { var el = UI.$('input[name="' + nombre + '"]:checked'); return el ? el.value : ''; };

  /** Con «2x1» aparece el segundo usuario: el CRM guarda uno solo, el otro lo escribe quien carga. */
  function alCambiarPlan() {
    var dos = marcado('pozoPlan') === '2';
    UI.mostrar(UI.id('pozoAlumno2Campo'), dos);
    UI.id('pozoAlumnoEtq').firstChild.textContent = dos ? 'Usuario 1 ' : 'Usuario ';
  }

  /*
   * ⚠️ Lo que escribió la persona QUEDA en el formulario si la carga se rechaza: que
   * corrija solo lo que haga falta. Se limpia recién cuando se cargó.
   */
  function cargarDelForm() {
    var campos = ['pozoTel', 'pozoAlumno', 'pozoAlumno2', 'pozoTitular', 'pozoCiudad'];
    var usuarios = marcado('pozoPlan') || '1';
    cargar({
      tipo: marcado('pozoTipo'),
      telefono: UI.id('pozoTel').value,
      alumno: UI.id('pozoAlumno').value,
      alumno2: usuarios === '2' ? UI.id('pozoAlumno2').value : '',
      titular: UI.id('pozoTitular').value,
      ciudad: UI.id('pozoCiudad').value,
      plan: marcado('pozoPlazo'),
      usuarios: usuarios
    }, UI.id('btnPozoGuardar')).then(function (cargada) {
      if (!cargada) return;
      campos.forEach(function (id) { UI.id(id).value = ''; });
    });
  }

  /** Los formularios fijos se conectan UNA vez, al arrancar. */
  function conectar() {
    UI.id('btnPozoGuardar').addEventListener('click', cargarDelForm);
    UI.id('btnPozoBuscar').addEventListener('click', buscar);
    UI.id('pozoBuscarTel').addEventListener('keydown', function (e) { if (e.key === 'Enter') buscar(); });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pozoPlan"]'), function (r) {
      r.addEventListener('change', alCambiarPlan);
    });
  }

  return {
    cuantas: cuantas, refrescar: refrescar, entrar: entrar, conectar: conectar,
    /* ⚠️ Al salir de la sesión: la pantalla del pozo no puede quedar mostrando lo de
       la sesión anterior. */
    limpiar: function () {
      P.pendientes = []; P.destapadas = []; P.recientes = null; P.recientesError = ''; P.buscado = null;
      ['pozoCuerpo', 'pozoListas', 'pozoBuscarRes'].forEach(function (id) { var c = UI.id(id); if (c) c.innerHTML = ''; });
    }
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Sala — el corazón: polling, llamada y festejo
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
    ceroPedido: null,    // finTs para el que ya se pidió la consulta del segundo cero
    /* La tarjeta del HISTORIAL que el anfitrión eligió volver a mostrar (su número de
       orden), o null = la de ahora. Es local: no toca el pozo ni a nadie más. */
    verOrdinal: null,
    rondaVista: null,    // rondaId de la última ronda vista: al cambiar, se olvida `verOrdinal`
    ultimoGolpe: null    // rondaId:golpe ya sonado, para que cada golpe suene UNA vez
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
    S.verOrdinal = null;
    S.rondaVista = null;
    S.ultimoGolpe = null;
    S.verif = null;
    // "Ya se decidió algo sobre esta sala en esta visita". Ver `autoTomarSala`.
    S.autoTomaResuelta = false;
    /*
     * ⚠️ El pozo se pide UNA vez al entrar, no en cada sondeo: es una lectura de
     * hoja y el contenido solo cambia cuando esta persona carga o quita algo —o
     * cuando el anfitrión destapa, que ya trae su propio repintado.
     */
    Pozo.entrar();
    // Quien tiene gente a cargo ve además la pestaña «Mi equipo» (paso 4). Un asesor no.
    Equipo.entrarSala();
    poll();
    /*
     * ⚠️ 250 ms y no 1 s. El tick solo trabaja durante la llamada (el resto del
     * tiempo sale en la primera línea), y ahí cada golpe dura ~1,5 s: con un tick
     * de un segundo, un golpe se quedaría en pantalla 1 o 2 s según en qué momento
     * cayera, y la cuenta de la pantalla proyectada sonaría a tropiezos.
     */
    S.timerTick = setInterval(tick, 250);
    // Lo que dijo el jefe: al entrar y cada 3 min (el jefe revisa durante la reunión).
    pedirVerif();
    S.timerVerif = setInterval(pedirVerif, 3 * 60 * 1000);
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
    Equipo.salirSala();
    clearTimeout(S.timerPoll); clearInterval(S.timerTick); clearInterval(S.timerAsis); clearInterval(S.timerVerif);
    S.timerPoll = S.timerTick = S.timerAsis = null;
    S.enReunion = false;
    // El redoble corre con su propio temporizador: salir en plena llamada lo dejaría
    // sonando en una pantalla que ya no muestra nada.
    Audio_.redobleParar();
    UI.mostrar(UI.id('escenario'), false);
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

  /*
   * ¿Hay FESTEJO ahora? La llamada, o los primeros segundos de un destape.
   *
   * 🔴 No es «hay una tarjeta en pantalla»: desde sep 2026 la tarjeta se queda hasta
   * la próxima pulsación, que pueden ser minutos de felicitaciones. Si esto siguiera
   * a la tarjeta, la pestaña gritaría «¡PRODUCCIÓN!» y el sondeo iría al ritmo rápido
   * durante media reunión. Lo decide el SERVIDOR (`enShow`), con su reloj, así todas
   * las pantallas cambian juntas.
   *
   * ⚠️ Sin `enShow` (un backend anterior, durante los minutos del despliegue) vale la
   * regla vieja: ahí la tarjeta todavía se iba sola.
   */
  function hayShow(est) {
    var r = est && est.ronda;
    if (!r) return false;
    if (typeof r.enShow === 'boolean') return r.enShow;
    return r.fase === 'llamada' || r.fase === 'reveal';
  }

  function cadencia() {
    return hayShow(S.estado) ? Cfg.POLL_ACTIVO_MS : Cfg.POLL_SALA_MS;
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 🔴 EL SONIDO AUTOMÁTICO SUENA SOLO EN LA MÁQUINA DEL ANFITRIÓN (sep 2026).
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Antes sonaba en TODOS los navegadores con el portal abierto, cada uno cuando su
   * propio sondeo se enteraba: en la oficina eran hasta 20 sirenas desfasadas 0 a 3
   * segundos. El festejo es UN momento colectivo y así sonaba como una feria.
   *
   * Ahora suena en la pantalla que el anfitrión comparte en Meet, y de ahí les
   * llega a todos — si comparte la PESTAÑA con «compartir audio» (ver el
   * recordatorio en su bloque de Producción).
   *
   * 🔴 Se lee `S.estado.soyAnfitrion` EN EL MOMENTO, nunca un valor guardado. Se
   * puede pasar a ser anfitrión a mitad de reunión (toma automática, desplazamiento,
   * rescate del ausente): quien la acaba de tomar tiene que empezar a sonar, y quien
   * la perdió, callarse.
   *
   * ⚠️ «Repetir sirena» NO pasa por acá: es un sonido que la persona PIDIÓ, y un
   * botón que no hace nada para el 95 % de la sala es peor que un poco de ruido.
   */
  function sonarSiAnfitrion(sonar) {
    if (S.estado && S.estado.soyAnfitrion) sonar();
  }

  function aplicar(r) {
    // Se lee ANTES de pisar S.estado: el aviso de la llamada y el título van por TRANSICIÓN.
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
     * ══════════════════════════════════════════════════════════════════════
     * 🔴 QUE LA RONDA LLEGUE A QUIEN ESTÁ MIRANDO MEET, NO EL PORTAL.
     * ══════════════════════════════════════════════════════════════════════
     *
     * Este es el agujero que abrió Google Meet: la reunión vive en OTRA PESTAÑA,
     * así que cuando el anfitrión pide producción **nadie está mirando el portal**.
     * Lo único que llega hasta la pestaña de al lado son el TÍTULO y el SONIDO.
     *
     * ⚠️ Va por TRANSICIÓN: por estado sonaría en cada sondeo, o sea cada 2 segundos
     * durante toda la ronda.
     */
    if (showAntes !== hayShow(r)) {
      if (hayShow(r)) sonarSiAnfitrion(Audio_.aviso);
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

    var ronda = r.ronda || {};
    // Una ronda nueva olvida la tarjeta del historial que se estaba volviendo a mirar.
    if (ronda.rondaId !== S.rondaVista) { S.rondaVista = ronda.rondaId; S.verOrdinal = null; }
    // Terminó la llamada (destape, pozo vacío o cambio de reunión): el redoble se corta.
    if (ronda.fase !== 'llamada') Audio_.redobleParar();

    detectarDestape(ronda);
    render();
  }

  /**
   * Un destape se festeja UNA vez. La clave es ronda + cuántos van, así que el
   * mismo destape leído en cinco polls seguidos no vuelve a sonar, y dos destapes
   * del mismo tipo y la misma persona en una ronda sí se festejan por separado.
   *
   * ⚠️ La TARJETA la pinta `renderEscenario` y se queda; acá solo va el FESTEJO: el
   * sonido y el confeti. Y solo si el destape es fresco (`enShow`): quien entra a la
   * sala con una tarjeta ya quieta en pantalla la ve, pero no le suena una sirena a
   * destiempo — y si es el anfitrión, no se la hace sonar a toda la reunión.
   */
  function detectarDestape(ronda) {
    if (!ronda || ronda.fase !== 'reveal' || !ronda.itemActual) return;
    var clave = ronda.rondaId + ':' + ronda.revelados;
    if (clave === S.ultimoDestape) return;
    S.ultimoDestape = clave;
    S.ultimoItem = ronda.itemActual;
    if (ronda.enShow === false) return;
    var tipo = ronda.itemActual.tipo;
    // Solo en la máquina del anfitrión: de ahí viaja por Meet (ver sonarSiAnfitrion).
    // Sonido Y confeti, los dos solo en la pantalla de quien conduce: es la que se
    // proyecta. Los demás no ven la ceremonia en la suya (paso 3).
    sonarSiAnfitrion(function () { Audio_.destape(tipo); Confeti.tirar(tipo); });
  }

  /* ── la llamada: «Preparando… ¡a la una! ¡a las dos! ¡a las tres!» ──── */

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * LA LLAMADA REEMPLAZA A LA CUENTA REGRESIVA (sep 2026).
   * ══════════════════════════════════════════════════════════════════════════
   *
   * La cuenta de 30 s y su antesala existían por una CARRERA: había que apretar
   * dentro de la ventana. Con el pozo la producción se carga antes, así que no hay
   * plazo que las pantallas tengan que compartir, y lo que queda es un remate.
   *
   * ⚠️ El golpe sale de lo que FALTA para `finTs`, como PROPORCIÓN de `llamadaMs`
   * —no de lo transcurrido—. Quien se entera tarde entra en el golpe que
   * corresponde en vez de arrancar de cero: es el problema que la antesala tapaba,
   * resuelto sin ella. Y como es proporción, el preview puede acortar la llamada
   * sin que se desarme.
   */
  /*
   * Hasta qué fracción de la llamada dura cada golpe. Son los tiempos del prototipo
   * que aprobó el dueño (sep 2026), sobre una llamada de 11,5 s: «a la una» a los
   * 2 s, «a las dos» a los 5 —ahí entra el redoble—, «¡a las tres!» a los 8,2 y el
   * destape al final. Como son PROPORCIONES, el preview puede cambiar la duración
   * sin desarmar la cuenta.
   */
  var GOLPES = [
    { hasta: 0.174, clave: 'prep', num: '',  txt: 'Preparando…' },
    { hasta: 0.435, clave: 'una',  num: '1', txt: '¡A la una!' },
    { hasta: 0.713, clave: 'dos',  num: '2', txt: '¡A las dos!' },
    { hasta: 1.01,  clave: 'tres', num: '3', txt: '¡A las tres!' }
  ];

  /*
   * 🔴 La llamada nombra SOLO el orden: «la primera», «la segunda»… NUNCA el tipo
   * (decisión del dueño, sep 2026). «Primera matrícula» mentiría cuando sale un
   * abono; «primer abono» delataría que los abonos van siempre primero, y en dos
   * reuniones la sala sabría cuándo empiezan las matrículas. El tipo lo dice la
   * TARJETA, cuando ya no se puede desarmar.
   */
  var ORDINALES = ['PRIMERA', 'SEGUNDA', 'TERCERA', 'CUARTA', 'QUINTA',
                   'SEXTA', 'SÉPTIMA', 'OCTAVA', 'NOVENA', 'DÉCIMA'];
  function ordinalTxt(n) {
    n = parseInt(n, 10) || 1;
    return 'LA ' + (ORDINALES[n - 1] || (n + 'ª'));
  }

  function golpeDe(ronda) {
    var total = ronda.llamadaMs || 6500;
    var falta = Math.max(0, (ronda.finTs || 0) - Reloj.ahora());
    var frac = Math.min(1, Math.max(0, 1 - falta / total));
    for (var i = 0; i < GOLPES.length; i++) {
      if (frac < GOLPES[i].hasta) return GOLPES[i];
    }
    return GOLPES[GOLPES.length - 1];
  }

  /** Pinta el golpe sobre el DOM que ya puso `renderEscenario`, sin repintar el bloque. */
  function pintarLlamada(ronda) {
    var caja = UI.id('llamada');
    var golpe = UI.id('llamadaGolpe');
    if (!caja || !golpe) return;
    var g = golpeDe(ronda);
    // Solo se toca el DOM cuando CAMBIA el golpe: la animación de entrada de cada
    // golpe se reinicia al cambiar el atributo, y tocarlo en cada tick la cortaría.
    if (caja.getAttribute('data-golpe') === g.clave) return;
    caja.setAttribute('data-golpe', g.clave);
    golpe.textContent = g.txt;
    var num = UI.id('llamadaNum');
    if (num) num.textContent = g.num;

    /*
     * El SONIDO de cada golpe, y el redoble desde «a las dos». Solo en la máquina
     * del anfitrión, como todo el sonido automático.
     *
     * ⚠️ UNA vez por golpe y por ronda: el bloque se repinta (y este atributo vuelve
     * a vacío) cada vez que cambia su firma, y sin esta marca el mismo golpe sonaría
     * de nuevo en cada repintado.
     */
    var marca = ronda.rondaId + ':' + g.clave;
    if (g.num && S.ultimoGolpe !== marca) {
      S.ultimoGolpe = marca;
      sonarSiAnfitrion(function () {
        Audio_.golpe(parseInt(g.num, 10));
        if (g.clave === 'dos') Audio_.redobleEmpezar();
      });
    }
  }

  function tick() {
    if (!S.estado || !S.estado.ronda) return;
    var ronda = S.estado.ronda;
    if (ronda.fase !== 'llamada') return;

    pintarLlamada(ronda);

    /*
     * Terminó la llamada: el servidor ya puede destapar. Se pregunta enseguida en
     * vez de esperar el próximo sondeo, o «¡a las tres!» queda colgado hasta 2 s
     * antes de que aparezca la tarjeta.
     *
     * ⚠️ UNA sola vez por llamada. El tick corre varias veces por segundo y la fase
     * no cambia hasta que el servidor conteste: sin recordar que ya se preguntó, se
     * dispara una consulta por tick — y son los segundos en que TODA la sala está
     * mirando la misma pantalla, o sea el peor momento para multiplicar los pedidos.
     */
    if (Reloj.ahora() >= ronda.finTs && S.ceroPedido !== ronda.finTs) {
      S.ceroPedido = ronda.finTs;
      pollYa();
    }
  }

  /* ── render del panel lateral ──────────────────────────────────────── */

  function render() {
    if (!S.estado) return;
    /*
     * 🔴 La ceremonia vive en el ESCENARIO (sep 2026), no en el panel.
     *
     * Hasta acá la llamada se dibujaba adentro del bloque Producción —que con la
     * ronda en curso se estiraba a lo ancho— y el destape era un overlay oscuro que
     * tapaba la pantalla entera. Con la tarjeta que ahora se QUEDA minutos, ese
     * overlay tapaba todo lo demás: el panel, «Liberar la sala», la barra. El
     * escenario es una franja propia, entre la barra y el panel, y en pantalla
     * completa es lo que se proyecta.
     */
    renderEspera();
    renderEscenario();
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
   * llega a apretar el botón nunca — y la llamada perdería su animación en cada
   * vuelta. La firma lleva solo lo que cambia la ESTRUCTURA; los golpes de la
   * llamada los alterna `pintarLlamada` sobre el DOM que ya está puesto.
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
       * decirlo: la llamada de producción, el festejo y el conteo de asistencia
       * viven acá, no en Meet. Quien cierre el portal creyendo que ya
       * está adentro de la reunión se queda sin asistencia y sin festejo, y nada
       * se lo avisa.
       */
      txt.textContent = S.enReunion
        ? 'Deje esta pantalla abierta: acá se canta la producción y se registra su asistencia.'
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
      ? 'Puede conducirla usted: use el bloque «Anfitrión».'
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

  /*
   * EL BLOQUE DEL ANFITRIÓN, con el estilo del escenario (sep 2026).
   *
   * Una ficha —foto con aro, nombre, cargo y un chip de estado— y, debajo, lo que
   * esta persona puede hacer. Vive en el PANEL y no en el escenario a propósito:
   * «Liberar la sala» no puede estar a un clic en plena ceremonia (decisión del
   * dueño), y en pantalla completa el panel queda detrás del ojito.
   *
   * Las REGLAS no cambiaron, solo cómo se ven: tomar una sala libre no pide nada;
   * sacársela a alguien presente pide la contraseña y un cargo superior; si el
   * anfitrión dejó de dar señal, cualquiera que pueda conducir la toma sin
   * contraseña. Todo eso lo decide el servidor (`puedoReclamar`, `puedoDesplazar`).
   *
   * ⚠️ «Sin señal» lo ve TODO EL MUNDO, no solo quien puede rescatar: el asesor es
   * el que más rato mira una reunión donde no pasa nada, y sin ese chip no distingue
   * "el anfitrión se cayó" de "todavía no pidió producción".
   */
  function renderAnfitrion() {
    var r = S.estado;
    var cont = UI.id('anfitrionCuerpo');
    var a = r.anfitrion;
    var mod = !!(a && a.moderadorOk);
    var firma = [
      r.soyAnfitrion ? 'yo' : (a ? 'otro' : 'nadie'),
      a ? a.nombre : '', a ? !!a.ausente : false,
      mod, r.puedoReclamar, r.puedoDesplazar
    ].join('|');

    /** La ficha de quien conduce, con su chip de estado. */
    var ficha = function (chip, claseChip) {
      return '<div class="anf-cara' + (a && a.ausente ? ' anf-caido' : '') + '">' +
        UI.avatar(a.foto, a.nombre, 'avatar-anf') +
        '<div class="anf-datos"><strong>' + UI.esc(a.nombre) + '</strong>' +
          '<span>' + UI.esc(a.cargo || '') + '</span></div>' +
        '<span class="anf-chip ' + claseChip + '">' + chip + '</span>' +
      '</div>';
    };
    var desde = a && a.desde ? '<p class="anf-nota">Conduce desde las ' + UI.hora(a.desde) + '.</p>' : '';
    // ⚠️ El icono va ESCRITO al lado del <span>, no en una variable: el auditor de
    // iconos (verify-frontend) solo resuelve los literales, y uno que no ve lo daría
    // por sobrante de `icon_names` — ahí el botón mostraría la PALABRA.
    var accion = function (id, texto) {
      return '<button class="btn-accion" id="' + id + '">' +
        '<span class="material-symbols-rounded">shield_person</span> ' + texto + '</button>';
    };

    /* ── yo conduzco ─────────────────────────────────────────────────────── */
    if (r.soyAnfitrion) {
      if (!pintarSi(cont, firma,
        ficha(mod ? 'Usted conduce' : 'Sin abrir', mod ? 'anf-chip-ok' : 'anf-chip-alerta') +
        (mod
          ? desde + '<p class="anf-nota">Su filial ya puede entrar.</p>'
          : '<div class="anf-alerta"><span class="material-symbols-rounded">lock_clock</span>' +
            '<span>Tomó la sala, pero todavía figura cerrada. Use «Abrir la sala» de la barra de arriba.</span></div>') +
        '<button class="btn btn-fantasma btn-bloque" id="btnLiberar">' +
          '<span class="material-symbols-rounded">logout</span> Liberar la sala</button>')) return;
      UI.id('btnLiberar').onclick = liberar;
      return;
    }

    /* ── la conduce otra persona ─────────────────────────────────────────── */
    if (a) {
      if (a.ausente) {
        var aviso = '<div class="anf-alerta"><span class="material-symbols-rounded">network_check</span>' +
          '<span>' + UI.esc(a.nombre) + ' dejó de responder.' +
          (r.puedoReclamar ? ' Puede tomar la sala para seguir con la reunión.'
                           : ' La reunión sigue cuando alguien de Sub Gerencia para arriba tome la sala.') +
          '</span></div>';
        if (!pintarSi(cont, firma, ficha('Sin señal', 'anf-chip-alerta') + aviso +
          (r.puedoReclamar ? accion('btnReclamar', 'Tomar la sala') : ''))) return;
        if (r.puedoReclamar) UI.id('btnReclamar').onclick = reclamar;
        return;
      }

      if (!r.puedoDesplazar) { pintarSi(cont, firma, ficha('Conduce', 'anf-chip-ok') + desde); return; }

      if (!pintarSi(cont, firma, ficha('Conduce', 'anf-chip-ok') + desde +
        '<p class="anf-nota">Su cargo es superior: puede tomarle la sala. ' +
          UI.esc(a.nombre) + ' deja de conducir, pero <strong>la videollamada no se corta</strong>.</p>' +
        '<div class="campo anf-pass">' +
          '<input type="password" id="passAnfitrion" placeholder="Confirme con su contraseña" autocomplete="current-password">' +
        '</div>' +
        accion('btnDesplazar', 'Tomar la sala'))) return;

      UI.id('btnDesplazar').onclick = desplazar;
      UI.id('passAnfitrion').onkeydown = function (e) { if (e.key === 'Enter') desplazar(); };
      return;
    }

    /* ── nadie conduce ───────────────────────────────────────────────────── */
    if (!r.puedoReclamar) {
      pintarSi(cont, firma,
        '<div class="anf-vacia"><span class="material-symbols-rounded">hourglass_top</span>' +
        '<div><strong>Esperando al anfitrión</strong>' +
        '<p>La abre un responsable de Sub Gerencia para arriba.</p></div></div>');
      return;
    }

    if (!pintarSi(cont, firma,
      '<div class="anf-vacia"><span class="material-symbols-rounded">shield_person</span>' +
      '<div><strong>Esta sala no tiene anfitrión</strong>' +
      '<p>Tómela para conducir la reunión.</p></div></div>' +
      accion('btnReclamar', 'Conducir esta reunión'))) return;

    UI.id('btnReclamar').onclick = reclamar;
  }

  /*
   * El bloque MI PRODUCCIÓN: acá solo va el aviso de arriba. Las listas y los
   * formularios los maneja el módulo `Pozo` (sep 2026, paso 3).
   *
   * 🔴 CON LA SALA CERRADA IGUAL SE PUEDE CARGAR, y esto es el punto del pozo:
   * existe para cargar ANTES de la reunión.
   */
  function renderFestejo() {
    var r = S.estado;
    pintarSi(UI.id('festejoCuerpo'), String(!!r.sala.abierta), r.sala.abierta ? '' :
      '<p class="pozo-ayuda" style="margin-bottom:10px">El festejo empieza cuando el anfitrión abra la sala. ' +
      'Mientras tanto puede dejar su producción cargada.</p>');
  }


  /* ══════════════════════════════════════════════════════════════════════
     EL ESCENARIO: la llamada, la tarjeta del destape, el historial y los
     controles del anfitrión (sep 2026, diseño del prototipo que aprobó el dueño)
     ══════════════════════════════════════════════════════════════════════

     Qué se ve:
       · LLAMADA   el número de orden, el golpe en grande y las tres marcas.
       · TARJETA   quien hizo la producción, en grande, y el detalle. Se QUEDA
                   hasta la próxima pulsación (decisión del dueño, 26-sep-2026).
       · CIERRE    «No hay más producción», con el pozo vacío.
       · y para el ANFITRIÓN, la barra de controles: Pedir producción y Repetir
         sirena, con el recordatorio del audio.

     🔴 Es un escenario CLARO en los dos temas (decisión del dueño, 28-sep): es lo
     que se proyecta. Lleva sus propios colores, como antes los llevaba el overlay.
  */

  /** «LA TERCERA» → «la tercera»: lo que va entre paréntesis en el botón. */
  function ordinalMin(n) { return ordinalTxt(n).toLowerCase(); }

  /** «¡LA TERCERA!»: el rótulo grande arriba de la tarjeta. */
  function ordinalTitulo(n) { return '¡' + ordinalTxt(n) + '!'; }

  function renderEscenario() {
    var r = S.estado, esc = UI.id('escenario');
    if (!esc || !r) return;
    var ronda = r.ronda || {};
    var fase = ronda.fase || 'idle';
    var conduce = !!(r.soyAnfitrion && r.sala.abierta);
    var hist = ronda.historial || [];

    // Qué tarjeta va: la de ahora, o una del historial que el anfitrión eligió volver a ver.
    var tarjeta = fase === 'reveal' ? ronda.itemActual : null;
    if (S.verOrdinal && fase !== 'llamada') {
      var elegida = hist.filter(function (h) { return h.ordinal === S.verOrdinal; })[0];
      if (elegida) tarjeta = elegida;
    }
    if (tarjeta) S.ultimoItem = tarjeta;   // lo que suena al apretar «Repetir sirena»

    var cierre = fase === 'fin' && !tarjeta;
    /*
     * 🔴 SOLO QUIEN CONDUCE ve el escenario (decisión del dueño, 28-sep-2026, paso 3).
     * Los demás miran la ceremonia por Meet, en la pantalla compartida del anfitrión:
     * una segunda copia en su pantalla llega con 2-3 s de diferencia y compite con esa.
     */
    var visible = conduce;
    UI.mostrar(esc, visible);
    if (!visible) return;

    /* ── el rótulo: «¡LA TERCERA!» sobre la tarjeta ─────────────────────── */
    var orden = UI.id('escOrden');
    var titulo = tarjeta && tarjeta.ordinal ? ordinalTitulo(tarjeta.ordinal) : '';
    orden.textContent = titulo;
    UI.mostrar(orden, !!titulo);

    /* ── el cuerpo ───────────────────────────────────────────────────────── */
    var cuerpo = UI.id('escCuerpo');
    if (fase === 'llamada') {
      /*
       * ⚠️ El número de orden va en el HTML (cambia por ronda, y `rondaId` está en
       * la firma); el golpe lo alterna `pintarLlamada` sobre el DOM ya puesto,
       * porque cambia por RELOJ y `pintarSi` no se enteraría.
       *
       * 🔴 Se ve EXACTAMENTE IGUAL haya producción o no, y NUNCA dice el tipo: si
       * con el pozo vacío se viera distinta, la sala sabría que no queda nada.
       */
      pintarSi(cuerpo, 'llamada|' + ronda.rondaId,
        '<div class="llamada" id="llamada" data-golpe="">' +
          '<p class="llamada-orden" id="llamadaOrden">' + UI.esc(ordinalTxt(ronda.ordinal)) + '</p>' +
          '<div class="llamada-num" id="llamadaNum" aria-hidden="true"></div>' +
          '<p class="llamada-golpe" id="llamadaGolpe" aria-live="assertive">Preparando…</p>' +
          // Tres marcas que se prenden con cada golpe: se lee desde el fondo de la sala.
          '<div class="llamada-marcas" aria-hidden="true">' +
            '<span><b>1</b> A la una</span><span><b>2</b> A las dos</span><span><b>3</b> ¡A las tres!</span>' +
          '</div>' +
        '</div>');
      pintarLlamada(ronda);
    } else if (tarjeta) {
      pintarSi(cuerpo, 'tarjeta|' + ronda.rondaId + '|' + tarjeta.ordinal + '|' + (tarjeta.ejecutivo || ''),
        tarjetaHtml(tarjeta));
    } else if (cierre) {
      pintarSi(cuerpo, 'cierre|' + ronda.rondaId,
        '<div class="esc-cierre">' +
          '<span class="material-symbols-rounded">emoji_events</span>' +
          '<h3>¡No hay más producción!</h3>' +
          '<p>¡Gran reunión, equipo! 🎉</p>' +
        '</div>');
    } else {
      // Solo el anfitrión llega acá: la sala está abierta y todavía no pidió nada.
      pintarSi(cuerpo, 'listo',
        '<div class="esc-listo">' +
          '<span class="material-symbols-rounded">campaign</span>' +
          '<p>Todo listo. Cuando quiera, pida la primera producción.</p>' +
        '</div>');
    }

    /* ── el historial: «Primera · Lucía, Segunda · Renato…» ─────────────── */
    /*
     * Solo lo YA cantado (lo manda el servidor). Se esconde durante la llamada —ahí
     * todos miran el número— y cuando tendría una sola entrada que es la misma
     * tarjeta que está en pantalla.
     */
    var eh = UI.id('escHistorial');
    var verHist = fase !== 'llamada' && (hist.length >= 2 || (hist.length === 1 && !tarjeta));
    UI.mostrar(eh, verHist);
    if (verHist) {
      var actual = tarjeta ? tarjeta.ordinal : 0;
      if (pintarSi(eh, 'hist|' + conduce + '|' + actual + '|' +
                       hist.map(function (h) { return h.ordinal + h.ejecutivo; }).join(','),
                   historialHtml(hist, actual, conduce)) && conduce) {
        Array.prototype.forEach.call(eh.querySelectorAll('[data-ordinal]'), function (b) {
          b.onclick = function () { verDelHistorial(parseInt(b.getAttribute('data-ordinal'), 10)); };
        });
      }
    }

    /* ── los controles del anfitrión ─────────────────────────────────────── */
    var dock = UI.id('escDock');
    UI.mostrar(dock, conduce);
    if (conduce) {
      var enLlamada = fase === 'llamada';
      if (pintarSi(dock, 'dock|' + enLlamada + '|' + (ronda.siguiente || 0), dockHtml(enLlamada, ronda.siguiente))) {
        // Se le pasa el BOTÓN, no el evento: pedirProduccion lo deshabilita y le
        // cambia el texto mientras la petición viaja.
        UI.id('btnPedir').onclick = function () { pedirProduccion(this); };
        UI.id('btnRepetirSirena').onclick = repetirSirena;
      }
    }
  }

  /** El anfitrión toca un nombre del historial: vuelve a mostrar esa tarjeta, solo en su pantalla. */
  function verDelHistorial(n) {
    var ronda = (S.estado && S.estado.ronda) || {};
    var deAhora = ronda.fase === 'reveal' && ronda.itemActual && ronda.itemActual.ordinal === n;
    S.verOrdinal = deAhora ? null : n;
    renderEscenario();
  }

  /*
   * LA TARJETA DEL DESTAPE.
   *
   * La jerarquía la pide la proyección (se ve por Meet, comprimida): primero QUIÉN
   * —nombre y foto en grande—, después QUÉ fue —MATRÍCULA o ABONO— y el número en el
   * rótulo de arriba. El plan, el usuario, el titular y la ciudad van en segundo
   * plano.
   *
   * ⚠️ Lo que no vino, no se pinta: una caja vacía proyectada se lee como que el
   * portal perdió el dato. (El plan rápido del CRM no pide el usuario, y una carga a
   * mano puede no traer titular.)
   *
   * 🔴 El teléfono NO está: el servidor no lo manda (`tarjetaDe_`), y esto se proyecta.
   */
  function tarjetaHtml(t) {
    var esMat = t.tipo === 'matricula';
    var usuarios = [t.alumno, t.alumno2].filter(function (x) { return !!x; });
    var cajas = '';
    if (usuarios.length) {
      cajas += '<div class="td-caja"><p class="td-etq">' + (usuarios.length > 1 ? 'Usuarios' : 'Usuario') + '</p>' +
        '<p class="td-valor" id="celUsuario">' + usuarios.map(UI.esc).join('<br>') + '</p></div>';
    }
    if (t.titular) {
      cajas += '<div class="td-caja"><p class="td-etq">Titular</p>' +
        '<p class="td-valor" id="celTitular">' + UI.esc(t.titular) + '</p></div>';
    }
    return '<article class="tarjeta-destape' + (esMat ? '' : ' es-abono') + '" id="celebracion">' +
      '<div class="td-persona">' +
        '<div class="td-foto" id="celFoto">' + UI.avatar(t.foto, t.ejecutivo, 'avatar-td') +
          (esMat ? '<span class="td-medalla"><span class="material-symbols-rounded fill">star</span></span>' : '') +
        '</div>' +
        '<p class="td-cargo" id="celCargo">' + UI.esc(t.cargo || '') + '</p>' +
        '<h3 class="td-nombre" id="celNombre">' + UI.esc(t.ejecutivo || '') + '</h3>' +
      '</div>' +
      '<div class="td-datos">' +
        '<div class="td-cabeza">' +
          '<span class="td-tipo" id="celTipo">' + (esMat ? 'MATRÍCULA' : 'ABONO') + '</span>' +
          (t.hora ? '<span class="td-hora"><span class="material-symbols-rounded">schedule</span>' +
                    UI.esc(t.hora) + '</span>' : '') +
        '</div>' +
        (t.plan ? '<div class="td-caja td-caja-plan"><p class="td-etq">Plan</p>' +
                  '<p class="td-plan" id="celPlan">' + UI.esc(t.plan) + '</p></div>' : '') +
        (cajas ? '<div class="td-par">' + cajas + '</div>' : '') +
        (t.ciudad ? '<p class="td-ciudad" id="celCiudad"><span class="material-symbols-rounded">location_on</span>' +
                    UI.esc(t.ciudad) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  function historialHtml(hist, actual, conduce) {
    var chips = hist.map(function (h) {
      var nombre = String(h.ejecutivo || '').split(' ')[0];
      var palabra = ordinalTxt(h.ordinal).replace(/^LA /, '');
      var cont = UI.avatar(h.foto, h.ejecutivo, 'avatar-mini') +
        '<span>' + UI.esc(palabra.charAt(0) + palabra.slice(1).toLowerCase()) + ' · ' + UI.esc(nombre) + '</span>';
      var cls = 'eh-chip' + (h.ordinal === actual ? ' actual' : '');
      // Solo el anfitrión puede volver a mostrar una: es SU pantalla la que se proyecta.
      return conduce
        ? '<button type="button" class="' + cls + '" data-ordinal="' + h.ordinal + '">' + cont + '</button>'
        : '<span class="' + cls + '">' + cont + '</span>';
    }).join('');
    return '<span class="eh-titulo"><span class="material-symbols-rounded">emoji_events</span> Historial</span>' +
      '<div class="eh-chips">' + chips + '</div>';
  }

  /*
   * LOS CONTROLES DEL ANFITRIÓN: dos botones y el recordatorio del audio.
   *
   * ⚠️ El botón dice SIEMPRE «Pedir producción», nunca «Siguiente» —ni siquiera
   * cuando ya hubo destapes—: un «siguiente» delataría que queda otra (decisión 07).
   * El número de abajo («la cuarta») no delata nada: con el pozo vacío la llamada
   * también tiene número. Sin número conocido (`siguiente` 0) no se muestra.
   *
   * 🔴 EL RECORDATORIO DEL AUDIO, porque sin él el fallo es mudo: el sonido sale
   * SOLO de esta máquina y les llega a los demás por Meet únicamente si comparte la
   * PESTAÑA con «También compartir el audio». Va en ámbar, NUNCA en verde: el portal
   * no puede saber si el audio se está compartiendo, así que no puede mostrarlo
   * como un estado confirmado.
   */
  function dockHtml(enLlamada, siguiente) {
    return '<button type="button" class="btn-pedir" id="btnPedir"' + (enLlamada ? ' disabled' : '') + '>' +
        '<span class="material-symbols-rounded">campaign</span>' +
        '<span class="bp-txt"><strong>' + (enLlamada ? 'Llamada en curso…' : 'Pedir producción') + '</strong>' +
          (!enLlamada && siguiente ? '<small>(' + UI.esc(ordinalMin(siguiente)) + ')</small>' : '') +
        '</span>' +
      '</button>' +
      '<button type="button" class="btn" id="btnRepetirSirena">' +
        '<span class="material-symbols-rounded">volume_up</span> Repetir sirena</button>' +
      '<p class="aviso-audio" id="avisoAudio">' +
        '<span class="material-symbols-rounded">volume_up</span>' +
        '<span>¿Compartió la pestaña con audio? En Meet, comparta <strong>esta pestaña</strong> ' +
        'y tilde «También compartir el audio».</span></p>';
  }

  /*
   * LO QUE DIJO SU JEFE de esta reunión (sep 2026, paso 3), debajo del estado.
   *
   *   · confirmada          → una línea: «✓ Confirmada por su jefe».
   *   · marcada AUSENTE     → en rojo y con el MOTIVO: es lo único que la perjudica,
   *                           y tiene que poder reclamar a tiempo.
   *   · con OBSERVACIÓN     → la ve (decisión del dueño): es una devolución para
   *                           mejorar, «mejore su iluminación».
   *   · sin revisar         → NADA. No depende de la persona y solo la inquietaría.
   *
   * Lo trae un pedido aparte (`miVerificacion`), no el sondeo de la sala: lee la
   * hoja de verificación, y el sondeo está escrito para no tocar planillas.
   */
  function verifHtml() {
    var v = S.verif;
    if (!v || !v.revisado) return '';
    var obs = v.observacion
      ? '<div class="asis-obs"><span class="material-symbols-rounded">edit_note</span><span>' +
          '<strong>Observación de su jefe</strong> (' + UI.esc(v.por || '') +
          (v.porCargo ? ' · ' + UI.esc(v.porCargo) : '') + '): «' + UI.esc(v.observacion) + '»</span></div>'
      : '';
    if (v.estado === 'AUSENTE') {
      return '<div class="aviso aviso-error asis-verif"><span class="material-symbols-rounded">event_busy</span>' +
        '<span><strong>Su jefe lo marcó ausente</strong>' +
        (v.motivo ? '<br>Motivo: ' + UI.esc(v.motivo) : '') + '</span></div>' + obs;
    }
    // 🔴 La llegada tarde que marcó el jefe (paso 4) también PERJUDICA: va en rojo y con
    // su motivo, para que pueda reclamar a tiempo. `situacion` la trae el backend nuevo.
    if (v.situacion === 'TARDE') {
      return '<div class="aviso aviso-error asis-verif"><span class="material-symbols-rounded">schedule</span>' +
        '<span><strong>Su jefe marcó su ingreso como tardío</strong>' +
        (v.motivo ? '<br>Motivo: ' + UI.esc(v.motivo) : '') + '</span></div>' + obs;
    }
    return '<p class="asis-verif-ok"><span class="material-symbols-rounded">check_circle</span> Confirmada por su jefe</p>' + obs;
  }

  function pedirVerif() {
    if (!S.sala) return;
    API.get({ accion: 'miVerificacion', token: Sesion.token })
      .then(function (r) {
        if (!r || !r.ok || !S.sala) return;
        S.verif = r.verif;
        renderAsistencia();
      })
      .catch(function () { /* se reintenta en el próximo turno del temporizador */ });
  }

  function renderAsistencia() {
    var cont = UI.id('asistenciaCuerpo');
    // `latirAsistencia` llama acá desde su respuesta: si mientras tanto se salió
    // de la sala, `S.estado` ya es null. El `.catch` de esa promesa se tragaba el
    // TypeError sin decir nada, que es peor que el error mismo.
    if (!S.estado || !S.estado.sala) return;
    if (!S.estado.sala.abierta) {
      cont.innerHTML = '<p style="font-size:13px;color:var(--txt-dim)">Se registra durante la reunión.</p>' + verifHtml();
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
      /*
       * 🔴 Si el jefe lo confirmó PUNTUAL, eso gana sobre el cálculo (paso 4,
       * decisión 19): entró a Meet a tiempo y abrió el portal después. Sin esto, la
       * tarjeta le diría «Ingreso tardío» y «Confirmada por su jefe» a la vez.
       */
      var v = S.verif;
      var tarde = S.asisTarde && !(v && v.revisado && v.situacion === 'PRESENTE');
      /*
       * ⚠️ El paréntesis del ternario NO es estético. Sin él, `+ verifHtml()` se
       * pegaba solo a la rama de «Asistencia registrada»: quien llegaba tarde no veía
       * nunca lo que dijo su jefe —ni la observación—, justo quien más la necesita.
       */
      cont.innerHTML = (tarde
        ? '<div class="aviso aviso-error">' +
            '<span class="material-symbols-rounded">running_with_errors</span>' +
            '<span><strong>Ingreso tardío</strong>' +
            (hIng ? '<br>Quedó registrado a las ' + UI.esc(hIng) + '.' : '') +
            '</span></div>'
        : '<div class="aviso aviso-ok">' +
            '<span class="material-symbols-rounded">verified</span>' +
            '<span><strong>Asistencia registrada</strong>' +
            (hIng ? '<br>Hora de ingreso: ' + UI.esc(hIng) + '.' : '') +
            '</span></div>') + verifHtml();
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
        '</span></div>' + verifHtml();
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
        '.</span></div>' + verifHtml();
      return;
    }

    cont.innerHTML = '<p style="font-size:13px;color:var(--txt-dim)">' +
      'Deje esta pantalla abierta ' + cuanto +
      ' para que quede registrada su asistencia.</p>' + verifHtml();
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
       * anticipa al anfitrión que lo próximo es la llamada. Entre su clic y la
       * respuesta de Apps Script pasan unos segundos, y el botón es lo único que
       * mira mientras tanto.
       */
      boton.innerHTML = '<span class="material-symbols-rounded girando">sync</span> Preparando…';
    }

    var restaurar = function () {
      if (!boton || !boton.isConnected) return;
      boton.disabled = false;
      boton.innerHTML = etiqueta;
    };

    /*
     * Si salió bien NO se restaura: la ronda arranca y el repintado reemplaza este
     * botón por la llamada. Restaurarlo acá haría parpadear "Pedir producción"
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
   * 🔴 Volver a la pestaña: repintar la llamada YA, sin esperar el próximo tick.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Chromium FRENA las pestañas que no están adelante: al minuto baja los
   * temporizadores a uno por segundo y, tras unos minutos de fondo, a uno por
   * MINUTO. El tick de la llamada es un `setInterval`, así que en una pestaña de
   * fondo —o en un celular con la pantalla apagada— el golpe SE CONGELA.
   *
   * Lo caro no es que se congele mientras nadie mira: es que al VOLVER puede
   * quedarse mostrando un golpe viejo hasta un minuto, y el sondeo también está
   * frenado, así que la persona vuelve al festejo y ve una pantalla que miente.
   * El síntoma que reportó el dueño: 'se quedó clavado y después pegó un salto'.
   *
   * No se puede desactivar el frenado desde la página. Lo que sí se puede es no
   * hacerle esperar ni un segundo cuando vuelve.
   */
  function alVolverAlFrente() {
    if (!S.sala) return;
    if (S.estado && S.estado.ronda && S.estado.ronda.fase === 'llamada') {
      pintarLlamada(S.estado.ronda);
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

  /* ── festejo ───────────────────────────────────────────────────────── */

  /*
   * ⚠️ Acá vivían `celebrar` y `cerrarCelebracion`, que abrían y cerraban el
   * overlay oscuro del destape. Se fueron en sep 2026: la tarjeta la pinta el
   * escenario (`renderEscenario`) y se queda; el sonido y el confeti los dispara
   * `detectarDestape`.
   */

  function repetirSirena() { if (S.ultimoItem) { Audio_.tocar(S.ultimoItem.tipo); Confeti.tirar(S.ultimoItem.tipo); } }

  return {
    entrar: entrar, salir: salir,
    activa: function () { return !!S.sala; },
    alVolverAlFrente: alVolverAlFrente,
    alEntrarAReunion: alEntrarAReunion,
    /*
     * ⚠️ El Pozo lo llama al cargar o quitar: el contador del panel ("2 esperando
     * turno") cambia sin que cambie nada del estado de la sala, así que el sondeo
     * NO lo repintaría — `pintarSi` compara una firma y esa firma no lo incluye.
     * Sin esto, la persona carga y el panel sigue diciendo que no tiene nada.
     */
    repintarFestejo: function () { if (S.estado) renderFestejo(); },
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
    ['toasts'].forEach(function (id) {
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
   * EL PANEL: en pantalla completa arranca ESCONDIDO para todos (sep 2026)
   * ════════════════════════════════════════════════════════════════════════
   *
   * En pantalla completa —que es como se proyecta la reunión— se ve el ESCENARIO:
   * la llamada, la tarjeta y, para el anfitrión, sus controles. El panel (el pozo,
   * la asistencia, el anfitrión) queda detrás del ojito.
   *
   * ⚠️ Hasta sep 2026 el panel se abría SOLO al empezar la ronda y al anfitrión le
   * arrancaba abierto: la llamada y el botón de pedir vivían ADENTRO del panel, y
   * sin abrirlo nadie veía la cuenta. Desde que viven en el escenario, abrirlo en
   * plena ceremonia solo le achicaría a la sala la tarjeta proyectada. Si alguien
   * lo abre a mano, se queda abierto y el escenario le deja lugar al costado.
   *
   * ⚠️ Nada de esto se guarda entre sesiones: alcanzaría con haberlo dejado abierto
   * una vez para que apareciera proyectado en la reunión siguiente.
   */
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

  function alternarPanel() { ponerPanel(!panelOculto()); }

  function alCambiar() {
    var el = elemento();
    // El icono lo alterna el CSS con `:fullscreen`: no hay estado que sincronizar.
    if (activa() && el) {
      mudar(el);
      ponerPanel(true);
    } else {
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
   Mi equipo — la asistencia de la gente de quien mira (sep 2026, paso 4)
   ══════════════════════════════════════════════════════════════════════════ */
var Equipo = (function () {
  /*
   * La lista vive en DOS lugares y la pinta este mismo código:
   *   · 'sala'  la pestaña «Mi equipo» adentro de la reunión: la de AHORA, en vivo,
   *             con «Todavía no entraron» y la producción del equipo sin cargar.
   *   · 'asis'  la pestaña Asistencia: otra fecha u otro turno (el Director).
   * Con dos listas escritas por separado, la misma persona se vería distinta en
   * cada una y el jefe no sabría a cuál creerle.
   *
   * 🔴 Todo lo que DECIDE algo lo decide el SERVIDOR: a quién se puede tildar, si el
   * turno sigue abierto, qué midió el portal (`medido`), qué vale hoy (`situacion`) y
   * si alguien entró después de que lo marcaran ausente. Acá solo se ordena y se
   * pinta. Si el navegador dedujera, por ejemplo, la llegada tarde con su reloj, la
   * pantalla diría una cosa y la planilla otra.
   *
   * 🔴 Lo que se escribe va EN LA FILA, nunca con `prompt()`: la reunión se proyecta,
   * una ventana del navegador queda encima de todo y algunos la bloquean.
   */
  var FRASES = ['Mejore la iluminación', 'Ambiente ruidoso', 'Cámara apagada', 'Buena presencia', 'Buena actitud'];
  /** Con más gente que esto, los equipos de abajo arrancan plegados (decisión 21). */
  var PLEGAR_DESDE = 12;
  /** La lista de la sala se refresca sola: quien no entró puede entrar en cualquier momento. */
  var REFRESCO_MS = 60 * 1000;
  var PROD_MS = 3 * 60 * 1000;

  function nuevo(cont) { return { cont: cont, d: null, abierto: {}, modo: {}, plegado: {}, enviando: false }; }
  var CTX = { sala: nuevo('equipoLista'), asis: nuevo('verifTabla') };
  var SALA = { pestana: 'equipo', timer: null, timerProd: null, pidiendo: false, prod: null, prodError: '' };

  /*
   * ⚠️ `situacion` y `medido` llegan desde el paso 4. Con un backend anterior (se
   * publican por separado) se deducen del `estado` viejo, que solo dice PRESENTE o
   * AUSENTE: la lista se ve como antes, sin la llegada tarde, en vez de romperse.
   */
  function situ(p) { return p.situacion || (p.estado === 'PRESENTE' ? 'PRESENTE' : 'AUSENTE'); }
  function medido(p) { return p.medido || (p.automatico === 'VALIDADO' ? 'PRESENTE' : 'AUSENTE'); }
  /** Lo que el jefe todavía tiene que mirar. «Entró después» vuelve a ser pendiente. */
  function pendiente(p) { return !p.revisado || !!p.entroDespues; }
  /** Lo que confirma «Confirmar los N presentes»: presente A TIEMPO según el portal y sin revisar. */
  function confirmable(p) { return !p.revisado && medido(p) === 'PRESENTE' && situ(p) === 'PRESENTE'; }

  /* Orden por lo que hay que decidir (decisión del dueño): ausentes → tarde → presentes. */
  // ENTRANDO: está en la sala y todavía no completó su minuto. Se mira, pero no apura.
  var PESO = { SIN_ENTRAR: 1, AUSENTE: 1, TARDE: 2, ENTRANDO: 2.5, PRESENTE: 3 };
  function peso(p) { return p.entroDespues ? 0 : (PESO[situ(p)] || 1); }
  function orden(a, b) {
    if (peso(a) !== peso(b)) return peso(a) - peso(b);
    if (pendiente(a) !== pendiente(b)) return pendiente(a) ? -1 : 1;
    return a.nombre < b.nombre ? -1 : (a.nombre > b.nombre ? 1 : 0);
  }

  /**
   * Agrupa por RAMA (la persona a cargo directo por la que cuelga cada uno).
   * Los directos sin gente propia van juntos arriba; cada directo CON gente es un
   * «Equipo de …» con su fila arriba y los suyos debajo.
   */
  function grupos(personas) {
    var porRama = {}, ramas = [];
    personas.forEach(function (p) {
      var r = p.rama || p.email;
      if (!porRama[r]) { porRama[r] = []; ramas.push(r); }
      porRama[r].push(p);
    });
    var directos = [], equipos = [];
    ramas.forEach(function (r) {
      var gente = porRama[r];
      var cabeza = gente.filter(function (p) { return p.email === r; })[0] || null;
      var resto = gente.filter(function (p) { return p.email !== r; }).sort(orden);
      if (!resto.length) { if (cabeza) directos.push(cabeza); return; }
      equipos.push({ rama: r, cabeza: cabeza, gente: resto,
        nombre: cabeza ? cabeza.nombre : (resto[0].ramaNombre || ''),
        cargo: cabeza ? cabeza.cargo : (resto[0].ramaCargo || '') });
    });
    return { directos: directos.sort(orden), equipos: equipos };
  }

  /** Enlace de WhatsApp. Sin un número boliviano válido, no hay botón: un enlace roto no avisa nada. */
  function waUrl(tel, texto) {
    var t = String(tel || '').replace(/\D/g, '');
    if (t.length === 8) t = '591' + t;
    if (!/^591\d{8}$/.test(t)) return '';
    return 'https://wa.me/' + t + '?text=' + encodeURIComponent(texto);
  }
  function waBoton(url, etiqueta, titulo) {
    if (!url) return '<span class="eq-sintel">Sin teléfono en la hoja</span>';
    return '<a class="btn btn-wa" href="' + UI.esc(url) + '" target="_blank" rel="noopener" title="' + UI.esc(titulo) + '">' +
      '<span class="material-symbols-rounded">chat</span> ' + UI.esc(etiqueta) + '</a>';
  }

  /* ── una fila ──────────────────────────────────────────────────────────── */

  function btnEstado(p, e, s, m) {
    var attr = e === 'PRESENTE' ? 'data-presente' : (e === 'TARDE' ? 'data-tarde' : 'data-ausente');
    var etq = e === 'PRESENTE' ? 'Presente' : (e === 'TARDE' ? 'Tarde' : 'Ausente');
    return '<span class="eq-est-col">' +
      '<button type="button" class="eq-est eq-est-' + e.toLowerCase() + (s === e ? ' activo' : '') + '" ' +
        attr + '="' + UI.esc(p.email) + '" aria-pressed="' + (s === e) + '">' + etq + '</button>' +
      // Lo que midió el portal, para que confirmar sea tocar el que ya está marcado.
      (m === e ? '<span class="eq-segun">Según el portal</span>' : '') +
    '</span>';
  }

  function linea(d, p, s) {
    var partes = [];
    if (s === 'ENTRANDO') partes.push('En la sala desde las <span class="eq-hora">' + UI.hora(p.ingreso) + '</span> · se está registrando');
    else if (p.ingreso) partes.push('<span class="eq-hora">Ingreso ' + UI.hora(p.ingreso) + '</span>');
    else if (s === 'SIN_ENTRAR') partes.push('Todavía no entró a la sala');
    else partes.push('<span class="' + (s === 'AUSENTE' ? 'eq-rojo' : '') + '">El portal no lo registró</span>');
    if (p.salas && p.salas.length) partes.push('En ' + UI.esc(p.salas.join(' · ')));
    // Quién la revisó: gana la última corrección, y sin esto dos jefes se pisan sin enterarse.
    if (p.revisado) partes.push('<span class="eq-rev">Revisado por ' + UI.esc(p.por) + (p.cuando ? ' · ' + UI.hora(p.cuando) : '') + '</span>');
    // 🔴 Y si nadie la revisó, se DICE: «sin revisar» no es lo mismo que «faltó».
    else partes.push('<span class="eq-sinrev">sin revisar</span>');
    return partes.join(' · ');
  }

  function campoTexto(attr, email, ph, max, valor) {
    return '<input type="text" class="verif-texto" ' + attr + '="' + UI.esc(email) + '" placeholder="' + UI.esc(ph) + '" ' +
      'maxlength="' + max + '" value="' + UI.esc(valor || '') + '">';
  }

  function fila(ctx, p) {
    var c = CTX[ctx], d = c.d, s = situ(p), m = medido(p);
    var edita = !!d.puedeEditar, modo = c.modo[p.email] || '';
    var e = UI.esc(p.email);

    /*
     * Presente y a tiempo, sin nada que decidir: UN renglón. Tocarlo lo abre.
     * ⚠️ Con una observación escrita queda ABIERTA: en un renglón no se vería, y el
     * jefe no sabría qué le dejaron anotado a esa persona.
     */
    if (s === 'PRESENTE' && !p.entroDespues && !p.observacion && !c.abierto[p.email] && !modo) {
      return '<div class="eq-fila eq-compacta" data-email="' + e + '">' +
        '<button type="button" class="eq-compacta-btn" data-expandir="' + e + '" title="Tocar para cambiar o anotar">' +
          UI.avatar(p.foto, p.nombre, 'avatar-mini') +
          '<span class="eq-nom">' + UI.esc(p.nombre) + '</span>' +
          '<span class="eq-dim">· ' + UI.esc(p.cargo) + '</span>' +
          (p.ingreso ? '<span class="eq-dim">· Ingreso ' + UI.hora(p.ingreso) + '</span>' : '') +
          '<span class="eq-der">' +
            (p.revisado
              ? '<span class="eq-rev">Revisado por ' + UI.esc(p.por) + (p.cuando ? ' · ' + UI.hora(p.cuando) : '') + '</span>'
              : '<span class="eq-sinrev">sin revisar</span>') +
            '<span class="material-symbols-rounded eq-tilde">check_circle</span>' +
          '</span>' +
        '</button>' +
      '</div>';
    }

    var pideMotivo = modo === 'TARDE' || modo === 'AUSENTE';
    var html = '<div class="eq-fila eq-s-' + s.toLowerCase() + (p.entroDespues ? ' eq-alerta' : '') + '" data-email="' + e + '">' +
      '<div class="eq-cab">' +
        '<span class="eq-foto eq-punto-' + (p.entroDespues ? 'ausente' : s.toLowerCase()) + '">' + UI.avatar(p.foto, p.nombre) + '</span>' +
        '<div class="eq-id">' +
          '<div><span class="eq-nom">' + UI.esc(p.nombre) + '</span> <span class="eq-dim">· ' + UI.esc(p.cargo) + '</span>' +
            (c.abierto[p.email] ? ' <button type="button" class="eq-link" data-expandir="' + e + '">cerrar</button>' : '') + '</div>' +
          '<div class="eq-linea">' + linea(d, p, s) + '</div>' +
        '</div>' +
        (edita
          ? '<div class="eq-botones">' + btnEstado(p, 'PRESENTE', s, m) + btnEstado(p, 'TARDE', s, m) + btnEstado(p, 'AUSENTE', s, m) +
              (s === 'SIN_ENTRAR' ? '<span class="eq-sinentrar">Sin entrar</span>' : '') + '</div>'
          : '<div class="eq-botones"><span class="chip ' + (s === 'PRESENTE' ? 'chip-verde' : s === 'TARDE' ? 'chip-ambar' : s === 'AUSENTE' ? 'chip-rojo' : '') + '">' +
              ({ PRESENTE: 'Presente', TARDE: 'Tarde', AUSENTE: 'Ausente', SIN_ENTRAR: 'Sin entrar', ENTRANDO: 'Entrando' }[s] || s) + '</span></div>') +
      '</div>';

    // 🔴 La franja roja de «entró después» (decisión 23). No se corrige sola: el jefe decide.
    if (p.entroDespues) {
      html += '<div class="eq-banda"><span class="material-symbols-rounded">error</span><span>' +
        'Entró a las ' + UI.hora(p.ingreso) + ', después de que lo marcaran ausente. Revise la corrección.</span></div>';
    }
    if (p.motivo && !pideMotivo) {
      html += '<div class="eq-motivo"><strong>Motivo:</strong> ' + UI.esc(p.motivo) + '</div>';
    }

    if (pideMotivo && edita) {
      html += '<div class="eq-editor verif-motivo">' +
        // Cortos a propósito: en la fila, uno largo se cortaba a la mitad del ejemplo.
        campoTexto('data-motivo', p.email, modo === 'TARDE'
          ? 'Motivo (ej. «Entró a Meet a las 8:14»)'
          : '¿Por qué faltó? (ej. «No estuvo en Meet»)', 120,
          // Si ya estaba marcado así, el motivo que ya tenía: que no tenga que reescribirlo.
          s === modo ? p.motivo : '') +
        campoTexto('data-obs', p.email, 'Observación (opcional)', 300, p.observacion) +
        '<button type="button" class="btn ' + (modo === 'AUSENTE' ? 'btn-peligro' : 'btn-primario') + '" data-guardar="' + e + '">Guardar</button>' +
        '<button type="button" class="btn" data-cancelar="1">Cancelar</button>' +
        '<span class="eq-lave">La observación la ve la persona.</span>' +
      '</div>';
    } else if (modo === 'OBS' && edita) {
      var faltaMotivo = (s === 'TARDE' || s === 'AUSENTE') && !p.motivo;
      html += '<div class="eq-editor verif-motivo">' +
        '<div class="eq-frases">' + FRASES.map(function (f) {
          return '<button type="button" class="eq-frase" data-frase="' + UI.esc(f) + '" data-email="' + e + '">«' + UI.esc(f) + '»</button>';
        }).join('') + '</div>' +
        (faltaMotivo ? campoTexto('data-motivo', p.email, 'Motivo (obligatorio)', 120, '') : '') +
        campoTexto('data-obs', p.email, 'Observación', 300, p.observacion) +
        '<button type="button" class="btn btn-primario" data-guardar-ok="' + e + '">Guardar</button>' +
        '<button type="button" class="btn" data-cancelar="1">Cancelar</button>' +
        '<span class="eq-lave">La ve la persona.</span>' +
      '</div>';
    } else if (p.observacion) {
      html += '<div class="eq-obs"><span class="material-symbols-rounded">edit_note</span><span>' +
        '<strong>Observación:</strong> «' + UI.esc(p.observacion) + '» <span class="eq-lave">· La ve la persona</span></span>' +
        (edita && s !== 'SIN_ENTRAR' ? '<button type="button" class="eq-link" data-observar="' + e + '">editar</button>' : '') +
      '</div>';
    } else if (edita && s !== 'SIN_ENTRAR') {
      html += '<button type="button" class="eq-link eq-mas" data-observar="' + e + '">+ Observación</button>';
    }
    return html + '</div>';
  }

  function botonConfirmar(ctx, clave, gente) {
    if (!CTX[ctx].d.puedeEditar) return '';
    var n = gente.filter(confirmable).length;
    if (!n) return '';
    return '<div class="eq-confirmar"><button type="button" class="btn btn-verde" data-confirmar="' + UI.esc(clave) + '">' +
      '<span class="material-symbols-rounded">check_circle</span> ' +
      (n === 1 ? 'Confirmar el presente' : 'Confirmar los ' + n + ' presentes') + '</button></div>';
  }

  /** La lista entera, agrupada. */
  function pintarLista(ctx, r) {
    var c = CTX[ctx];
    /*
     * Otra reunión (el Director cambió la fecha, o en la sala pasó el corte de las
     * 13:00): lo que estaba abierto era de la anterior. Sin esto, el editor de una
     * fila quedaba abierto en una reunión donde nadie lo abrió.
     */
    if (c.d && (c.d.fecha !== r.fecha || c.d.turno !== r.turno)) { c.modo = {}; c.abierto = {}; }
    c.d = r;
    var cont = UI.id(c.cont);
    if (!cont) return;
    var g = grupos(r.personas || []);
    var plegarPorDefecto = (r.personas || []).length > PLEGAR_DESDE;
    var html = '';
    if (g.directos.length) {
      html += '<section class="eq-grupo">' +
        (g.equipos.length ? '<h5 class="eq-gtit">Su gente directa</h5>' : '') +
        g.directos.map(function (p) { return fila(ctx, p); }).join('') +
        botonConfirmar(ctx, '__directos', g.directos) +
      '</section>';
    }
    g.equipos.forEach(function (eq) {
      var plegado = c.plegado[eq.rama] !== undefined ? c.plegado[eq.rama] : plegarPorDefecto;
      var todos = (eq.cabeza ? [eq.cabeza] : []).concat(eq.gente);
      var pend = eq.gente.filter(pendiente).length;
      html += '<section class="eq-grupo" data-rama="' + UI.esc(eq.rama) + '">' +
        '<div class="eq-gcab"><h5 class="eq-gtit">Equipo de ' + UI.esc(eq.nombre) +
          (eq.cargo ? ' <span class="eq-dim">· ' + UI.esc(eq.cargo) + '</span>' : '') + '</h5>' +
          '<button type="button" class="eq-link" data-plegar="' + UI.esc(eq.rama) + '">' +
            (plegado ? 'Ver su equipo (' + eq.gente.length + (pend ? ' · ' + pend + ' sin revisar' : '') + ')' : 'Plegar') +
            (plegado ? ' <span class="material-symbols-rounded">expand_more</span>' : ' <span class="material-symbols-rounded">expand_less</span>') + '</button>' +
        '</div>' +
        (eq.cabeza ? fila(ctx, eq.cabeza) : '') +
        (plegado ? '' : '<div class="eq-gente">' + eq.gente.map(function (p) { return fila(ctx, p); }).join('') + '</div>') +
        botonConfirmar(ctx, eq.rama, plegado ? (eq.cabeza ? [eq.cabeza] : []) : todos) +
      '</section>';
    });
    cont.innerHTML = html;

    // Si una fila tenía un campo abierto, el cursor vuelve ahí.
    var abierta = Object.keys(c.modo)[0];
    if (abierta) {
      var campo = cont.querySelector('[data-motivo="' + abierta + '"]') || cont.querySelector('[data-obs="' + abierta + '"]');
      if (campo) campo.focus();
    }
  }

  /** Cuántos quedan por revisar en lo que se ve. */
  function pendientes(ctx) {
    var d = CTX[ctx].d;
    return d && d.personas ? d.personas.filter(pendiente).length : 0;
  }

  /* ── escribir ──────────────────────────────────────────────────────────── */

  function botones(ctx, apagados) {
    var t = UI.id(CTX[ctx].cont);
    if (!t) return;
    Array.prototype.forEach.call(t.querySelectorAll('button'), function (b) { b.disabled = apagados; });
  }

  /** Lo que llega después de escribir se pinta en el lugar de donde salió el pedido. */
  function alResponder(ctx, r) {
    if (ctx === 'asis') Asistencia.pintarVerif(r); else pintarSala(r);
  }

  /*
   * 🔴 Escribe: NO se reintenta sola (ver POST_REPETIBLE) — un reintento agregaría
   * otra fila con la misma corrección. Y el doble clic haría exactamente eso: los
   * botones se apagan hasta que el servidor conteste.
   */
  function marcar(ctx, email, estado, motivo, observacion) {
    var c = CTX[ctx];
    if (c.enviando) return;
    c.enviando = true;
    botones(ctx, true);
    API.post({
      accion: 'verificarAsistencia', token: Sesion.token,
      email: email, estado: estado,
      // `presente` para un backend anterior al paso 4, que no lee `estado`.
      presente: estado !== 'AUSENTE',
      motivo: motivo || '', observacion: observacion || '',
      fecha: c.d.fecha, turno: c.d.turno
    }).then(function (r) {
      if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo guardar.', 'error'); return; }
      delete c.modo[email];
      delete c.abierto[email];
      alResponder(ctx, r);
      UI.toast({ PRESENTE: 'Marcado presente.', TARDE: 'Marcado tarde.', AUSENTE: 'Marcado ausente.' }[estado], 'ok');
    }).catch(function (e) {
      UI.toast((e && e.message) || 'Error de conexión.', 'error');
    }).then(function () {
      c.enviando = false;
      botones(ctx, false);
    });
  }

  /*
   * «Confirmar los N presentes». Se mandan los que se VEN confirmables; el servidor
   * vuelve a aplicar la regla y saltea a quien haya cambiado en el medio.
   */
  function confirmar(ctx, clave) {
    var c = CTX[ctx];
    if (c.enviando || !c.d) return;
    var g = grupos(c.d.personas || []);
    var gente = clave === '__directos' ? g.directos : (function () {
      var eq = g.equipos.filter(function (x) { return x.rama === clave; })[0];
      if (!eq) return [];
      var plegado = c.plegado[eq.rama] !== undefined ? c.plegado[eq.rama] : (c.d.personas || []).length > PLEGAR_DESDE;
      // Plegado, el botón cuenta solo lo que se ve: no se confirma a quien no se miró.
      return (eq.cabeza ? [eq.cabeza] : []).concat(plegado ? [] : eq.gente);
    })();
    var emails = gente.filter(confirmable).map(function (p) { return p.email; });
    if (!emails.length) return;
    c.enviando = true;
    botones(ctx, true);
    API.post({ accion: 'confirmarPresentes', token: Sesion.token, emails: emails,
               fecha: c.d.fecha, turno: c.d.turno })
      .then(function (r) {
        if (!r || !r.ok) { UI.toast((r && r.message) || 'No se pudo confirmar.', 'error'); return; }
        alResponder(ctx, r);
        UI.toast(r.confirmados === 1 ? 'Confirmado.' : 'Confirmados: ' + (r.confirmados || 0) + '.', 'ok');
      })
      .catch(function (e) { UI.toast((e && e.message) || 'Error de conexión.', 'error'); })
      .then(function () { c.enviando = false; botones(ctx, false); });
  }

  function valor(ctx, attr, email) {
    var campo = UI.id(CTX[ctx].cont).querySelector('[' + attr + '="' + email + '"]');
    return campo ? campo.value.trim() : '';
  }

  function persona(ctx, email) {
    var d = CTX[ctx].d;
    return d ? (d.personas || []).filter(function (p) { return p.email === email; })[0] : null;
  }

  function alClic(ctx, ev) {
    var b = ev.target.closest && ev.target.closest('button');
    if (!b) return;
    var c = CTX[ctx];
    var repintar = function () { pintarLista(ctx, c.d); };
    var email;

    if ((email = b.getAttribute('data-expandir'))) {
      if (c.abierto[email]) delete c.abierto[email]; else c.abierto[email] = true;
      delete c.modo[email];
      repintar(); return;
    }
    if ((email = b.getAttribute('data-plegar'))) {
      var actual = c.plegado[email] !== undefined ? c.plegado[email] : (c.d.personas || []).length > PLEGAR_DESDE;
      c.plegado[email] = !actual;
      repintar();
      return;
    }
    if ((email = b.getAttribute('data-confirmar'))) { confirmar(ctx, email); return; }
    if (b.getAttribute('data-cancelar')) { c.modo = {}; repintar(); return; }

    // Presente: un toque. Conserva la observación que ya tenía: tocar «Presente» no
    // puede borrar en silencio lo que otro jefe anotó.
    if ((email = b.getAttribute('data-presente'))) {
      var p = persona(ctx, email);
      if (p && p.revisado && situ(p) === 'PRESENTE' && !p.entroDespues) {
        UI.toast('Ya está confirmado.', 'info'); return;
      }
      marcar(ctx, email, 'PRESENTE', '', p ? p.observacion : '');
      return;
    }
    // Tarde y ausente PERJUDICAN: piden el motivo en la fila antes de guardar.
    if ((email = b.getAttribute('data-tarde'))) { c.modo = {}; c.modo[email] = 'TARDE'; repintar(); return; }
    if ((email = b.getAttribute('data-ausente'))) { c.modo = {}; c.modo[email] = 'AUSENTE'; repintar(); return; }
    if ((email = b.getAttribute('data-observar'))) { c.modo = {}; c.modo[email] = 'OBS'; repintar(); return; }

    if ((email = b.getAttribute('data-frase') && b.getAttribute('data-email'))) {
      var campo = UI.id(c.cont).querySelector('[data-obs="' + email + '"]');
      if (campo) {
        var f = b.getAttribute('data-frase');
        campo.value = campo.value.trim() ? campo.value.trim().replace(/[.\s]*$/, '') + '. ' + f : f;
        campo.focus();
      }
      return;
    }

    if ((email = b.getAttribute('data-guardar'))) {
      var modo = c.modo[email];
      var texto = valor(ctx, 'data-motivo', email);
      // El servidor lo exige igual; acá se avisa sin gastar un viaje.
      if (texto.length < 4) {
        UI.toast(modo === 'TARDE' ? 'Escriba el motivo para marcar la llegada tarde.' : 'Escriba el motivo para marcar ausente.', 'error');
        return;
      }
      marcar(ctx, email, modo, texto, valor(ctx, 'data-obs', email));
      return;
    }
    if ((email = b.getAttribute('data-guardar-ok'))) {
      var q = persona(ctx, email);
      if (!q) return;
      var s = situ(q);
      var est = s === 'TARDE' || s === 'AUSENTE' ? s : 'PRESENTE';
      var motivo = q.motivo || valor(ctx, 'data-motivo', email);
      if (est !== 'PRESENTE' && motivo.length < 4) { UI.toast('Escriba el motivo.', 'error'); return; }
      marcar(ctx, email, est, est === 'PRESENTE' ? '' : motivo, valor(ctx, 'data-obs', email));
    }
  }

  /* ── la pestaña «Mi equipo» de la sala ─────────────────────────────────── */

  var TXT_TURNO = { 'MAÑANA': 'Turno mañana', 'TARDE': 'Turno tarde' };

  function pintarSala(r) {
    /*
     * `data-listo`: la respuesta LLEGÓ. Sin esta marca, un check de «el asesor no
     * tiene pestañas» encuentra las pestañas escondidas —como nacen— antes de que
     * conteste el servidor y pasa siempre, diga lo que diga el código.
     */
    UI.id('salaPestanas').setAttribute('data-listo', '1');
    /*
     * 🔴 Un RECHAZO del servidor con la lista ya en pantalla NO la borra. Sin esto,
     * un error pasajero en un refresco escondía las pestañas y mostraba el pozo: al
     * jefe le desaparecía su equipo en plena reunión, como si no tuviera gente.
     */
    if (r && r.ok === false && CTX.sala.d) {
      UI.toast(r.message || 'No se pudo actualizar la lista de su equipo.', 'error');
      return;
    }
    var tiene = !!(r && r.ok && r.personas && r.personas.length);
    UI.mostrar(UI.id('salaPestanas'), tiene);
    if (!tiene) {
      // Un asesor no tiene a quién revisar: ni pestañas ni lista. Su pozo, como siempre.
      UI.mostrar(UI.id('bloqueEquipo'), false);
      UI.mostrar(UI.id('bloqueFestejo'), true);
      /*
       * 🔴 Y deja de preguntar. La lista lee dos planillas y la producción del equipo
       * lee la de Matrículas del CRM: con 40 asesores refrescando cada minuto algo
       * que para ellos siempre viene vacío, son 40 lecturas por minuto justo en la
       * reunión, cuando Apps Script está más cargado. Solo con una respuesta VÁLIDA:
       * si fue un error, se vuelve a intentar en el próximo refresco.
       */
      if (r && r.ok) apagarRefrescos();
      return;
    }
    // La producción del equipo recién se pide cuando se sabe que HAY equipo.
    if (!SALA.timerProd) {
      cargarProd();
      SALA.timerProd = setInterval(function () { if (!document.hidden) cargarProd(); }, PROD_MS);
    }
    pintarLista('sala', r);
    var ps = r.personas;
    var cuenta = function (s) { return ps.filter(function (p) { return !p.entroDespues && situ(p) === s; }).length; };
    var pend = pendientes('sala');

    UI.id('equipoSub').textContent = (TXT_TURNO[r.turno] || r.turno) +
      (r.inicioHora ? ' · ' + r.inicioHora + ':00' : '') + ' · ' + ps.length + (ps.length === 1 ? ' persona' : ' personas');
    var ausentes = cuenta('AUSENTE') + ps.filter(function (p) { return p.entroDespues; }).length;
    var chip = function (n, uno, varios, clase) {
      return n ? '<span class="chip' + (clase ? ' ' + clase : '') + '">' + n + ' ' + (n === 1 ? uno : varios) + '</span>' : '';
    };
    UI.id('equipoChips').innerHTML =
      chip(cuenta('PRESENTE'), 'presente', 'presentes', 'chip-verde') +
      chip(cuenta('TARDE'), 'tarde', 'tarde', 'chip-ambar') +
      chip(cuenta('ENTRANDO'), 'entrando', 'entrando', 'chip-azul') +
      chip(cuenta('SIN_ENTRAR'), 'sin entrar', 'sin entrar', '') +
      chip(ausentes, 'ausente', 'ausentes', 'chip-rojo') +
      '<span class="chip">' + pend + ' sin revisar</span>';
    UI.id('equipoAviso').innerHTML = r.puedeEditar ? '' :
      '<div class="aviso aviso-info"><span class="material-symbols-rounded">lock_clock</span><span>' +
      UI.esc(r.motivoCerrado || '') + '</span></div>';

    var n = UI.id('pestEquipoN');
    n.textContent = pend ? pend + ' sin revisar' : '';
    UI.mostrar(n, pend > 0);

    pintarEntrar(r);
    aplicarPestana();
  }

  /** «Todavía no entraron»: en vivo, para escribirles antes de que sea falta. */
  function pintarEntrar(r) {
    var cont = UI.id('equipoEntrar');
    if (!r.enCurso) { cont.innerHTML = ''; return; }
    var faltan = r.personas.filter(function (p) { return situ(p) === 'SIN_ENTRAR'; }).sort(orden);
    if (!faltan.length) {
      cont.innerHTML = '<div class="aviso aviso-ok"><span class="material-symbols-rounded">check_circle</span>' +
        '<span>Todo su equipo entró a la sala.</span></div>';
      return;
    }
    /*
     * ⚠️ El mensaje depende de la hora: antes del inicio, «ya empezó» es mentira y
     * el que lo recibe a las 7:45 ya no le cree al siguiente. La hora de Bolivia
     * sale del reloj alineado con el servidor, no del de la computadora.
     */
    var horaBo = parseInt(new Intl.DateTimeFormat('en-US',
      { timeZone: 'America/La_Paz', hour: 'numeric', hour12: false }).format(new Date(Reloj.ahora())), 10);
    var empezo = !r.inicioHora || horaBo >= r.inicioHora;
    var mensaje = function (p) {
      return empezo
        ? 'Hola ' + p.nombre + ', la reunión ya empezó. ¿Tiene algún inconveniente para entrar?'
        : 'Hola ' + p.nombre + ', la reunión empieza a las ' + r.inicioHora + ':00. ¿Ya se está conectando?';
    };
    cont.innerHTML = '<section class="eq-entrar">' +
      '<h5><span class="eq-latido"></span> Todavía no entraron a la sala <span class="eq-dim">· ' + faltan.length + '</span></h5>' +
      '<div class="eq-entrar-grilla">' + faltan.map(function (p) {
        return '<div class="eq-entrar-it" data-email="' + UI.esc(p.email) + '">' + UI.avatar(p.foto, p.nombre, 'avatar-mini') +
          '<span class="eq-entrar-nom"><b>' + UI.esc(p.nombre) + '</b><span class="eq-dim">' + UI.esc(p.cargo) + '</span></span>' +
          waBoton(waUrl(p.telefono, mensaje(p)),
            'WhatsApp', 'Escribirle por WhatsApp') +
        '</div>';
      }).join('') + '</div>' +
    '</section>';
  }

  /** La producción del equipo que no está en el pozo: solo para recordársela. */
  function pintarProd() {
    var cont = UI.id('equipoProd');
    if (!cont) return;
    if (SALA.prod === null) { cont.innerHTML = '<p class="pozo-vacio">Buscando en el CRM…</p>'; return; }
    if (SALA.prodError) {
      cont.innerHTML = '<p class="pozo-vacio pozo-error">No se pudo revisar el CRM: ' + UI.esc(SALA.prodError) + '</p>';
      return;
    }
    if (!SALA.prod.length) { cont.innerHTML = '<p class="pozo-vacio">Nadie de su equipo tiene producción sin cargar.</p>'; return; }
    cont.innerHTML = SALA.prod.map(function (it) {
      var abono = it.tipo === 'abono';
      return '<div class="pozo-tarjeta eq-prod-it">' +
        '<div class="pt-cab">' + UI.avatar(it.foto, it.asesor, 'avatar-mini') +
          '<span class="eq-nom">' + UI.esc(it.asesor) + '</span>' +
          '<span class="chip ' + (abono ? 'chip-ambar' : 'chip-verde') + '">' + (abono ? 'Abono' : 'Matrícula') + '</span>' +
        '</div>' +
        '<p class="pt-usuario"><span>Usuario:</span> ' + (it.alumno ? UI.esc(it.alumno) : '<em>(sin nombre)</em>') + '</p>' +
        '<p class="pt-linea">' + [it.titular ? 'Titular: ' + UI.esc(it.titular) : '', it.planTxt ? UI.esc(it.planTxt) : '',
          it.ciudad ? UI.esc(it.ciudad) : ''].filter(function (x) { return !!x; }).join(' · ') + '</p>' +
        waBoton(waUrl(it.telefonoAsesor, 'Hola ' + it.asesor + ', en el CRM está ' + (abono ? 'el abono' : 'la matrícula') +
          (it.alumno ? ' de ' + it.alumno : '') + '. Cárguela al pozo desde su portal antes de la ceremonia.'),
          'Recordarle', 'Escribirle por WhatsApp para que la cargue') +
      '</div>';
    }).join('');
  }

  function aplicarPestana() {
    var conPestanas = !UI.id('salaPestanas').classList.contains('oculto');
    var eq = conPestanas && SALA.pestana === 'equipo';
    UI.mostrar(UI.id('bloqueEquipo'), eq);
    UI.mostrar(UI.id('bloqueFestejo'), !eq);
    Array.prototype.forEach.call(document.querySelectorAll('.sala-pest'), function (b) {
      var activa = b.getAttribute('data-pest') === SALA.pestana;
      b.classList.toggle('activa', activa);
      b.setAttribute('aria-selected', activa ? 'true' : 'false');
    });
  }

  function cargarSala() {
    // Una consulta a la vez: con la planilla lenta, dos en vuelo pintarían en desorden.
    if (SALA.pidiendo) return;
    SALA.pidiendo = true;
    API.get({ accion: 'verificacion', token: Sesion.token })
      .then(pintarSala)
      .catch(function () { /* se reintenta en el próximo refresco */ })
      .then(function () { SALA.pidiendo = false; });
  }

  function cargarProd() {
    API.get({ accion: 'pozoEquipo', token: Sesion.token })
      .then(function (r) {
        if (r && r.ok) { SALA.prod = r.items || []; SALA.prodError = ''; }
        else { SALA.prod = []; SALA.prodError = (r && r.message) || 'No se pudo leer el CRM.'; }
      })
      .catch(function (e) { SALA.prod = []; SALA.prodError = (e && e.message) || 'Error de conexión.'; })
      .then(pintarProd);
  }

  /*
   * ⚠️ El refresco NO pisa una fila que se está escribiendo: repintar borraría el
   * motivo a medio tipear. Espera al próximo turno.
   */
  function refrescar() {
    if (document.hidden) return;
    if (Object.keys(CTX.sala.modo).length || CTX.sala.enviando) return;
    cargarSala();
  }

  function apagarRefrescos() {
    clearInterval(SALA.timer); clearInterval(SALA.timerProd);
    SALA.timer = SALA.timerProd = null;
  }

  return {
    pintarLista: pintarLista,
    pendientes: pendientes,
    alClic: alClic,
    /** Al entrar a una sala: la lista de ahora y la producción del equipo. */
    entrarSala: function () {
      CTX.sala = nuevo('equipoLista');
      UI.id('salaPestanas').removeAttribute('data-listo');
      SALA.prod = null; SALA.prodError = '';
      UI.id('equipoLista').innerHTML = '';
      pintarProd();
      apagarRefrescos();
      cargarSala();
      // La producción del equipo NO se pide acá: recién cuando la lista dice que hay equipo.
      SALA.timer = setInterval(refrescar, REFRESCO_MS);
    },
    salirSala: function () {
      apagarRefrescos();
      CTX.sala = nuevo('equipoLista');
      UI.mostrar(UI.id('salaPestanas'), false);
      UI.mostrar(UI.id('bloqueEquipo'), false);
      UI.mostrar(UI.id('bloqueFestejo'), true);
    },
    /*
     * 🔴 Al volver a la pestaña del portal, la lista se trae de nuevo. El jefe pasa
     * la reunión en la pestaña de Meet —el portal queda escondido y el refresco no
     * corre—, y al volver veía quién faltaba hace un minuto. Solo si hay equipo: a
     * quien no tiene, los refrescos ya se le apagaron.
     */
    alVolver: function () { if (SALA.timer) refrescar(); },
    elegirPestana: function (p) {
      SALA.pestana = p === 'produccion' ? 'produccion' : 'equipo';
      aplicarPestana();
      // Al volver a «Mi equipo» se trae lo último: puede haber entrado alguien.
      if (SALA.pestana === 'equipo') refrescar();
    }
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   Asistencia
   ══════════════════════════════════════════════════════════════════════════ */
var Asistencia = (function () {
  /*
   * ── La lista de verificación (pestaña Asistencia) ──────────────────────────
   *
   * Desde el paso 4 (sep 2026) la lista la pinta `Equipo`, el MISMO código que la
   * pestaña «Mi equipo» de la sala. Acá quedan la caja, la fecha y el turno: esta
   * pestaña sirve para revisar OTRA reunión (el Director, que no tiene plazo).
   *
   * 🔴 Todo lo que decide algo lo decide el SERVIDOR: a quién se puede tildar
   * (`personas`), si el turno sigue abierto (`puedeEditar`) y qué vale hoy para cada
   * uno (`situacion`). Si el navegador dedujera, por ejemplo, el plazo por su reloj,
   * la pantalla mostraría los botones habilitados y el servidor los rechazaría uno
   * por uno, sin que se entienda por qué.
   */
  function pintarVerif(r) {
    var caja = UI.id('verifCaja');
    /*
     * `data-listo` marca que la respuesta LLEGÓ, se muestre o no la caja.
     *
     * ⚠️ No es decoración: sin esa marca, un check que mire si la caja está escondida
     * la encuentra escondida ANTES de que el servidor conteste y pasa siempre, diga lo
     * que diga el código.
     */
    caja.setAttribute('data-listo', '1');
    /*
     * 🔴 Un RECHAZO del servidor se muestra; no se esconde la caja: "no tengo gente a
     * cargo" y "el servidor no aceptó lo que pediste" no pueden verse igual.
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

    UI.id('verifFecha').value = r.fecha;
    // El tope lo manda el servidor (ver `hoy` en verificacionLista_): una reunión que
    // todavía no pasó no se verifica, y así ni se puede elegir.
    if (r.hoy) UI.id('verifFecha').max = r.hoy;
    UI.id('verifTurno').value = r.turno;

    Equipo.pintarLista('asis', r);
    var faltan = Equipo.pendientes('asis');
    UI.id('verifSubtitulo').innerHTML = r.personas.length + ' en su equipo · ' +
      (faltan ? '<b>' + faltan + ' sin revisar</b>' : 'todos revisados');
    UI.id('verifAviso').innerHTML = r.puedeEditar ? '' :
      '<div class="aviso aviso-info"><span class="material-symbols-rounded">lock_clock</span>' +
      '<span>' + UI.esc(r.motivoCerrado) + '</span></div>';
  }

  /*
   * 🔴 Al ABRIR no se manda ni fecha ni turno: los elige el SERVIDOR, que es el único
   * que sabe qué reunión corre (y con qué reloj). La primera versión mandaba lo que
   * tenía el desplegable —MAÑANA, su primera opción— así que a las 14:00 la lista
   * abría en la reunión de la mañana, ya cerrada.
   */
  function cargarVerif(desdeControles) {
    var fecha = desdeControles ? (UI.id('verifFecha').value || '') : '';
    var turno = desdeControles ? (UI.id('verifTurno').value || '') : '';
    API.get({ accion: 'verificacion', token: Sesion.token, fecha: fecha, turno: turno })
      .then(pintarVerif)
      /*
       * 🔴 El fallo NO se traga: el jefe no puede quedarse mirando una pantalla sin
       * lista sin saber si no tiene gente a cargo o si no se pudo cargar.
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

  function alClic(ev) { Equipo.alClic('asis', ev); }

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

  return { cargar: cargar, alClic: alClic, cargarVerif: cargarVerif, pintarVerif: pintarVerif };
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
    Pozo.conectar();
    UI.id('btnVolverSalas').addEventListener('click', function () { irA('dashboard'); });
    UI.id('btnRecargarAsistencia').addEventListener('click', Asistencia.cargar);
    UI.id('btnGuardarApi').addEventListener('click', Config.guardar);
    UI.id('btnProbarApi').addEventListener('click', Config.probar);
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
      if (!document.hidden) { Sala.alVolverAlFrente(); Equipo.alVolver(); }
    });
    Pantalla.ajustarDisponibilidad();

    UI.id('linkConfig').addEventListener('click', function (ev) { ev.preventDefault(); abrirConfig(); });
    // Delegado sobre la tabla: se repinta entera en cada marcado, así que los botones
    // de cada fila no existen todavía cuando esto corre.
    UI.id('verifTabla').addEventListener('click', Asistencia.alClic);
    UI.id('equipoLista').addEventListener('click', function (ev) { Equipo.alClic('sala', ev); });
    Array.prototype.forEach.call(document.querySelectorAll('.sala-pest'), function (b) {
      b.addEventListener('click', function () { Equipo.elegirPestana(b.getAttribute('data-pest')); });
    });
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
