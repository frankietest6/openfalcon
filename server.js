// ============================================================
// ShowPilot — Main server entry point
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./lib/config-loader');
const { cleanupStaleViewers } = require('./lib/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  // Tune for low-latency position updates
  pingInterval: 5000,
  pingTimeout: 10000,
  // Prefer WebSocket over polling for lower latency
  transports: ['websocket', 'polling'],
});

// Trust proxy: configurable so direct-exposure deployments aren't
// vulnerable to X-Forwarded-For spoofing while reverse-proxy deployments
// still get accurate client IPs. Default false in config.example.js —
// users behind a proxy must opt in. See config.example.js for details.
//
// `?? false` here protects users on older config.js files who haven't
// added this setting yet — they default to the secure choice.
app.set('trust proxy', config.trustProxy ?? false);
app.set('io', io);

// ============================================================
// Security headers via helmet
// ============================================================
// Helmet sets a sensible baseline of security headers:
//   - X-Content-Type-Options: nosniff   (prevents MIME-sniffing attacks)
//   - X-Frame-Options: SAMEORIGIN       (prevents clickjacking)
//   - Strict-Transport-Security         (when on HTTPS, forces future visits to be HTTPS)
//   - Referrer-Policy: no-referrer      (don't leak admin URLs to third parties)
//   - X-DNS-Prefetch-Control: off
//
// We disable contentSecurityPolicy because the viewer page renders
// user-authored templates that legitimately load fonts, images, and inline
// styles from anywhere. A strict CSP would break the whole point of
// custom templates. (We could add a more permissive CSP later, but that's
// a tuning exercise — for now, no CSP is safer than a wrong CSP.)
//
// crossOriginEmbedderPolicy is also off because it interferes with audio
// streaming and external embedded assets that user templates rely on.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow the FPP plugin UI (on its own origin) to call our API
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Custom response headers we want visible to cross-origin JS (the
    // browser hides non-default response headers from JS unless they
    // are in this list). X-Audio-Source surfaces "cache" vs "fpp" for
    // the viewer audio stream so admins can verify which path is being
    // used at runtime.
    res.header('Access-Control-Expose-Headers', 'X-Audio-Source');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// cookieParser must be installed BEFORE the backup router below, because
// requireAdmin needs req.cookies to verify the session JWT. We don't need
// cookieParser before plugin/viewer routes, but installing it once at
// the top is simpler than re-applying per-route.
app.use(cookieParser());

// Backup & restore API (v0.25.0+) — mounted BEFORE the global
// express.json() parser below, because backup files (with cover art)
// can run 5-50 MB and the default 1MB limit would reject them with an
// HTML 413 response. The backup router declares its own parser with a
// 100MB limit on its endpoints. Mounting here means we hit that parser
// first; the global parser never sees these requests.
//
// Why isn't the global limit just bigger? Because everywhere else in
// the app a 1MB request is comfortably above any legitimate use, and
// keeping that ceiling is a useful defense against accidental or
// adversarial blob uploads.
const backupRouter = require('./routes/backup');
const adminRouter = require('./routes/admin');
app.use('/api/admin/backup', adminRouter.requireAdmin, backupRouter);
const express2 = require('express');
app.get('/api/setup/first-boot-status', backupRouter.firstBootStatusHandler);
app.post(
  '/api/setup/restore-from-backup',
  express2.json({ limit: '100mb' }),
  backupRouter.restoreFirstBootHandler
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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

// Public unauthenticated endpoints (v0.31.0+) — currently just demo-status.
// Lives outside /api/plugin and /api/admin because it has neither bearer-token
// nor cookie auth. Read-only by design.
app.use('/api/public', require('./routes/public'));

// FPP plugin endpoints — mounted at /api/plugin for the ShowPilot plugin
app.use('/api/plugin', require('./routes/plugin'));

// Admin API (mount BEFORE /api/viewer to avoid prefix collisions).
// The backup router was already mounted above the global json parser —
// see the comment up there for why the order matters.
app.use('/api/admin', adminRouter);

// Cloudflare Tunnel admin endpoints (v0.29.0+). Mounted as a sibling of
// /api/admin/backup. Auth applied at the mount point, same pattern as
// backup. See lib/cloudflared.js for the supervisor design — this is a
// child-process implementation rather than the systemd one used by
// ShowPilot-Lite, because main has to work in Docker too.
app.use('/api/admin/cloudflared', adminRouter.requireAdmin, require('./routes/cloudflared'));

// In-app updater endpoints (v0.33.0+). Same sibling pattern as backup
// and cloudflared. The router itself handles the Docker/demoMode
// gating internally — it returns 503 with an explanation rather than
// being absent, so the UI can render an informative state.
app.use('/api/admin/updates', adminRouter.requireAdmin, require('./routes/updates'));

// Start background polling for new releases. Best-effort; if it
// errors we just don't update the cached "latest" until the next
// successful poll. Skipped when the updater is unavailable
// (Docker, demoMode) — we still want the UI to show "you're on
// vX.Y.Z" but no need to hit GitHub from those deployments.
const updater = require('./lib/updater');
if (updater.isUpdaterAvailable()) {
  updater.startBackgroundPolling();
}

// Public viewer API
app.use('/api', require('./routes/viewer'));

// ============================================================
// PWA install support (v0.23.0+)
// ============================================================
// Browsers look for /manifest.json (or one referenced via
// <link rel="manifest">) and /sw.js (service worker) at predictable
// paths. We expose: /admin-manifest.json, /viewer-manifest.json,
// /admin-icon, /viewer-icon, /sw.js. The HTML pages reference
// whichever manifest applies.
//
// All routes are gated by per-show config so installs only become
// available when the admin opts in. Admin uses fixed branding;
// viewer is configurable.
//
// IMPORTANT for installability: Android and iOS browsers will
// degrade to "shortcut to webpage" (instead of real PWA install)
// if any of these fail:
//   1. Service worker missing or has no real fetch handler
//   2. Icons can't be fetched as real images (data: URLs are
//      inconsistent across mobile browsers)
//   3. Manifest doesn't have a 192px AND 512px icon entry
// We address all three: SW responds to fetch for start_url, icons
// served as real URLs (not data: URLs even though we STORE them
// as base64 in the DB), and we declare multiple icon sizes even
// though the source image is the same — Android's installability
// check looks for these specific sizes.

// Service worker — minimal but with a real fetch handler. Mobile
// Chrome's installability check requires the SW to actually handle
// fetches for the start_url; an empty handler doesn't qualify.
// We just pass through every request (network-first, no caching),
// which satisfies the criteria without changing actual network behavior.
const PWA_SERVICE_WORKER = `
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  // Real fetch handler — responds with the network result. Without
  // this responding to the start_url, Android Chrome won't consider
  // the page installable and "Add to Home Screen" produces a shortcut
  // bookmark instead of a true PWA install.
  event.respondWith(fetch(event.request).catch(() => {
    return new Response('Network error', { status: 503 });
  }));
});
`;
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // Service-Worker-Allowed lets us register an /sw.js with broader
  // scope (root). Without this, /sw.js could only control /sw-scoped
  // requests. We want it to claim the whole origin.
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(PWA_SERVICE_WORKER);
});

