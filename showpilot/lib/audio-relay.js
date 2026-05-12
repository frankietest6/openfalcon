// ============================================================
// ShowPilot — Audio Relay
// ============================================================
// Opens exactly ONE persistent HTTP connection to FPP per song and
// fans the incoming bytes out to however many viewer listeners are
// connected. FPP sees one connection regardless of audience size —
// no SD card thrash. All listeners receive the same bytes at the
// same wall-clock moment, giving automatic sync without any offset
// math or drift correction.
//
// This is the relay model that gave perfect sync in the original
// OpenFalcon audio daemon (v0.11.0), now implemented server-side
// so FPP doesn't need Node.js installed.
//
// How it works:
//   1. Plugin reports a song started → startRelay(sequenceName)
//   2. Relay opens one fetch() to FPP's audio file endpoint
//   3. As bytes arrive from FPP, they are written to every
//      currently-connected listener response stream
//   4. Viewer hits GET /api/audio-relay/:sequence → addListener()
//      adds their res to the active relay's listener set
//   5. Song ends or FPP disconnects → stopRelay() ends all streams
//
// Late joiners receive audio from the current byte position onward
// (like tuning into a radio station mid-song). They miss the
// beginning — this is intentional and acceptable for a live show.
// The cached file endpoint remains available for full-file playback.
//
// Only one relay runs at a time. Starting a new relay (new song)
// automatically stops the previous one.
// ============================================================

const { getConfig, getSequenceByName } = require('./db');

// ---- State ----

// The currently active relay, or null when nothing is playing.
// Shape: { sequenceName, listeners: Set<res>, abortController, stopped }
let activeRelay = null;

// ---- Public API ----

/**
 * Start relaying audio for the given sequence name.
 * Called by plugin.js when a new song starts playing.
 * Safe to call even if a relay is already running — stops the old one first.
 */
function startRelay(sequenceName) {
  // Stop whatever was running before, clean slate.
  stopRelay('song changed');

  const cfg = getConfig();
  if (cfg.audio_enabled === 0) return;   // audio master kill-switch
  if (!cfg.plugin_fpp_host) return;      // no FPP connection yet

  const seq = getSequenceByName(sequenceName);
  if (!seq || !seq.media_name) return;   // sequence has no audio

  // SSRF guard — same check as the existing proxy endpoint.
  const fppHost = cfg.plugin_fpp_host;
  if (!/^(10\.|192\.168\.|169\.254\.)/.test(fppHost) &&
      !/^172\.(1[6-9]|2\d|3[01])\./.test(fppHost)) {
    console.warn('[relay] refusing non-private fppHost:', fppHost);
    return;
  }
  if (fppHost === '169.254.169.254') return;

  if (/[\\/]/.test(seq.media_name) || seq.media_name.includes('..')) {
    console.warn('[relay] refusing media_name with path traversal:', seq.media_name);
    return;
  }

  const relay = {
    sequenceName,
    mediaName: seq.media_name,
    listeners: new Set(),
    stopped: false,
    contentType: 'audio/mpeg',
    _req: null,
    _daemonRes: null,
  };
  activeRelay = relay;

  const url = `http://${fppHost}:${cfg.audio_daemon_port || 8090}/audio/${encodeURIComponent(seq.media_name)}`;
  console.log(`[relay] starting for "${sequenceName}" → ${url}`);

  _runRelay(relay, url);
}

/**
 * Stop the active relay (if any) and end all listener streams.
 * reason is just for the log line.
 */
function stopRelay(reason = 'stopped') {
  if (!activeRelay) return;
  _endRelay(activeRelay, reason);
  activeRelay = null;
}

/**
 * Add a viewer's response stream to the active relay.
 * Returns true if the listener was added, false if there is no active relay
 * (caller should fall back to cache or FPP proxy).
 */
function addListener(sequenceName, res) {
  if (!activeRelay || activeRelay.stopped) return false;
  if (activeRelay.sequenceName !== sequenceName) return false;

  // Send headers now. We don't know Content-Length (live stream).
  // Transfer-Encoding: chunked is implicit when Content-Length is absent.
  res.setHeader('Content-Type', activeRelay.contentType);
  res.setHeader('X-Audio-Source', 'relay');
  // No Cache-Control — this is a live stream, must not be cached.
  res.setHeader('Cache-Control', 'no-store');
  // Keep the connection alive and tell the browser not to buffer aggressively.
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx: disable proxy buffering
  res.status(200);

  activeRelay.listeners.add(res);

  // Clean up when the viewer disconnects (tab closed, navigated away, etc.)
  res.on('close', () => {
    if (activeRelay) activeRelay.listeners.delete(res);
  });

  return true;
}

/**
 * Returns the sequence name currently being relayed, or null.
 * Used by the route to decide relay vs cache vs FPP-proxy.
 */
function getActiveSequence() {
  return (activeRelay && !activeRelay.stopped) ? activeRelay.sequenceName : null;
}

// ---- Internal helpers ----

function _runRelay(relay, url) {
  const http = require('http');
  const parsedUrl = new URL(url);

  const req = http.get({
    hostname: parsedUrl.hostname,
    port: parseInt(parsedUrl.port) || 8090,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: { 'Connection': 'keep-alive' },
  }, (daemonRes) => {
    if (daemonRes.statusCode !== 200) {
      console.error(`[relay] daemon returned HTTP ${daemonRes.statusCode}`);
      _endRelay(relay, 'daemon error');
      return;
    }

    // Detect content type from daemon response
    const ct = (daemonRes.headers['content-type'] || '').toLowerCase();
    relay.contentType = ct.startsWith('audio/') ? ct : 'audio/mpeg';
    relay._daemonRes = daemonRes;

    console.log(`[relay] daemon connected, streaming "${relay.sequenceName}"`);

    // Direct pipe — bytes flow from daemon to all listeners with no
    // intermediate buffering. data events fire at daemon's paced rate.
    daemonRes.on('data', (chunk) => {
      if (relay.stopped) { daemonRes.destroy(); return; }
      for (const res of relay.listeners) {
        try { res.write(chunk); }
        catch (_) { relay.listeners.delete(res); }
      }
    });

    daemonRes.on('end', () => _endRelay(relay, 'stream ended'));
    daemonRes.on('error', (err) => {
      if (!relay.stopped) console.error('[relay] daemon stream error:', err.message);
      _endRelay(relay, 'daemon stream error');
    });
  });

  req.on('error', (err) => {
    if (!relay.stopped) console.error('[relay] daemon connect error:', err.message);
    _endRelay(relay, 'daemon connect error');
  });

  req.setTimeout(5000, () => {
    req.destroy();
    _endRelay(relay, 'daemon connect timeout');
  });

  relay._req = req;
}

function _endRelay(relay, reason) {
  if (relay.stopped) return;
  relay.stopped = true;

  console.log(`[relay] ending for "${relay.sequenceName}": ${reason} (${relay.listeners.size} listeners)`);

  // Stop the daemon connection
  try { if (relay._daemonRes) relay._daemonRes.destroy(); } catch (_) {}
  try { if (relay._req) relay._req.destroy(); } catch (_) {}

  // End all listener response streams cleanly.
  for (const res of relay.listeners) {
    try { res.end(); } catch (_) {}
  }
  relay.listeners.clear();
}

module.exports = { startRelay, stopRelay, addListener, getActiveSequence };
