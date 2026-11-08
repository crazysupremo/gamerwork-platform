// NextGameVoice.jslib — ponte entre Unity WebGL (C#) e o SDK JS do NEXT GAME
// (nextgame-voice.js). Só funciona em build WEBGL (roda dentro de um
// navegador de verdade — é isso que permite usar WebRTC/microfone).
//
// Instalação no projeto Unity: coloque esse arquivo em
// Assets/Plugins/WebGL/NextGameVoice.jslib (a extensão .jslib é o que o
// Unity reconhece automaticamente como plugin de JS pro build WebGL).
//
// Ver NextGameVoice.cs no mesmo pacote pro lado C#.
mergeInto(LibraryManager.library, {

  NextGameVoice_Init: function (gameObjectNamePtr, baseUrlPtr, optsJsonPtr) {
    const gameObjectName = UTF8ToString(gameObjectNamePtr);
    const baseUrl = UTF8ToString(baseUrlPtr);
    const opts = JSON.parse(UTF8ToString(optsJsonPtr));

    function emit(type, data) {
      if (typeof SendMessage === 'function') {
        SendMessage(gameObjectName, 'OnNextGameVoiceEvent', JSON.stringify({ type: type, data: data || {} }));
      }
    }

    function startWidget() {
      // Container básico: canto inferior direito da tela, por cima do canvas
      // do jogo. Ajuste a posição/estilo como preferir editando aqui — o
      // SDK só precisa de um elemento DOM pra encaixar o <iframe> dentro.
      let container = document.getElementById('nextgame-voice-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'nextgame-voice-container';
        container.style.position = 'fixed';
        container.style.bottom = '16px';
        container.style.right = '16px';
        container.style.zIndex = '99999';
        document.body.appendChild(container);
      }
      opts.container = container;
      opts.baseUrl = baseUrl || undefined;

      window.__nextGameVoiceInstance = window.NextGameVoice.init(opts);
      ['ready', 'need-login', 'connected', 'peer-joined', 'peer-left', 'muted-changed', 'left', 'error']
        .forEach(function (type) {
          window.__nextGameVoiceInstance.on(type, function (msg) { emit(type, msg); });
        });
    }

    // Carrega o SDK (nextgame-voice.js) dinamicamente se ainda não estiver
    // na página — assim não precisa editar o template index.html do build
    // WebGL só pra incluir essa tag <script> na mão.
    if (window.NextGameVoice) {
      startWidget();
    } else {
      const script = document.createElement('script');
      script.src = (baseUrl || 'https://nextgameblue.stream') + '/sdk/nextgame-voice.js';
      script.onload = startWidget;
      script.onerror = function () { emit('error', { message: 'Não foi possível carregar o SDK do NEXT GAME.' }); };
      document.head.appendChild(script);
    }
  },

  NextGameVoice_SetMuted: function (mutedInt) {
    if (window.__nextGameVoiceInstance) window.__nextGameVoiceInstance.setMuted(!!mutedInt);
  },

  NextGameVoice_Leave: function () {
    if (window.__nextGameVoiceInstance) window.__nextGameVoiceInstance.leave();
  },

  NextGameVoice_Destroy: function () {
    if (window.__nextGameVoiceInstance) {
      window.__nextGameVoiceInstance.destroy();
      window.__nextGameVoiceInstance = null;
    }
  },

});
