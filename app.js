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
    URL_POR_DEFECTO: 'https://script.google.com/macros/s/AKfycbyytAZS9cB0IazxFepsV9TbIRBABc3J28ab-txvBmSypVk6YlSXKlDiETj_ZnLiFBoVlQ/exec',

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
  function post(data) {
    var url = Cfg.url();
    if (!url) return Promise.reject(new Error('Falta configurar la dirección del backend.'));
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(data),
      redirect: 'follow'
    }).then(leer);
  }

  function get(params) {
    var url = Cfg.url();
    if (!url) return Promise.reject(new Error('Falta configurar la dirección del backend.'));
    var qs = Object.keys(params)
      .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return fetch(url + '?' + qs, { method: 'GET', redirect: 'follow' }).then(leer);
  }

  function leer(res) {
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
  var LLAVE = 'portal_token';   // sessionStorage: se cierra al cerrar la pestaña

  return {
    token: null,
    usuario: null,

    recuperar: function () {
      try { this.token = sessionStorage.getItem(LLAVE); } catch (e) { this.token = null; }
      return this.token;
    },
    guardar: function (token, usuario) {
      this.token = token; this.usuario = usuario;
      try { sessionStorage.setItem(LLAVE, token); } catch (e) {}
    },
    limpiar: function () {
      this.token = null; this.usuario = null;
      try { sessionStorage.removeItem(LLAVE); } catch (e) {}
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

  function hora(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
  }

  return { $: $, id: id, esc: esc, mostrar: mostrar, toast: toast, hora: hora };
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

  function montar(sala, usuario) {
    if (salaMontada === sala.roomCode && api) return;
    desmontar();

    var cont = UI.id('jitsiCont');
    if (!cont || !disponible()) return;

    var opciones = {
      roomName: sala.roomCode,
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
        defaultLanguage: 'es'
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

    try { api = new window.JitsiMeetExternalAPI('meet.jit.si', opciones); }
    catch (e) { api = null; return; }

    salaMontada = sala.roomCode;

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
     * Ser anfitrión en el portal NO te hace moderador en Jitsi: Jitsi gratuito
     * exige que quien abre la sala haya iniciado sesión con su cuenta de Google.
     * Si el portal destapara el video porque alguien apretó el botón, los demás
     * caerían en "esperando al moderador" sin ningún error a la vista y sin
     * saber a quién reclamarle. Por eso se espera el HECHO, que es este evento.
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

    // Si en un rato largo no llegó el rol de moderador, es casi seguro que falta
    // la sesión de Google. Se explica en vez de dejar la sala trabada en silencio.
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

  return { montar: montar, desmontar: desmontar, disponible: disponible, montada: function () { return !!api; } };
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
    // ⚠️ La asistencia se cuenta POR SALA. Sin este reset, quien pasa de una sala
    // a otra arrastra el "ya validada" de la anterior y su asistencia a la segunda
    // reunión no se registra nunca — sin ningún error a la vista.
    S.asisValidada = false;
    S.asisFaltan = null;
    S.redCaida = false;
    S.ceroPedido = null;
    poll();
    S.timerTick = setInterval(tick, 1000);
  }

  function salir() {
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
    S.estado = r;
    S.sala = r.sala;

    // El título se escribe en CADA respuesta, no solo en la primera. Antes iba
    // atado a un flag de "primera consulta": si esa fallaba —justo lo que pasa con
    // la red floja— el encabezado se quedaba en "Cargando…" para siempre, aunque
    // el resto del panel funcionara bien.
    UI.id('salaTitulo').textContent = r.sala.nombre;
    UI.id('salaManager').textContent = r.sala.manager || '';

    // El video se monta si la sala ya está abierta, o si soy yo el anfitrión que
    // todavía tiene que abrirla (necesito entrar para que Jitsi me dé moderador).
    if (r.sala.abierta || r.soyAnfitrion) {
      Jitsi.montar(r.sala, Sesion.usuario);
    } else {
      Jitsi.desmontar();
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
      mod, r.puedoReclamar
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
          'Si Jitsi no le da el control, abra <strong>meet.jit.si</strong> en otra pestaña e inicie ' +
          'sesión con su cuenta de Google. Se hace una sola vez por navegador.</p>') +
        '<button class="btn btn-peligro btn-bloque" id="btnLiberar">' +
          '<span class="material-symbols-rounded">logout</span> Liberar la sala</button>')) return;
      UI.id('btnLiberar').onclick = liberar;
      return;
    }

    if (r.anfitrion) {
      pintarSi(cont, firma,
        '<div class="dato-fila"><span class="k">A cargo</span>' +
        '<span class="v">' + UI.esc(r.anfitrion.nombre) + '</span></div>' +
        '<div class="dato-fila"><span class="k">Cargo</span>' +
        '<span class="v" style="font-size:12px">' + UI.esc(r.anfitrion.cargo || '—') + '</span></div>' +
        '<div class="dato-fila"><span class="k">Desde</span>' +
        '<span class="v">' + UI.hora(r.anfitrion.desde) + '</span></div>');
      return;
    }

    if (!r.puedoReclamar) {
      pintarSi(cont, firma, '<p style="font-size:13px;color:var(--txt-dim)">' +
        'Todavía nadie tomó esta sala. La abre un responsable de Sub Gerencia para arriba.</p>');
      return;
    }

    if (!pintarSi(cont, firma,
      '<p style="font-size:13px;color:var(--txt-dim);margin-bottom:12px">' +
        'Confirme con su contraseña para tomar el control de la reunión.</p>' +
      '<div class="campo" style="margin-bottom:10px">' +
        '<input type="password" id="passAnfitrion" placeholder="Su contraseña" autocomplete="current-password">' +
      '</div>' +
      '<button class="btn btn-primario btn-bloque" id="btnReclamar">' +
        '<span class="material-symbols-rounded">shield_person</span> Reclamar anfitrión</button>')) return;

    UI.id('btnReclamar').onclick = reclamar;
    UI.id('passAnfitrion').onkeydown = function (e) { if (e.key === 'Enter') reclamar(); };
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
    if (UI.id('btnPedir')) UI.id('btnPedir').onclick = pedirProduccion;
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
    cont.innerHTML = S.camaraOn
      ? '<div class="aviso aviso-info"><span class="material-symbols-rounded">videocam</span>' +
        '<span>Cámara encendida. ' +
        (S.asisFaltan != null ? 'Faltan ' + S.asisFaltan + ' min.' : 'Contando…') + '</span></div>'
      : '<p style="font-size:13px;color:var(--txt-dim)">' +
        'Encienda la cámara y manténgala 5 minutos para que quede registrada su asistencia.</p>';
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

  function reclamar() {
    var input = UI.id('passAnfitrion');
    var pass = input ? input.value : '';
    if (!pass) { UI.toast('Escriba su contraseña.', 'error'); return; }
    accion({ accion: 'reclamarAnfitrion', token: Sesion.token, salaId: S.sala.id, password: pass },
      function () { UI.toast('Tomó la sala. Entre a la videollamada para abrirla.', 'ok'); });
  }

  function liberar() {
    accion({ accion: 'liberarAnfitrion', token: Sesion.token, salaId: S.sala.id },
      function () { UI.toast('Sala liberada.', 'ok'); });
  }

  function pedirProduccion() {
    S.ultimoDestape = null;
    accion({ accion: 'iniciarRonda', token: Sesion.token, salaId: S.sala.id });
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
    API.post({ accion: 'confirmarModerador', token: Sesion.token, salaId: S.sala.id, esModerador: true })
      .then(function (r) {
        if (r && r.ok) { UI.toast('Sala abierta para todos.', 'ok'); pollYa(); }
      })
      .catch(function () {});
  }

  function avisarModeradorDemorado() {
    if (S.modAvisado || !S.estado || !S.estado.soyAnfitrion) return;
    if (S.estado.anfitrion && S.estado.anfitrion.moderadorOk) return;
    S.modAvisado = true;
    UI.toast('Jitsi todavía no le dio el control. Inicie sesión en meet.jit.si con su Google en otra pestaña.', 'error');
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
        S.asisFaltan = r.faltan;
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
    UI.id('celEmoji').textContent = esMat ? '🏆' : '💰';
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
    alCambiarRol: alCambiarRol,
    alCambiarCamara: alCambiarCamara,
    avisarModeradorDemorado: avisarModeradorDemorado,
    cerrarCelebracion: cerrarCelebracion,
    repetirSirena: repetirSirena
  };
})();


