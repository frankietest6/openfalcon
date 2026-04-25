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

    const tpl = getActiveTemplate();
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
    res.send(html);
  } catch (err) {
    console.error('Error rendering viewer page:', err);
    res.status(500).send('<h1>Error rendering viewer page</h1><pre>' + String(err.message) + '</pre>');
  }
});

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