// Helper: decode a stored data: URL back into raw image bytes plus
// content type. Returns null if no icon configured. The DB stores
// icons as data: URLs because that's the simplest upload path
// (single column, no separate file storage), but we serve them as
// real URLs because mobile browsers want fetchable image responses
// for installability.
function decodeStoredIcon(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  try {
    return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
  } catch {
    return null;
  }
}

// Serve the configured viewer icon as a real image URL. Mobile
// browsers that wouldn't accept data: URLs in manifest icons see
// this as a normal image response and accept it.
//
// When the user has uploaded an icon (stored as data: URL in DB),
// we decode and serve the bytes with the correct Content-Type.
// When no icon is configured, fall back to the bundled SVG monogram —
// served directly as image/svg+xml rather than redirecting to a
// favicon.ico that may or may not exist. SVG is a valid format for
// PWA manifest icons in modern browsers (Chrome 87+, Safari 17+).
// PWA fallback icon — bundled SVG monogram, loaded once at startup.
// Read from disk synchronously here (only happens at module load) so
// the route handler doesn't pay per-request file I/O. Buffer is held
// in memory; tiny (under 1KB).
const fs = require('fs');
const FALLBACK_ICON_SVG = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'public/favicons/favicon-monogram.svg'));
  } catch {
    // If the file ever goes missing, return a tiny inline SVG so the
    // route doesn't break. Better to serve a generic icon than 404.
    // This is the simplified ShowPilot mark — same shape as the favicon
    // file, so the fallback looks identical to the normal path.
    return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g transform="translate(16 16) scale(0.30)"><rect x="-5" y="-46" width="10" height="10" rx="2" fill="#F4B942"/><rect x="36" y="-5" width="10" height="10" rx="2" fill="#F4B942"/><rect x="-5" y="36" width="10" height="10" rx="2" fill="#F4B942"/><rect x="-46" y="-5" width="10" height="10" rx="2" fill="#F4B942"/><rect x="22" y="-32" width="8" height="8" rx="2" fill="#E94B7B"/><rect x="-30" y="-32" width="8" height="8" rx="2" fill="#E94B7B"/><rect x="22" y="24" width="8" height="8" rx="2" fill="#E94B7B"/><rect x="-30" y="24" width="8" height="8" rx="2" fill="#E94B7B"/><polygon points="-14,-18 -14,18 18,0" fill="#F4B942"/></g></svg>');
  }
})();

