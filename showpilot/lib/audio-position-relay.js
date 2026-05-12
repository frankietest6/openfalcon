// ============================================================
// ShowPilot — Audio Position Relay
// ============================================================
// Connects to the ShowPilot audio daemon's WebSocket on the FPP Pi
// and relays FPP's live playback position to all viewer phones via
// Socket.io. This is how phones stay in sync with the show speakers
// without each phone needing its own connection to the Pi.
//
// Architecture:
//   FPP Pi daemon → ONE WebSocket → ShowPilot → Socket.io → all phones
//
// Phones receive position updates every ~250ms and use playbackRate
// (±2% max) to nudge their audio into sync with FPP's actual position.
//
// This module is started by server.js after Socket.io is initialized.
// ============================================================

'use strict';

let ws = null;
let reconnectTimer = null;
let io = null;
let getConfigFn = null;
let isRunning = false;

function start(socketIo, getConfig) {
  io = socketIo;
  getConfigFn = getConfig;
  isRunning = true;
  connect();
}

function stop() {
  isRunning = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

function connect() {
  if (!isRunning) return;
  reconnectTimer = null; // clear so close/error handlers can schedule next reconnect

  // Close any existing connection before creating a new one.
  // Only close if the socket is open/closing — not if still CONNECTING,
  // which would trigger an immediate close event and re-enter connect().
  if (ws) {
    try {
      ws.removeAllListeners();
      if (ws.readyState !== 0) ws.close(); // 0 = CONNECTING — skip
    } catch (_) {}
    ws = null;
  }

  const cfg = getConfigFn();
  if (!cfg.plugin_fpp_host || cfg.audio_enabled === 0) {
    reconnectTimer = setTimeout(connect, 10000);
    return;
  }

  const daemonPort = cfg.audio_daemon_port || 8090;
  const wsUrl = `ws://${cfg.plugin_fpp_host}:${daemonPort}`;

  let WebSocket;
  for (const p of ['ws', '/opt/showpilot/node_modules/ws', __dirname + '/../node_modules/ws']) {
    try { WebSocket = require(p); break; } catch (_) {}
  }
  if (!WebSocket) {
    console.warn('[position-relay] ws not found — run npm install in ShowPilot dir, retrying in 60s');
    reconnectTimer = setTimeout(connect, 60000);
    return;
  }

  console.log(`[position-relay] connecting to daemon at ${wsUrl}`);
  const sock = new WebSocket(wsUrl);
  ws = sock;

  sock.on('open', () => {
    console.log('[position-relay] connected to daemon WebSocket');
  });

  sock.on('ping', () => {
    try { sock.pong(); } catch (_) {}
  });

  sock.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'position' && io) {
        io.emit('fppPosition', {
          playing: msg.playing,
          filename: msg.filename,
          positionSec: msg.positionSec,
          serverTimestamp: msg.serverTimestamp,
        });
      } else if (msg.type === 'syncPoint' && io) {
        console.log(`[position-relay] emitting fppSyncPoint at ${msg.positionSec?.toFixed(3)}s for "${msg.filename}"`);
        io.emit('fppSyncPoint', {
          playing: msg.playing,
          filename: msg.filename,
          positionSec: msg.positionSec,
          serverTimestamp: msg.serverTimestamp,
        });
      }
    } catch (e) { console.error('[position-relay] message error:', e.message); }
  });

  sock.on('close', () => {
    ws = null;
    if (isRunning && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, 500); // fast reconnect
    }
  });

  sock.on('error', (err) => {
    // Suppress common connection errors — daemon may not be running yet
    ws = null;
    if (isRunning && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, 10000); // 10s backoff on error
    }
  });
}

module.exports = { start, stop };
