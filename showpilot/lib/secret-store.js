// ============================================================
// ShowPilot — Secret Store
// ============================================================
// Resolves jwtSecret and showToken from a chain of sources, in order:
//
//   1. Environment variables — SHOWPILOT_JWT_SECRET / SHOWPILOT_SHOW_TOKEN
//      For users who run in Kubernetes, Docker secrets, or other
//      orchestration where secrets are mounted via env. Highest priority.
//
//   2. Real values in config.js — if the user has set their own values,
//      we use them. "Real" means: not null, not undefined, not a known
//      placeholder string ("CHANGE_ME_*").
//
//   3. data/secrets.json — auto-generated on first run, persisted
//      forever after. This is the out-of-box default path: a fresh
//      install with no env vars and unmodified config.example.js gets
//      strong random secrets generated automatically.
//
//   4. Generate fresh — happens once, on first run, when no source has
//      a real value. We persist to data/secrets.json so the same values
//      are used on subsequent restarts (otherwise every restart would
//      invalidate all sessions and break the FPP plugin connection).
//
// Rotating secrets:
//   - Set env var → restart. Highest priority, overrides everything.
//   - Edit config.js to a real value → restart.
//   - Delete data/secrets.json → restart. New auto-generated values.
//
// Security note: data/secrets.json is written with 0600 permissions
// (owner read/write only). On Docker, this means whatever UID the
// container runs as. The Dockerfile uses a non-root user (UID 1000),
// so secrets are not readable by other containers sharing the volume.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Known placeholder values that mean "I haven't set this yet, generate one".
// We keep the legacy CHANGE_ME_* strings recognized so users upgrading from
// older versions don't have to do anything — their existing config.js with
// placeholders will Just Work.
const PLACEHOLDER_VALUES = new Set([
  null,
  undefined,
  '',
  'CHANGE_ME_BEFORE_RUNNING_IN_PROD',
  'CHANGE_ME_TO_A_RANDOM_STRING',
]);

function isPlaceholder(value) {
  if (value === null || value === undefined || value === '') return true;
  return PLACEHOLDER_VALUES.has(value);
}

function generateSecret() {
  // 32 bytes = 256 bits of entropy. Hex encoding gives a 64-char string
  // that's safe to put in HTTP headers, env vars, and JSON without
  // escaping concerns. Way stronger than anything a human types.
  return crypto.randomBytes(32).toString('hex');
}

// Resolve secrets given the loaded config object and a base directory
// (typically the project root). Returns { jwtSecret, showToken, source }
// where source describes where each value came from (useful for logging).
//
// Side effects: may CREATE data/secrets.json on disk.
function resolveSecrets(config, projectRoot) {
  // The secrets file lives next to the database, in the data/ directory.
  // We use the configured dbPath to figure out where that is — that way,
  // bind-mounted Docker volumes and custom data paths all Just Work.
  const dbPath = config.dbPath || './data/showpilot.db';
  const dataDir = path.isAbsolute(dbPath)
    ? path.dirname(dbPath)
    : path.resolve(projectRoot, path.dirname(dbPath));
  const secretsPath = path.join(dataDir, 'secrets.json');

  // Make sure the directory exists. db.js creates this lazily for the DB
  // file, but we're getting here BEFORE db.js runs.
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    // Permission issue on a read-only volume, etc — let it surface
    console.error(`[secret-store] failed to create data dir at ${dataDir}:`, e.message);
    throw e;
  }

  // Load existing secrets file if present. We don't need to generate
  // anything if values are already there.
  let stored = {};
  if (fs.existsSync(secretsPath)) {
    try {
      stored = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    } catch (e) {
      console.warn(`[secret-store] secrets.json is corrupted (${e.message}). Regenerating.`);
      stored = {};
    }
  }

  let storedDirty = false;

  // ---- jwtSecret resolution ----
  let jwtSecret;
  let jwtSource;
  if (process.env.SHOWPILOT_JWT_SECRET) {
    jwtSecret = process.env.SHOWPILOT_JWT_SECRET;
    jwtSource = 'env';
  } else if (!isPlaceholder(config.jwtSecret)) {
    jwtSecret = config.jwtSecret;
    jwtSource = 'config.js';
  } else if (stored.jwtSecret) {
    jwtSecret = stored.jwtSecret;
    jwtSource = 'data/secrets.json';
  } else {
    jwtSecret = generateSecret();
    jwtSource = 'generated';
    stored.jwtSecret = jwtSecret;
    storedDirty = true;
  }

  // ---- showToken resolution ----
  let showToken;
  let showTokenSource;
  if (process.env.SHOWPILOT_SHOW_TOKEN) {
    showToken = process.env.SHOWPILOT_SHOW_TOKEN;
    showTokenSource = 'env';
  } else if (!isPlaceholder(config.showToken)) {
    showToken = config.showToken;
    showTokenSource = 'config.js';
  } else if (stored.showToken) {
    showToken = stored.showToken;
    showTokenSource = 'data/secrets.json';
  } else {
    showToken = generateSecret();
    showTokenSource = 'generated';
    stored.showToken = showToken;
    storedDirty = true;
  }

  // ---- Persist if we generated anything new ----
  // We always persist with 0600 (owner read/write only). Containers running
  // as a non-root UID get this applied to that UID — secrets aren't readable
  // by other containers sharing the volume.
  if (storedDirty) {
    try {
      fs.writeFileSync(secretsPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
      // On platforms where mode in writeFileSync is ignored (some filesystems),
      // explicitly chmod to be sure.
      try { fs.chmodSync(secretsPath, 0o600); } catch (_e) { /* best effort */ }
    } catch (e) {
      console.error(`[secret-store] failed to persist secrets to ${secretsPath}:`, e.message);
      console.error('[secret-store] continuing with in-memory secrets — they will be regenerated on next restart!');
      // Don't throw — we have working secrets in memory; the restart-instability
      // is bad but better than refusing to boot at all.
    }
  }

  return {
    jwtSecret,
    showToken,
    sources: { jwtSecret: jwtSource, showToken: showTokenSource },
    secretsPath,
    generatedThisRun: storedDirty,
  };
}

module.exports = { resolveSecrets, isPlaceholder, generateSecret };
