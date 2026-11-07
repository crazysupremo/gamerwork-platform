// ---------- BLUEX SHIELD — modo automático ----------
// Basta uma linha no TOPO do ficheiro principal do jogo:
//
//     require('./bluex-shield');
//
// Não precisa preencher nada. Protege sozinho TODOS os servidores http/https
// que o jogo criar (Express, Fastify, http puro, Socket.IO, ws...), antes de
// qualquer código do jogo rodar.
//
// Desligar numa emergência sem mexer no código: variável de ambiente
// BLUEX_SHIELD=off
'use strict';

const http = require('http');
const https = require('https');
const { createShield } = require('./core');

const PATCHED = Symbol.for('bluex.shield.patched');

function start() {
  if (String(process.env.BLUEX_SHIELD || '').toLowerCase() === 'off') {
    console.log('[BLUEX SHIELD] desligado (BLUEX_SHIELD=off).');
    return null;
  }
  if (global[PATCHED]) return global[PATCHED]; // já ligado (require duas vezes)

  // Ajustes do NEXT GAME (site com muitos arquivos por página + socket.io + celulares
// atrás de CGNAT, onde vários jogadores dividem o mesmo IP): limites mais folgados
// que o padrão pra não bloquear jogador de verdade.
const shield = createShield({
    maxPerWindow: 600, // ~60 pedidos/s por IP
    maxSocketsPerIp: 40,
    maxConnectionsPerIp: 100,
    skipPaths: ['/api/health', '/healthz'],
  });
  const seen = new WeakSet();

  // Intercepta os eventos do servidor ANTES do código do jogo receber.
  for (const Server of [http.Server, https.Server]) {
    const originalEmit = Server.prototype.emit;
    Server.prototype.emit = function (event, ...args) {
      try {
        if (event === 'request') {
          const [req, res] = args;
          const r = shield.checkRequest(req);
          if (!r.ok) {
            shield.reject(res, r);
            return true; // o jogo nem fica sabendo
          }
        } else if (event === 'upgrade') {
          const [req, socket] = args;
          if (!shield.onUpgrade(req, socket)) return true;
        } else if (event === 'connection') {
          if (!seen.has(this)) {
            seen.add(this);
            shield.setTimeouts(this);
          }
          if (!shield.onConnection(args[0])) return true;
        }
      } catch (err) {
        // Se o Shield der erro, NUNCA derruba o jogo: deixa passar.
        console.error('[BLUEX SHIELD] erro interno (pedido liberado):', err && err.message);
      }
      return originalEmit.call(this, event, ...args);
    };
  }

  global[PATCHED] = shield;
  console.log('[BLUEX SHIELD] 🛡️ ativo (modo automático).');
  return shield;
}

module.exports = { shield: start(), createShield };
