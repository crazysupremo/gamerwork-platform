/*!
 * NextGameVoice SDK v1.0.0
 * ------------------------------------------------------------------------
 * Embrulha o widget de voz do NEXT GAME (public/voice-widget.html) num
 * <iframe> + postMessage, com uma API JavaScript simples. Feito pra jogos
 * em navegador (HTML/JS puro, Unity WebGL, etc) integrarem chamada de voz
 * de verdade sem reimplementar WebRTC/sinalização do zero.
 *
 * Uso básico:
 *   <script src="https://nextgameblue.stream/sdk/nextgame-voice.js"></script>
 *   <script>
 *     const voice = NextGameVoice.init({
 *       container: document.getElementById('voice-slot'),
 *       mode: 'match', game: 'jogodoamigo', match: 'partida-123',
 *     });
 *     voice.on('connected', (data) => console.log('entrou na call', data));
 *     voice.on('peer-joined', (p) => console.log(p.username, 'entrou'));
 *     voice.on('peer-left', (p) => console.log(p.username, 'saiu'));
 *     voice.setMuted(true);   // muta o microfone
 *     voice.leave();          // sai da call (widget continua carregado)
 *     voice.destroy();        // remove o widget da página de vez
 *   </script>
 *
 * Documentação completa: /docs/INTEGRACAO-AUDIO.md no repositório do NEXT GAME.
 * ------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const DEFAULT_BASE_URL = (function () {
    // Se o próprio SDK foi carregado a partir do NEXT GAME (<script src=".../sdk/nextgame-voice.js">),
    // usa essa mesma origem como padrão — só precisa passar `baseUrl` explicitamente
    // se o arquivo for auto-hospedado em outro lugar.
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src || '';
      if (src.indexOf('/sdk/nextgame-voice.js') !== -1) {
        try { return new URL(src).origin; } catch (_) { /* ignora */ }
      }
    }
    return 'https://nextgameblue.stream';
  })();

  function buildWidgetUrl(opts) {
    const url = new URL('/voice-widget.html', opts.baseUrl || DEFAULT_BASE_URL);
    if (opts.room) {
      url.searchParams.set('room', opts.room);
      if (opts.label) url.searchParams.set('label', opts.label);
    } else {
      url.searchParams.set('mode', opts.mode || 'geral');
      if (opts.game) url.searchParams.set('game', opts.game);
      if (opts.match) url.searchParams.set('match', opts.match);
    }
    if (opts.muted) url.searchParams.set('muted', '1');
    if (opts.theme) url.searchParams.set('theme', opts.theme);
    return url.toString();
  }

  function NextGameVoiceInstance(opts) {
    const listeners = {}; // eventType -> [callbacks]
    const widgetOrigin = new URL(opts.baseUrl || DEFAULT_BASE_URL).origin;

    const iframe = document.createElement('iframe');
    iframe.src = buildWidgetUrl(opts);
    iframe.title = 'NEXT GAME — chat de voz';
    iframe.allow = 'microphone; autoplay';
    iframe.style.width = (opts.width || 220) + 'px';
    iframe.style.height = (opts.height || 280) + 'px';
    iframe.style.border = 'none';
    iframe.style.borderRadius = '12px';
    iframe.style.overflow = 'hidden';
    (opts.container || document.body).appendChild(iframe);

    function onMessage(e) {
      // Só aceita mensagens vindas mesmo da origem do widget (evita qualquer
      // outro iframe/aba maliciosa na mesma página forjar eventos).
      if (e.origin !== widgetOrigin) return;
      const msg = e.data;
      if (!msg || msg.source !== 'nextgame-voice') return;
      const cbs = listeners[msg.type];
      if (cbs) cbs.forEach((cb) => { try { cb(msg); } catch (_) {} });
    }
    window.addEventListener('message', onMessage);

    function send(action, value) {
      iframe.contentWindow.postMessage({ source: 'nextgame-voice-command', action, value }, widgetOrigin);
    }

    return {
      /** Escuta um evento: 'ready' | 'need-login' | 'connected' | 'peer-joined' | 'peer-left' | 'muted-changed' | 'left' | 'error' */
      on(type, cb) {
        (listeners[type] = listeners[type] || []).push(cb);
        return this;
      },
      off(type, cb) {
        if (listeners[type]) listeners[type] = listeners[type].filter((c) => c !== cb);
        return this;
      },
      /** Muta/desmuta o microfone */
      setMuted(value) { send('set-muted', !!value); },
      /** Sai da call (o iframe continua na página, só desconecta) */
      leave() { send('leave'); },
      /** Remove o widget da página de vez (chama leave() sozinho antes) */
      destroy() {
        send('leave');
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
      /** Elemento <iframe> de verdade, caso precise de acesso direto (redimensionar etc) */
      iframeEl: iframe,
    };
  }

  global.NextGameVoice = {
    /**
     * Cria e monta o widget de voz.
     * @param {Object} opts
     * @param {HTMLElement} [opts.container] onde encaixar o widget (padrão: document.body)
     * @param {string} [opts.baseUrl] origem do NEXT GAME (padrão: detecta sozinho pelo <script src>)
     * @param {string} [opts.room] id de sala customizado (ignora mode/game/match se usado)
     * @param {string} [opts.label] rótulo mostrado no widget quando usa `room` customizado
     * @param {'geral'|'lobby'|'match'} [opts.mode='geral'] tipo de sala
     * @param {string} [opts.game] identificador do seu jogo (obrigatório pra mode 'lobby'/'match')
     * @param {string} [opts.match] id da partida (obrigatório pra mode 'match')
     * @param {boolean} [opts.muted=false] entra com microfone mutado
     * @param {'dark'|'light'} [opts.theme='dark']
     * @param {number} [opts.width=220] largura do iframe em px
     * @param {number} [opts.height=280] altura do iframe em px
     */
    init(opts) {
      return NextGameVoiceInstance(opts || {});
    },
  };
})(typeof window !== 'undefined' ? window : this);
