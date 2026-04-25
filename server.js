// ============================================================
// OpenFalcon — Main server entry point
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const config = require('./config');
const { cleanupStaleViewers } = require('./lib/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.set('trust proxy', 1);
app.set('io', io);

// CORS — allow the FPP plugin UI (on its own origin) to call our API
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Simple request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (config.logLevel === 'debug' || res.statusCode >= 400) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// ============================================================
// Routes
// ============================================================

// FPP plugin endpoints — mounted at /api/plugin for the OpenFalcon plugin
app.use('/api/plugin', require('./routes/plugin'));

// Admin API (mount BEFORE /api/viewer to avoid prefix collisions)
app.use('/api/admin', require('./routes/admin'));

// Public viewer API
app.use('/api', require('./routes/viewer'));

// Viewer page at root — renders the active template through the RF-compatible renderer.
app.get('/', (req, res) => {
  try {
    const { renderTemplate, getActiveTemplate } = require('./lib/viewer-renderer');
    const { db, getConfig, getNowPlaying } = require('./lib/db');

    // Preview mode: render against a specific template's draft_html (or html
    // if no draft). Used by the visual designer's live preview iframe.
    let tpl;
    if (req.query.preview) {
      const id = parseInt(req.query.preview, 10);
      if (Number.isFinite(id)) {
        const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
        if (row) tpl = { ...row, html: row.draft_html || row.html };
      }
    }
    if (!tpl) tpl = getActiveTemplate();
    if (!tpl) {
      return res.status(500).send('<h1>No active viewer template</h1><p>Set one in admin.</p>');
    }

    const cfg = getConfig();
    const nowPlaying = getNowPlaying();

    const sequences = db.prepare(`
      SELECT id, name, display_name, artist, category, image_url,
             duration_seconds, votable, jukeboxable,
             last_played_at, plays_since_hidden
      FROM sequences
      WHERE visible = 1 AND is_psa = 0
      ORDER BY display_order, display_name
    `).all();

    const { bustSequenceCovers } = require('./lib/cover-art');
    const sequencesBusted = bustSequenceCovers(sequences);

    const voteCounts = db.prepare(`
      SELECT sequence_name, COUNT(*) AS count FROM votes
      WHERE round_id = ? GROUP BY sequence_name
    `).all(cfg.current_voting_round);

    const queue = db.prepare(`
      SELECT sequence_name, requested_at FROM jukebox_queue
      WHERE played = 0 ORDER BY requested_at ASC
    `).all();

    const html = renderTemplate(tpl.html, {
      config: cfg,
      sequences: sequencesBusted,
      voteCounts,
      queue,
      nowPlaying: nowPlaying.sequence_name,
      nextScheduled: nowPlaying.next_sequence_name,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    // Source-obfuscation deterrent. Wraps the rendered HTML in a stub that:
    //   (1) Looks like nothing-to-see-here in view-source
    //   (2) Decodes and replaces the document body via JS at runtime
    //   (3) Disables Ctrl+U / Ctrl+Shift+I shortcuts and the right-click menu
    //
    // This is a DETERRENT, not real protection. Anyone with DevTools open
    // can see the live DOM, and the encoded payload is recoverable from
    // the network tab. The goal is just to discourage casual snooping —
    // someone hitting Ctrl+U expecting easy template theft sees a joke
    // page instead of the real source.
    //
    // Disabled by default. Admin toggles in Settings → Interaction Safeguards
    // (or whichever section). Skipped automatically for the preview iframe so
    // the visual designer keeps working.
    if (cfg.viewer_source_obfuscate === 1 && !req.query.preview) {
      const encoded = Buffer.from(html, 'utf8').toString('base64');
      res.send(buildObfuscationStub(encoded));
    } else {
      res.send(html);
    }
  } catch (err) {
    console.error('Error rendering viewer page:', err);
    res.status(500).send('<h1>Error rendering viewer page</h1><pre>' + String(err.message) + '</pre>');
  }
});

// Stub HTML used when viewer_source_obfuscate is enabled. The encoded
// argument is the Base64-encoded rendered HTML; runtime JS decodes and
// replaces the document.
function buildObfuscationStub(encoded) {
  // The script runs in <head> BEFORE the body is parsed. document.open()
  // resets the document, and document.write() of the full HTML at this
  // stage is equivalent to the browser parsing the HTML directly — scripts
  // execute, DOMContentLoaded fires correctly, etc. Doing this AFTER the
  // body finishes parsing would just append text to the body without
  // executing scripts, which is what was breaking the viewer page.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<!--
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │   👋  Hey there, friend. Looking for the source code?            │
   │                                                                  │
   │   This light show's viewer page was built with love (and         │
   │   in some cases, paid for from a creator). Copying it without    │
   │   asking would be uncool. If you like the look, reach out to     │
   │   the show owner and ask — most folks are happy to share or      │
   │   point you to the original creator.                             │
   │                                                                  │
   │   The actual page renders just fine in your browser. This        │
   │   message is just here when you peek at the source. ✌️          │
   │                                                                  │
   └──────────────────────────────────────────────────────────────────┘
-->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Light Show</title>
<script>
(function(){
  var p='${encoded}';
  try {
    var bin = atob(p);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var html = new TextDecoder('utf-8').decode(bytes);
    // Replace the document. Because this script runs BEFORE the body has
    // finished parsing, document.open() + document.write() is equivalent to
    // the server having sent the real HTML — scripts in the payload execute,
    // styles apply, the page works normally.
    document.open();
    document.write(html);
    document.close();

    // Reattach casual deterrents to the new document. Done after document.close()
    // so they bind to the real page's document, not the stub's.
    document.addEventListener('keydown', function(e){
      if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); return false; }
      if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I' || e.key === 'j' || e.key === 'J')) { e.preventDefault(); return false; }
      if (e.key === 'F12') { e.preventDefault(); return false; }
    }, true);
    document.addEventListener('contextmenu', function(e){ e.preventDefault(); return false; }, true);
  } catch (e) {
    // Fallback if anything goes sideways — show a plain refresh prompt
    // so the page isn't blank.
    document.documentElement.innerHTML = '<head><title>Light Show</title></head><body style="background:#0a0e27;color:#fff;font-family:system-ui;text-align:center;padding:2rem;"><h2>Show is loading…</h2><p>If this page does not load in a few seconds, please refresh.</p><pre style="opacity:0.4;font-size:0.7rem;">' + (e && e.message || 'unknown error') + '</pre></body>';
  }
})();
</script>
</head>
<body>
<style>
  html,body{margin:0;padding:0;background:#0a0e27;color:#fff;font-family:system-ui,sans-serif;}
  .of-stub-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;}
  .of-stub-loading .pulse{width:48px;height:48px;border-radius:50%;background:#dc2626;animation:ofStubPulse 1.2s ease-in-out infinite;}
  @keyframes ofStubPulse{0%,100%{transform:scale(0.85);opacity:0.6;}50%{transform:scale(1.1);opacity:1;}}
</style>
<div class="of-stub-loading"><div class="pulse"></div><div>Loading show…</div></div>
</body>
</html>`;
}

// Static assets (CSS, JS, any future viewer assets)
app.use('/', express.static(path.join(__dirname, 'public')));

// Serve cached cover art images
// Serve cached cover art images.
// We use cache-busting via mtime in the URL (?v=<mtime>) — see lib/cover-art.js
// `bustCoverUrl()`. Long maxAge is fine because the URL changes with the file.
app.use('/covers', express.static(path.join(__dirname, 'data', 'covers'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    // Force revalidation when no cache buster present so stale URLs don't
    // hold on forever (e.g. cached <img src=/covers/24.jpg> with no ?v=).
    res.setHeader('Cache-Control', 'public, max-age=604800, must-revalidate');
  },
}));

// Admin static files (under /admin)
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// SPA fallback for admin
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, version: '0.1.0' }));

// ============================================================
// Socket.IO
// ============================================================

io.on('connection', socket => {
  // Viewers can emit 'subscribe' to confirm they want updates (noop for now)
  socket.on('subscribe', () => socket.emit('subscribed'));
});

// ============================================================
// Background tasks
// ============================================================

setInterval(cleanupStaleViewers, 60 * 1000);

setInterval(() => {
  const { getActiveViewerCount } = require('./lib/db');
  io.emit('viewerCount', { count: getActiveViewerCount() });
}, 5 * 1000);

// ============================================================
// Boot
// ============================================================

server.listen(config.port, config.host, () => {
  console.log(`OpenFalcon listening on http://${config.host}:${config.port}`);
  console.log(`Plugin endpoint: http://${config.host}:${config.port}/api/plugin`);
  console.log(`Viewer page:     http://${config.host}:${config.port}/`);
  console.log(`Admin:           http://${config.host}:${config.port}/admin/`);
  if (config.showToken === 'CHANGE_ME_TO_A_RANDOM_STRING') {
    console.warn('⚠️  Set a real showToken in config.js before pointing FPP at this server.');
  }
  if (config.jwtSecret === 'CHANGE_ME_BEFORE_RUNNING_IN_PROD') {
    console.warn('⚠️  Set a real jwtSecret in config.js before exposing to the internet.');
  }
});
