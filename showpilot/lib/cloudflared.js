// ============================================================
// ShowPilot — Cloudflare Tunnel integration (v0.29.0+)
// ============================================================
// Exposes ShowPilot to the public internet via a Cloudflare Tunnel.
// Operator brings their own free Cloudflare account and pastes a tunnel
// token; we run cloudflared as a managed child process inside the Node
// app (no systemd, no dpkg) so the same code works in both LXC/PM2 and
// Docker deployments.
//
// Why child process instead of systemd (like ShowPilot-Lite uses)?
// Main runs in three places: bare-metal LXC under PM2, Docker containers,
// and whatever third parties choose. Containers don't have systemd, so
// the Lite approach (cloudflared as a host-level systemd service) only
// works on a subset of main's deployment targets. Child-process supervision
// works everywhere Node runs and ties the tunnel lifecycle to ShowPilot's
// — when ShowPilot is down, the tunnel is down, which is correct because
// there's nothing to tunnel TO when ShowPilot isn't running.
//
// Why not a portable static binary instead of dpkg? Same reason — Docker
// images may not have apt available, may be slim/distroless, may not let
// us write to /usr/bin. We download the standalone Linux binary that
// Cloudflare publishes alongside the .deb and store it in data/bin/.
//
// Backup interaction: the tunnel token is a credential. It's NOT included
// in regular backups — that would put a working tunnel credential into
// every backup file the user emails around. The operator re-pastes their
// token after restore (they have it in their Cloudflare dashboard).
// ============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

// ============================================================
// Paths
// ============================================================
// data/ resolution mirrors lib/cover-art.js: hardcoded relative path,
// works in dev (./data/) and prod (./data/ which on Lite is a symlink
// to FPP's plugindata, irrelevant on main but harmless). Consistent
// with how every other module resolves data.
const DATA_DIR  = path.join(__dirname, '..', 'data');
const BIN_DIR   = path.join(DATA_DIR, 'bin');
const BIN_PATH  = path.join(BIN_DIR, 'cloudflared');
const TOKEN_FILE = path.join(DATA_DIR, 'cloudflared.json');
// Raw token file for cloudflared --token-file (v0.29.1+). Reason for
// two files: TOKEN_FILE keeps audit metadata (savedAt) we can show in
// the UI; TOKEN_RAW_FILE is consumed by cloudflared and must be the
// raw token with no JSON wrapping. Storing the metadata in the same
// file would force us to either parse JSON in cloudflared (impossible)
// or expose the metadata where cloudflared reads — both worse than
// just keeping two files. Both are mode 0600.
const TOKEN_RAW_FILE = path.join(DATA_DIR, 'cloudflared-token.txt');

const SUPPORTED_ARCHES = ['amd64', 'arm64', 'armhf'];

// Circular log buffer — keeps the last N lines for the UI's logs view.
// In-memory only; resets on restart. That's fine — anyone debugging
// "why won't my tunnel connect" is doing it right after they paste the
// token, not days later.
const LOG_BUFFER_SIZE = 300;
const logBuffer = [];

function pushLog(line) {
  // Strip trailing whitespace; keep ANSI codes since they're harmless
  // in a <pre> render.
  logBuffer.push(line.replace(/\s+$/, ''));
  while (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

// ============================================================
// Supervisor state
// ============================================================
// Mutable module-level state. There's exactly one cloudflared per
// ShowPilot instance, so a singleton here is fine and avoids passing
// state between request handlers.

let child = null;          // ChildProcess or null
let userIntent = 'stopped'; // 'running' | 'stopped' — what the operator wants
let connectedAt = null;    // Date | null — when we last saw a connection log
let lastSpawnedAt = null;
let lastExitCode = null;
let lastExitReason = null;
let respawnAttempts = 0;
let respawnTimer = null;

// Detection of a successful connection is best-effort but reliable:
// cloudflared logs `Registered tunnel connection` (or `INF Connection`
// in newer versions) once each connection is up. We watch for either.
const CONNECT_PATTERNS = [
  /Registered tunnel connection/i,
  /Connection [a-f0-9-]+ registered/i,
  /tunnel connection.*registered/i,
];

// ============================================================
// Token persistence
// ============================================================

function readToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj.token === 'string' && obj.token) ? obj.token : null;
  } catch {
    return null;
  }
}

