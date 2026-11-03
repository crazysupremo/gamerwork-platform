// NextGameVoice.cs — wrapper C# pro SDK de voz do NEXT GAME, usado junto
// com NextGameVoice.jslib num build Unity WEBGL (não funciona em build
// standalone/mobile nativo — WebRTC/microfone de verdade só roda dentro do
// navegador; ver docs/INTEGRACAO-AUDIO.md pra outras opções nesse caso).
//
// Instalação:
//   1. Assets/Plugins/WebGL/NextGameVoice.jslib  (o plugin de JS)
//   2. Esse arquivo em qualquer lugar do seu projeto (ex: Assets/Scripts/)
//   3. Coloque esse componente em QUALQUER GameObject da cena (só um, não
//      duplica) — ele mesmo registra os eventos que chegam do JS.
//
// Uso:
//   NextGameVoice.Instance.JoinMatch("jogodoamigo", "partida-123");
//   NextGameVoice.Instance.OnPeerJoined += (peer) => Debug.Log(peer.username + " entrou");
//   NextGameVoice.Instance.SetMuted(true);
//   NextGameVoice.Instance.Leave();
using System;
using System.Runtime.InteropServices;
using UnityEngine;

[Serializable]
public class NextGameVoicePeer
{
    public string userId;
    public string username;
}

[Serializable]
public class NextGameVoiceConnectedData
{
    public string room;
}

// Classes auxiliares só pra (de)serializar com JsonUtility, que não lida
// bem com JSON "solto" — cada evento chega como { type, data } e o C# decide
// qual formato esperar dependendo do "type".
[Serializable]
internal class NgvEventEnvelope
{
    public string type;
    public string dataJson; // preenchido manualmente, ver OnNextGameVoiceEvent()
}

[DisallowMultipleComponent]
public class NextGameVoice : MonoBehaviour
{
    public static NextGameVoice Instance { get; private set; }

    [Tooltip("Endereço do NEXT GAME. Só muda isso se você hospedar o widget em outro domínio.")]
    public string baseUrl = "https://nextgameblue.stream";

    [Tooltip("Tamanho do widget de voz na tela, em pixels.")]
    public int widgetWidth = 220;
    public int widgetHeight = 280;

    public event Action OnReady;
    public event Action OnNeedLogin; // jogador precisa entrar com a conta NEXT GAME primeiro
    public event Action<string> OnConnected; // string = id da sala
    public event Action<NextGameVoicePeer> OnPeerJoined;
    public event Action<NextGameVoicePeer> OnPeerLeft;
    public event Action<bool> OnMutedChanged;
    public event Action OnLeft;
    public event Action<string> OnError;

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void NextGameVoice_Init(string gameObjectName, string baseUrl, string optsJson);
    [DllImport("__Internal")] private static extern void NextGameVoice_SetMuted(int muted);
    [DllImport("__Internal")] private static extern void NextGameVoice_Leave();
    [DllImport("__Internal")] private static extern void NextGameVoice_Destroy();
#endif

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    [Serializable]
    private class JoinOpts
    {
        public string mode;
        public string game;
        public string match;
        public string room;
        public string label;
        public bool muted;
        public string theme = "dark";
        public int width;
        public int height;
    }

    private void Join(JoinOpts opts)
    {
        opts.width = widgetWidth;
        opts.height = widgetHeight;
        string json = JsonUtility.ToJson(opts);
#if UNITY_WEBGL && !UNITY_EDITOR
        NextGameVoice_Init(gameObject.name, baseUrl, json);
#else
        Debug.LogWarning("[NextGameVoice] Só funciona em build WebGL (precisa de navegador de verdade pro WebRTC). No Editor/outras plataformas isso aqui não faz nada.");
#endif
    }

    /// <summary>Entra na sala de voz GERAL (compartilhada entre todo mundo que usa essa integração).</summary>
    public void JoinGeral(bool muted = false)
    {
        Join(new JoinOpts { mode = "geral", muted = muted });
    }

    /// <summary>Entra no LOBBY do seu jogo (uma sala só, compartilhada por todo mundo nesse lobby).</summary>
    /// <param name="gameKey">Identificador curto do seu jogo (ex: "jogodoamigo").</param>
    public void JoinLobby(string gameKey, bool muted = false)
    {
        Join(new JoinOpts { mode = "lobby", game = gameKey, muted = muted });
    }

    /// <summary>Entra na call de uma PARTIDA específica — todo mundo com o mesmo matchId cai na mesma sala.</summary>
    /// <param name="gameKey">Identificador curto do seu jogo.</param>
    /// <param name="matchId">Id da partida/sessão (gerado pelo seu próprio backend/jogo).</param>
    public void JoinMatch(string gameKey, string matchId, bool muted = false)
    {
        Join(new JoinOpts { mode = "match", game = gameKey, match = matchId, muted = muted });
    }

    /// <summary>Entra numa sala com id totalmente customizado, se "geral/lobby/match" não servir pro seu caso.</summary>
    public void JoinCustomRoom(string roomId, string label = null, bool muted = false)
    {
        Join(new JoinOpts { room = roomId, label = label, muted = muted });
    }

    public void SetMuted(bool muted)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        NextGameVoice_SetMuted(muted ? 1 : 0);
#endif
    }

    /// <summary>Sai da call atual (o widget continua na tela, pronto pra entrar em outra sala).</summary>
    public void Leave()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        NextGameVoice_Leave();
#endif
    }

    /// <summary>Remove o widget da tela de vez.</summary>
    public void Destroy()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        NextGameVoice_Destroy();
#endif
    }

    // Chamado pelo JS via SendMessage(gameObject.name, "OnNextGameVoiceEvent", json) —
    // ver NextGameVoice.jslib. O nome do método PRECISA bater com essa string.
    public void OnNextGameVoiceEvent(string json)
    {
        // Parse manual simples (evita depender de lib externa de JSON): o
        // formato que chega é sempre {"type":"...","data":{...}}.
        string type = ExtractStringField(json, "type");
        switch (type)
        {
            case "ready": OnReady?.Invoke(); break;
            case "need-login": OnNeedLogin?.Invoke(); break;
            case "connected": OnConnected?.Invoke(ExtractStringField(json, "room")); break;
            case "peer-joined":
                OnPeerJoined?.Invoke(new NextGameVoicePeer { userId = ExtractStringField(json, "userId"), username = ExtractStringField(json, "username") });
                break;
            case "peer-left":
                OnPeerLeft?.Invoke(new NextGameVoicePeer { userId = ExtractStringField(json, "userId"), username = ExtractStringField(json, "username") });
                break;
            case "muted-changed": OnMutedChanged?.Invoke(json.Contains("\"muted\":true")); break;
            case "left": OnLeft?.Invoke(); break;
            case "error": OnError?.Invoke(ExtractStringField(json, "message")); break;
        }
    }

    // Extrator bem simples de campo string em JSON raso — suficiente pro
    // formato fixo que o widget manda, sem puxar uma lib de JSON a mais pro
    // projeto só por causa disso. Se seu projeto já usa Newtonsoft.Json ou
    // outra lib, sinta-se à vontade pra trocar isso por um parse de verdade.
    private static string ExtractStringField(string json, string field)
    {
        string marker = "\"" + field + "\":\"";
        int start = json.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return null;
        start += marker.Length;
        int end = json.IndexOf('"', start);
        return end < 0 ? null : json.Substring(start, end - start);
    }
}