app.get('/viewer-icon', (req, res) => {
  const { getConfig } = require('./lib/db');
  const cfg = getConfig();
  const decoded = decodeStoredIcon(cfg.pwa_viewer_icon);
  if (!decoded) {
    // Serve the bundled SVG fallback directly. No redirect chain —
    // Android's installability check is fussy about icon fetches and
    // a redirect can sometimes confuse it.
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(FALLBACK_ICON_SVG);
  }
  res.setHeader('Content-Type', decoded.mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(decoded.buffer);
});

// Admin icon route — admin uses the bundled monogram SVG. Direct
// serving avoids the redirect-to-favicon.ico chain that was failing
// in v0.23.1 when no favicon.ico existed in the public root.
app.get('/admin-icon', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(FALLBACK_ICON_SVG);
});

app.get('/admin-manifest.json', (req, res) => {
  const { getConfig } = require('./lib/db');
  const cfg = getConfig();
  if (cfg.pwa_admin_enabled !== 1) {
    return res.status(404).send('Admin PWA install not enabled');
  }
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  // Three icon entries: 192, 512, and any. Android Chrome's
  // installability check specifically looks for a 192x192 AND
  // a 512x512 icon. We declare both sizes pointing at the same
  // SVG (which scales perfectly) — browser uses the SVG for any
  // requested size, scaled losslessly. Type must be image/svg+xml
  // because the route serves SVG bytes; mismatched type causes
  // Android to reject the icon and fail installability.
  res.json({
    // The 'id' field is what browsers use to uniquely identify a PWA
    // for install purposes. Without distinct IDs, two manifests on
    // the same origin clash — the browser treats them as the same app
    // and refuses to install one if the other is already installed.
    // ParkHopper and similar multi-app sites work because each app
    // declares its own ID. The ID can be any string; convention is
    // a path-like value.
    id: '/admin',
    name: 'ShowPilot Admin',
    short_name: 'ShowPilot',
    start_url: '/admin/',
    scope: '/admin/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      { src: '/admin-icon', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: '/admin-icon', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
      { src: '/admin-icon', sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
      { src: '/admin-icon', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  });
});

app.get('/viewer-manifest.json', (req, res) => {
  const { getConfig } = require('./lib/db');
  const cfg = getConfig();
  if (cfg.pwa_viewer_enabled !== 1) {
    return res.status(404).send('Viewer PWA install not enabled');
  }
  const name = (cfg.pwa_viewer_name && cfg.pwa_viewer_name.trim())
    || cfg.show_name
    || 'Light Show';
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  // Icon type must match what /viewer-icon actually serves.
  // - User uploaded an icon (data: URL): we extract the MIME from
  //   the data URL prefix; usually image/png, sometimes image/jpeg.
  // - No upload: we serve the SVG fallback as image/svg+xml.
  // Mismatch between manifest 'type' and actual Content-Type causes
  // Android Chrome to reject the icon and fail installability.
  let iconType = 'image/svg+xml';
  if (cfg.pwa_viewer_icon && cfg.pwa_viewer_icon.startsWith('data:')) {
    const m = cfg.pwa_viewer_icon.match(/^data:([^;]+);/);
    if (m) iconType = m[1];
  }
  res.json({
    // See admin manifest for the rationale on the 'id' field — it's
    // what lets the browser distinguish admin and viewer as separate
    // installable apps even though they share an origin.
    id: '/viewer',
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/viewer-icon', sizes: '192x192', type: iconType, purpose: 'any' },
      { src: '/viewer-icon', sizes: '512x512', type: iconType, purpose: 'any' },
      { src: '/viewer-icon', sizes: '192x192', type: iconType, purpose: 'maskable' },
      { src: '/viewer-icon', sizes: '512x512', type: iconType, purpose: 'maskable' },
    ],
  });
});

// Viewer page at root — renders the active template through the RF-compatible renderer.
app.get('/', (req, res) => {
  try {
    const { renderTemplate, getActiveTemplate } = require('./lib/viewer-renderer');
    const { db, getConfig, getNowPlaying, getNextUp } = require('./lib/db');
    const { logVisit } = require('./lib/visit-tracking');

    // Log this visit for analytics (skips bots and preview-mode requests).
    // Sets of_vid cookie on first visit.
    logVisit(req, res, db, '/');

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

    // Detect admin login so the viewer can render a small "Admin" pill
    // that takes logged-in admins back to the admin dashboard. Failing
    // verification (no cookie, expired, tampered) just leaves isAdmin
    // false — the pill silently doesn't render. The check is cheap;
    // we already require jwt for admin routes.
    let isAdmin = false;
    try {
      const adminToken = req.cookies[config.sessionCookieName];
      if (adminToken) {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(adminToken, config.jwtSecret);
        if (payload && payload.userId) {
          const user = db.prepare('SELECT enabled FROM users WHERE id = ?').get(payload.userId);
          if (user && user.enabled) isAdmin = true;
        }
      }
    } catch {
      // Invalid/expired token — leave isAdmin false. Don't clear the
      // cookie here; that's the admin auth path's job.
    }

    // Now-playing timer (v0.32.9+) — same convention as /api/state. Look
    // up the now-playing sequence's duration directly so PSAs / hidden /
    // cooldown sequences also get a working timer. The renderer turns
    // this into the m:ss text inside the <span data-showpilot-timer>;
    // rf-compat takes over after page load.
    let nowPlayingStartedAtIso = null;
    let nowPlayingDurationSeconds = null;
    if (nowPlaying.sequence_name && nowPlaying.started_at) {
      nowPlayingStartedAtIso = nowPlaying.started_at.replace(' ', 'T') + 'Z';
      const npRow = db.prepare(
        `SELECT duration_seconds FROM sequences WHERE name = ? LIMIT 1`
      ).get(nowPlaying.sequence_name);
      if (npRow && npRow.duration_seconds) {
        nowPlayingDurationSeconds = npRow.duration_seconds;
      }
    }

    const html = renderTemplate(tpl, {
      config: cfg,
      sequences: sequencesBusted,
      voteCounts,
      queue,
      nowPlaying: nowPlaying.sequence_name,
      nextScheduled: getNextUp(cfg, nowPlaying.sequence_name || null),
      nowPlayingStartedAtIso,
      nowPlayingDurationSeconds,
      isAdmin,
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
    // Don't leak err.message to the public-facing viewer — error messages
    // can contain template paths, regex internals, or other implementation
    // details. Server admin sees the full error in stdout; viewer sees a
    // generic page. The "request ID" doesn't actually reference anything
    // we log (we don't generate IDs) but gives the user something useful
    // to mention if they report it.
    res.status(500).send(
      '<!doctype html><html><head><title>Error</title>' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem;color:#333}' +
      'h1{font-size:1.5rem;margin-bottom:0.5rem}p{color:#666;max-width:480px;margin:0.5rem auto}</style>' +
      '</head><body>' +
      '<h1>Sorry — we hit an error rendering this page.</h1>' +
      '<p>The show server logged the details. Please try again in a moment.</p>' +
      '</body></html>'
    );
  }
});

// Stub HTML used when viewer_source_obfuscate is enabled. The encoded
// argument is the Base64-encoded rendered HTML; runtime JS decodes and
// replaces the document.
function buildObfuscationStub(encoded) {
  // Strategy: parse the decoded HTML using DOMParser, then swap the live
  // documentElement with the parsed one. This reliably replaces the entire
  // page including <head> and <body>. document.write() doesn't work mid-parse;
  // setting innerHTML doesn't run <script> tags. So we swap, then walk every
  // <script> in the new tree and clone it — cloned scripts DO execute on
  // insertion, which gives us full template script execution in document order.
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
<style>
  html,body{margin:0;padding:0;background:#0a0e27;color:#fff;font-family:system-ui,sans-serif;}
  .of-stub-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;}
  .of-stub-loading .pulse{width:48px;height:48px;border-radius:50%;background:#dc2626;animation:ofStubPulse 1.2s ease-in-out infinite;}
  @keyframes ofStubPulse{0%,100%{transform:scale(0.85);opacity:0.6;}50%{transform:scale(1.1);opacity:1;}}
</style>
</head>
<body>
<div class="of-stub-loading"><div class="pulse"></div><div>Loading show…</div></div>
<script>
(function(){
  var p='${encoded}';
  function swapDocument() {
    try {
      var bin = atob(p);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var html = new TextDecoder('utf-8').decode(bytes);

      // Parse the decoded HTML into a fresh document tree, then swap our live
      // <html> element with the parsed one. After this, the visible document
      // IS the new content — but DOMParser-created <script> tags don't auto-
      // execute, so we have to clone them to trigger execution.
      var parser = new DOMParser();
      var newDoc = parser.parseFromString(html, 'text/html');
      document.replaceChild(
        document.importNode(newDoc.documentElement, true),
        document.documentElement
      );

      // Walk every script in the now-live tree and replace each one with a
      // freshly-created equivalent. Cloned scripts execute on insertion,
      // which gives us the same behavior as if the server had sent the page
      // directly. Inline scripts run synchronously in DOM order; external
      // scripts (with src) load and run async per the browser's normal rules.
      var scriptList = [];
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) scriptList.push(scripts[i]);
      for (var j = 0; j < scriptList.length; j++) {
        var oldScript = scriptList[j];
        var newScript = document.createElement('script');
        for (var k = 0; k < oldScript.attributes.length; k++) {
          var attr = oldScript.attributes[k];
          newScript.setAttribute(attr.name, attr.value);
        }
        if (oldScript.textContent) newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      }

      // Reattach casual deterrents to the new live document.
      document.addEventListener('keydown', function(e){
        if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); return false; }
        if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I' || e.key === 'j' || e.key === 'J')) { e.preventDefault(); return false; }
        if (e.key === 'F12') { e.preventDefault(); return false; }
      }, true);
      document.addEventListener('contextmenu', function(e){ e.preventDefault(); return false; }, true);
    } catch (e) {
      console.error('Document swap failed:', e);
      document.body.innerHTML = '<div style="padding:2rem;text-align:center;font-family:system-ui;color:#fff;background:#0a0e27;min-height:100vh;"><h2>Show is loading…</h2><p>If this page does not load in a few seconds, please refresh.</p></div>';
    }
  }

  // Run after DOMContentLoaded so the stub body has finished parsing — gives
  // us a stable starting document to swap from. If DOM is already ready
  // (some browsers fire faster), run immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', swapDocument);
  } else {
    swapDocument();
  }
})();
</script>
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
app.get('/health', (req, res) => {
  // Pull current version from package.json so we don't have to edit two
  // places on every release.
  const pkg = require('./package.json');
  res.json({ ok: true, version: pkg.version });
});

// ============================================================
// Socket.IO
// ============================================================

io.on('connection', socket => {
  // Viewers can emit 'subscribe' to confirm they want updates (noop for now)
  socket.on('subscribe', () => socket.emit('subscribed'));

  // NTP-style time sync via Socket.io — much more accurate than HTTP /api/time
  // because it bypasses Cloudflare's HTTP processing overhead and has lower,
  // more consistent latency. Viewer sends {t1} and we echo back {t1, t2, t3}
  // immediately. Viewer computes: offset = ((t2-t1) + (t3-t4)) / 2
  socket.on('timesync', (msg) => {
    const t2 = Date.now();
    socket.emit('timesync', { t1: msg.t1, t2, t3: Date.now() });
  });
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
  console.log(`ShowPilot listening on http://${config.host}:${config.port}`);
  console.log(`Plugin endpoint: http://${config.host}:${config.port}/api/plugin`);
  console.log(`Viewer page:     http://${config.host}:${config.port}/`);
  console.log(`Admin:           http://${config.host}:${config.port}/admin/`);

  // Start audio position relay — connects to daemon WebSocket on FPP Pi
  // and fans FPP's live playback position to all viewer phones via Socket.io.
  // Phones use this to keep their audio in sync with the show speakers.
  try {
    const { getConfig } = require('./lib/db');
    require('./lib/audio-position-relay').start(io, getConfig);
  } catch (err) {
    console.error('[audio-position-relay] failed to start:', err.message);
  }

  try {
    require('./lib/cloudflared').autoStartIfConfigured();
  } catch (err) {
    console.error('[cloudflared] auto-start failed:', err.message);
  }
});

// Clean shutdown: tell the cloudflared supervisor to stop respawning
// and kill its child process before we exit. We hook SIGTERM/SIGINT
// because adding a listener overrides Node's default exit behavior,
// so we have to explicitly exit ourselves.
//
// PM2 reload sends SIGINT; systemd stop sends SIGTERM. Both flow
// through here. The exit hook is a belt-and-suspenders for unexpected
// process.exit() calls elsewhere (e.g. backup-restore's clean-exit
// path) — synchronous-only, can't await.
//
// If we don't clean up, a SIGKILL'd cloudflared child gets reparented
// to init and keeps running — an orphaned tunnel pointing at nothing.
function gracefulExit(signal, code) {
  try {
    require('./lib/cloudflared').shutdownHook();
  } catch {}
  // Give the SIGTERM we just sent to cloudflared a moment to land,
  // then exit. A 500ms wait isn't perfect but it's almost always enough
  // for a child process to receive the signal and start exiting.
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGTERM', () => gracefulExit('SIGTERM', 0));
process.on('SIGINT',  () => gracefulExit('SIGINT',  0));
// Synchronous-only on 'exit' — can't delay or do anything async here.
// shutdownHook is async-shaped but its only effect (kill -TERM) is sync.
process.on('exit', () => {
  try {
    require('./lib/cloudflared').shutdownHook();
  } catch {}
});