function writeToken(token) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0600 — only owner can read. Same model as data/secrets.json.
  // Use writeFileSync with mode option AND a chmod after, in case the
  // file already exists with looser perms (writeFileSync's mode only
  // applies to new files; existing files keep their current perms).
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
  // Also write the raw-token sibling file consumed by cloudflared
  // --token-file. See TOKEN_RAW_FILE comment for why we have two files.
  fs.writeFileSync(TOKEN_RAW_FILE, token, { mode: 0o600 });
  try { fs.chmodSync(TOKEN_RAW_FILE, 0o600); } catch {}
}

function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  try { fs.unlinkSync(TOKEN_RAW_FILE); } catch {}
}

// Migrate v0.29.0 installs: if the JSON metadata file exists but the
// raw-token sibling doesn't (because the operator set their token under
// v0.29.0 which only wrote the JSON file), reconstruct the raw file
// from the JSON. Idempotent — safe to call every boot.
function migrateTokenFile() {
  if (fs.existsSync(TOKEN_FILE) && !fs.existsSync(TOKEN_RAW_FILE)) {
    const token = readToken();
    if (token) {
      try {
        fs.writeFileSync(TOKEN_RAW_FILE, token, { mode: 0o600 });
        fs.chmodSync(TOKEN_RAW_FILE, 0o600);
        pushLog('[supervisor] Migrated token to --token-file format.');
      } catch (err) {
        pushLog(`[supervisor] Token migration failed: ${err.message}`);
      }
    }
  }
}

// ============================================================
// Architecture detection
// ============================================================
// Map Node's process.arch to Cloudflare's release naming. Node uses
// 'x64', 'arm64', 'arm'; Cloudflare uses 'amd64', 'arm64', 'armhf'.
function detectArch() {
  switch (process.arch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    case 'arm': return 'armhf';
    default: return null;
  }
}

// ============================================================
// Binary install
// ============================================================
// We download the standalone Linux binary (no extension), not the .deb,
// because we want it to work in any environment where Node runs — even
// distroless / Alpine / scratch-based Docker images that don't have
// dpkg. The binary itself is statically linked.
//
// URL pattern (verified stable across years of Cloudflare releases):
//   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-<arch>

function isInstalled() {
  try {
    const st = fs.statSync(BIN_PATH);
    return st.isFile() && !!(st.mode & 0o100); // owner exec bit
  } catch {
    return false;
  }
}

// download — fetch a URL to disk, following redirects. https.get follows
// redirects only if you do it yourself, so this is recursive.
function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ShowPilot-cloudflared-installer' } }, res => {
      // Follow redirects (Cloudflare release URLs redirect to S3 CDN)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume(); // discard body
        return resolve(download(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const fileStream = fs.createWriteStream(destPath, { mode: 0o755 });
      pipeline(res, fileStream).then(resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Download timed out'));
    });
  });
}

async function install() {
  if (isInstalled()) {
    return { ok: true, alreadyInstalled: true };
  }
  const arch = detectArch();
  if (!arch || !SUPPORTED_ARCHES.includes(arch)) {
    return { ok: false, error: `Unsupported architecture: ${process.arch}. cloudflared is only available for amd64, arm64, and armhf Linux.` };
  }
  if (process.platform !== 'linux') {
    return { ok: false, error: `Cloudflare Tunnel integration only supports Linux hosts. Detected: ${process.platform}.` };
  }
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  const tmpPath = BIN_PATH + '.partial';
  try {
    await download(url, tmpPath);
    // Atomic rename so we never end up with a half-downloaded binary
    // sitting at the canonical path.
    fs.renameSync(tmpPath, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, error: `Download failed: ${err.message}` };
  }
  if (!isInstalled()) {
    return { ok: false, error: 'Binary was downloaded but is not executable. Check filesystem permissions.' };
  }
  return { ok: true, alreadyInstalled: false };
}

async function uninstallBinary() {
  // We don't refuse to uninstall while running — but we DO stop first
  // so we don't unlink an open file (which is harmless on Linux but
  // confusing).
  await stop();
  try { fs.unlinkSync(BIN_PATH); } catch {}
  return { ok: true };
}

// ============================================================
// Supervisor
// ============================================================
// Spawn cloudflared with the configured token. If it dies unexpectedly
// (and userIntent is still 'running'), respawn with exponential backoff.
// If the operator clicks Stop, userIntent becomes 'stopped' and we don't
// respawn even on graceful exit.