/* ══════════════════════════════════════════════════════════════════════════
   Dashboard
   ══════════════════════════════════════════════════════════════════════════ */
var Dashboard = (function () {
  var timer = null;

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

  function pintar(salas) {
    var cont = UI.id('grillaSalas');
    cont.innerHTML = salas.map(function (s) {
      var e = ESTADO[s.estado] || ESTADO.offline;
      return '' +
        '<button class="sala-card" data-sala="' + UI.esc(s.id) + '" style="--acento:' + UI.esc(s.color) + '">' +
          '<div class="fila-top">' +
            '<div><h3>' + UI.esc(s.nombre) + '</h3>' +
            '<div class="manager">' + UI.esc(s.manager) + '</div></div>' +
            '<span class="chip ' + e.chip + '">' +
              (s.estado === 'live' ? '<span class="latido"></span>' : '') + e.txt +
            '</span>' +
          '</div>' +
          '<div class="pie">' +
            '<span>' + UI.esc(s.badge) + '</span>' +
            '<span>' + (s.anfitrion
              ? '<span class="material-symbols-rounded" style="font-size:15px">shield_person</span> ' + UI.esc(s.anfitrion.nombre)
              : 'Sin anfitrión') + '</span>' +
          '</div>' +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(cont.querySelectorAll('.sala-card'), function (c) {
      c.onclick = function () { App.irASala(c.getAttribute('data-sala')); };
    });
  }

  return {
    activar: function () { cargar(); timer = setInterval(cargar, 12000); },
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
        '<th>Fecha</th><th>Nombre</th><th>Cargo</th><th>Sala</th><th>Hora</th><th>Estado</th>' +
      '</tr></thead><tbody>' +
      logs.map(function (l) {
        return '<tr>' +
          '<td>' + UI.esc(l.fecha) + '</td>' +
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

  function entrarApp(usuario) {
    Sesion.usuario = usuario;
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
    var btn = UI.id('loginBtn');
    avisoLogin('');

    if (!Cfg.url()) { avisoLogin('Falta configurar la dirección del backend.'); return; }

    btn.disabled = true;
    API.post({ accion: 'login', email: email, password: pass })
      .then(function (r) {
        if (!r || !r.ok) { avisoLogin((r && r.message) || 'No se pudo ingresar.'); return; }
        Sesion.guardar(r.token, r.usuario);
        UI.id('loginPass').value = '';
        entrarApp(r.usuario);
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
        if (r && r.ok) entrarApp(r.usuario);
        else mostrarLogin('');
      })
      .catch(function () { mostrarLogin(''); });
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