function getVersion(callback) {
  if (!isInstalled()) return callback(null);
  const proc = spawn(BIN_PATH, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.on('error', () => callback(null));
  proc.on('close', () => callback(out.split('\n')[0].trim() || null));
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
}

function spawnTunnel() {
  const token = readToken();
  if (!token) {
    pushLog('[supervisor] No token set; not spawning.');
    return false;
  }
  if (!isInstalled()) {
    pushLog('[supervisor] cloudflared binary not installed; not spawning.');
    return false;
  }
  if (child && !child.killed && child.exitCode === null) {
    pushLog('[supervisor] Already running; spawn skipped.');
    return true;
  }

  // Kill any orphaned cloudflared processes from previous ShowPilot runs.
  // These accumulate when PM2 restart doesn't give enough time for graceful
  // shutdown. Find by token file path and kill them before spawning.
  try {
    const { execSync } = require('child_process');
    const result = execSync(`pgrep -f "cloudflared.*${TOKEN_RAW_FILE}" 2>/dev/null || true`).toString().trim();
    if (result) {
      const pids = result.split('\n').filter(Boolean);
      let killed = 0;
      for (const pid of pids) {
        try { process.kill(parseInt(pid), 'SIGTERM'); killed++; } catch (_) {}
      }
      if (killed > 0) {
        pushLog(`[supervisor] Killed ${killed} orphaned cloudflared process(es)`);
        // Brief blocking wait only when we actually killed something
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) { /* spin */ }
      }
    }
  } catch (_) {}

  // --no-autoupdate keeps cloudflared from trying to update itself. We
  // manage the binary ourselves (operator clicks "Update" if we add that
  // later); a self-updating subprocess that swaps its own binary while
  // we're trying to supervise it is a recipe for confusion.
  //
  // --token-file (NOT --token) was added in v0.29.1 as a security fix:
  // command-line args are world-readable via /proc/<pid>/cmdline and
  // ps -ef, so any process on the host (any user) could read the token
  // out of argv. The token-file path is mode 0600 and only readable by
  // the owner running ShowPilot. cloudflared has supported --token-file
  // since v2023.7.0; we require it.
  if (!fs.existsSync(TOKEN_RAW_FILE)) {
    // Defensive — readToken() succeeded but the raw file is missing.
    // Recreate it so cloudflared can read it. This shouldn't happen in
    // normal flow because writeToken/migrateTokenFile keep them in sync.
    try {
      fs.writeFileSync(TOKEN_RAW_FILE, token, { mode: 0o600 });
      fs.chmodSync(TOKEN_RAW_FILE, 0o600);
    } catch (err) {
      pushLog(`[supervisor] Couldn't write raw token file: ${err.message}`);
      return false;
    }
  }
  const args = ['tunnel', '--no-autoupdate', 'run', '--token-file', TOKEN_RAW_FILE];
  lastSpawnedAt = new Date();
  pushLog(`[supervisor] Spawning cloudflared (attempt ${respawnAttempts + 1})…`);
  child = spawn(BIN_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture both streams. cloudflared writes most things to stderr in
  // structured-log format (`<TS> <LEVEL> <MSG>`) including connection
  // success, so we have to watch stderr for our connect markers.
  const onLine = (source) => (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      pushLog(line);
      // Mark "connected" the first time we see a register pattern.
      if (!connectedAt && CONNECT_PATTERNS.some(re => re.test(line))) {
        connectedAt = new Date();
        respawnAttempts = 0; // healthy connection resets backoff
      }
    }
  };
  child.stdout.on('data', onLine('stdout'));
  child.stderr.on('data', onLine('stderr'));

  child.on('error', err => {
    pushLog(`[supervisor] Spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    lastExitCode = code;
    lastExitReason = signal ? `signal ${signal}` : `code ${code}`;
    connectedAt = null;
    pushLog(`[supervisor] cloudflared exited (${lastExitReason}).`);
    child = null;

    if (userIntent !== 'running') {
      // User clicked Stop — don't respawn.
      respawnAttempts = 0;
      return;
    }
    // Crash respawn with backoff. Cap at 60s so a persistently-bad
    // token doesn't pin a CPU but also doesn't take an hour to recover
    // when the user fixes whatever broke.
    respawnAttempts += 1;
    const backoff = Math.min(60000, 1000 * Math.pow(2, Math.min(respawnAttempts - 1, 6)));
    pushLog(`[supervisor] Respawning in ${backoff / 1000}s…`);
    if (respawnTimer) clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (userIntent === 'running') spawnTunnel();
    }, backoff);
  });

  return true;
}

async function start() {
  if (!readToken()) {
    return { ok: false, error: 'No tunnel token set. Paste your Cloudflare tunnel token first.' };
  }
  if (!isInstalled()) {
    return { ok: false, error: 'cloudflared binary not installed. Run install first.' };
  }
  userIntent = 'running';
  respawnAttempts = 0;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  const ok = spawnTunnel();
  return ok ? { ok: true } : { ok: false, error: 'Spawn failed; see logs.' };
}

async function stop() {
  userIntent = 'stopped';
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (child && !child.killed && child.exitCode === null) {
    pushLog('[supervisor] Stopping cloudflared (SIGTERM)…');
    try { child.kill('SIGTERM'); } catch {}
    // Best-effort: give it 5s to exit gracefully, then SIGKILL.
    const stopChild = child;
    await new Promise(resolve => {
      const killTimer = setTimeout(() => {
        if (stopChild && stopChild.exitCode === null) {
          pushLog('[supervisor] SIGKILL after grace period');
          try { stopChild.kill('SIGKILL'); } catch {}
        }
        resolve();
      }, 5000);
      stopChild.once('exit', () => { clearTimeout(killTimer); resolve(); });
    });
  }
  return { ok: true };
}

async function restart() {
  await stop();
  return start();
}

// ============================================================
// Token operations
// ============================================================

async function setToken(token) {
  if (typeof token !== 'string' || token.trim().length < 20) {
    return { ok: false, error: 'Token looks invalid. Paste the full token from your Cloudflare Zero Trust dashboard.' };
  }
  const cleaned = token.trim();
  if (/\s/.test(cleaned)) {
    return { ok: false, error: 'Token contains whitespace. Re-copy from Cloudflare — there should be no spaces or line breaks.' };
  }
  if (!isInstalled()) {
    return { ok: false, error: 'cloudflared is not installed. Install it first.' };
  }
  // Stop any running tunnel before swapping the token, otherwise we'd
  // have a brief window where the old token is in cloudflared's args
  // and the new token is on disk.
  await stop();
  writeToken(cleaned);
  // Auto-start: setting the token implies "use this now."
  return start();
}

// ============================================================
// Boot hook
// ============================================================
// Called once from server.js at startup. If a token is on disk, spin
// up cloudflared automatically so a ShowPilot restart restores the
// tunnel without operator action.
function autoStartIfConfigured() {
  // v0.29.1 migration: if a token JSON file exists from a v0.29.0 install
  // but the raw-token sibling doesn't, create it. Safe no-op otherwise.
  migrateTokenFile();
  if (!readToken()) return;
  if (!isInstalled()) {
    pushLog('[supervisor] Token present but binary missing; not auto-starting.');
    return;
  }
  pushLog('[supervisor] Token found on disk; auto-starting tunnel.');
  start();
}

// Called from server.js shutdown handlers so we don't leak a child
// process when ShowPilot exits cleanly (PM2 reload, SIGTERM, etc.).
async function shutdownHook() {
  if (child && child.exitCode === null) {
    userIntent = 'stopped'; // suppress respawn
    try { child.kill('SIGTERM'); } catch {}
  }
}

// ============================================================
// Status
// ============================================================
function getStatus() {
  return new Promise(resolve => {
    getVersion(version => {
      const installed = isInstalled();
      const hasToken = !!readToken();
      const running = !!(child && child.exitCode === null);
      resolve({
        installed,
        version,
        hasToken,
        running,
        connected: !!connectedAt,
        connectedAt: connectedAt ? connectedAt.toISOString() : null,
        userIntent,
        lastSpawnedAt: lastSpawnedAt ? lastSpawnedAt.toISOString() : null,
        lastExitCode,
        lastExitReason,
        respawnAttempts,
        arch: detectArch(),
        archSupported: SUPPORTED_ARCHES.includes(detectArch() || ''),
        platform: process.platform,
      });
    });
  });
}

function recentLogs(n = 80) {
  const safeN = Math.max(1, Math.min(LOG_BUFFER_SIZE, parseInt(n, 10) || 80));
  return logBuffer.slice(-safeN).join('\n');
}

// ============================================================
// Full uninstall: stop, remove binary, clear token.
// ============================================================
async function uninstall() {
  await stop();
  try { fs.unlinkSync(BIN_PATH); } catch {}
  clearToken();
  return { ok: true };
}

module.exports = {
  getStatus,
  install,
  setToken,
  start,
  stop,
  restart,
  uninstall,
  recentLogs,
  autoStartIfConfigured,
  shutdownHook,
};
