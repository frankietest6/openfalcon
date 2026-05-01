// ============================================================
// ShowPilot — In-app updater (v0.33.0+)
// ============================================================
// Fetches the latest release from GitHub, applies it via `git fetch`
// and `git checkout <tag>`, snapshots data/ before any changes so a
// rollback is possible to exactly one previous version.
//
// Why git operations rather than a symlink-managed `.versions/` tree:
// we only retain ONE previous version (current + previous), so the
// elaborate per-version directory infrastructure was overkill. Git's
// own object store is already the version archive — we just need to
// remember one previous tag/SHA and snapshot data/ separately. See
// SHOWPILOT-PRIMER.md "Architecture decisions worth knowing" for the
// reasoning trail.
//
// Bootstrap problem: same as ShipPilot — if the new release crashes
// on startup, the supervisor will keep trying to revive us into the
// broken code. Manual recovery is documented in the primer; the
// updater itself can't help once it's exited into a bad release.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const supervisor = require('./process-supervisor');
const config = require('./config-loader');
const db = require('./db');

// Project root — one level up from lib/. Resolves at module load time
// to keep all paths absolute (avoids surprises if process.cwd() changes).
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, '.snapshots', 'previous');

// In-memory cache of the latest-version check. Avoids hammering the
// GitHub API; lost on restart, which is fine.
const CHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let lastCheck = { at: 0, latest: null, error: null };

// Background poll interval — every 6 hours.
const BACKGROUND_POLL_MS = 6 * 60 * 60 * 1000;

// GitHub API endpoints. We try the Releases endpoint first because it's
// the richest source — release notes, published date, name. On 404 (the
// repo has tags but no published Releases — ShipPilot pushes tags but
// doesn't create Release objects, so this is our actual production
// state) we fall back to the tags endpoint and synthesize a release
// shape from the highest-semver tag.
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ShowPilotFPP/ShowPilot/releases/latest';
const GITHUB_TAGS_URL = 'https://api.github.com/repos/ShowPilotFPP/ShowPilot/tags?per_page=100';
const GITHUB_RELEASES_WEB_URL = 'https://github.com/ShowPilotFPP/ShowPilot/releases';
const GITHUB_TAGS_WEB_URL = 'https://github.com/ShowPilotFPP/ShowPilot/tags';

// Minimum free disk space we want available before an update.
// Conservative — npm install pulls dependencies which can run 100-150MB
// of node_modules churn even on a small upgrade.
const MIN_FREE_DISK_MB = 200;

// ------------------------------------------------------------
// Version helpers
// ------------------------------------------------------------

function readPackageVersion() {
  // Read package.json fresh each time rather than caching at startup —
  // the file changes on the disk during an update, and we want any
  // post-restart "what version am I" lookups to see the new value
  // without needing the lib reloaded.
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// Compare semver-ish strings ("0.33.0" vs "v0.33.0" both fine).
// Returns positive if a > b, negative if a < b, 0 if equal.
// Trailing pre-release tags ("0.33.0-beta1") are ignored — we only
// compare the numeric prefix. Good enough for our release flow which
// doesn't use pre-releases.
function compareVersions(a, b) {
  const norm = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < 3; i++) {
    const d = (av[i] || 0) - (bv[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ------------------------------------------------------------
// GitHub release check
// ------------------------------------------------------------

// Generic JSON GET helper. Returns { status, body } so callers can
// branch on 404 cleanly without throwing on that case (404 from
// /releases/latest is expected when only tags exist).
function ghGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ShowPilot-Updater',
        'Accept': 'application/vnd.github+json',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { /* leave as null on parse error */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GitHub API timed out')); });
    req.on('error', reject);
  });
}

// Filter to tags that look like semver (vX.Y.Z), parse, sort descending,
// return the highest. Returns null if there are no semver-shaped tags.
function pickHighestSemverTag(tags) {
  const semverTags = (tags || [])
    .map(t => t && t.name)
    .filter(name => typeof name === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(name));
  if (semverTags.length === 0) return null;
  semverTags.sort((a, b) => compareVersions(b, a)); // descending
  return semverTags[0];
}

// Try /releases/latest first (better data when available), fall back to
// /tags. Always returns the same shape so the route + UI don't care
// which path produced it.
async function fetchLatestRelease() {
  const releases = await ghGetJson(GITHUB_RELEASES_URL);
  if (releases.status === 200 && releases.body && releases.body.tag_name) {
    return {
      tag: releases.body.tag_name,
      name: releases.body.name || releases.body.tag_name,
      url: releases.body.html_url || GITHUB_RELEASES_WEB_URL,
      publishedAt: releases.body.published_at,
      body: releases.body.body || '',
      source: 'releases',
    };
  }
  // 404 here means the repo has no Releases. Fall back to tags. Other
  // non-200s (rate limit, server error) we treat the same — try tags;
  // if that also fails the caller sees an error.
  const tags = await ghGetJson(GITHUB_TAGS_URL);
  if (tags.status !== 200) {
    throw new Error(`GitHub API returned ${tags.status} for tags`);
  }
  const highest = pickHighestSemverTag(tags.body);
  if (!highest) {
    throw new Error('No semver-shaped tags found on GitHub');
  }
  return {
    tag: highest,
    name: highest,
    // No per-tag landing page on GitHub — link to the tags listing
    // instead. Better than no link at all.
    url: `${GITHUB_TAGS_WEB_URL}/${encodeURIComponent(highest)}`,
    publishedAt: null,
    body: '',
    source: 'tags',
  };
}

async function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && lastCheck.at && (now - lastCheck.at) < CHECK_CACHE_TTL_MS) {
    return lastCheck;
  }
  try {
    const latest = await fetchLatestRelease();
    lastCheck = { at: now, latest, error: null };
  } catch (err) {
    lastCheck = { at: now, latest: lastCheck.latest, error: err.message };
  }
  return lastCheck;
}

// ------------------------------------------------------------
// Pre-flight checks
// ------------------------------------------------------------

async function preflightChecks() {
  const errors = [];

  // 1. Free disk space. statvfs is the right call but Node doesn't
  // expose it directly without a native module; `df` is universal on
  // the platforms ShowPilot main runs on (Linux LXC, Docker on
  // Linux/macOS). On Windows we'd need a different approach but the
  // updater is gated to non-Docker Linux deployments anyway.
  try {
    const { stdout } = await execFileP('df', ['-Pm', PROJECT_ROOT], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const parts = lastLine.split(/\s+/);
    // df -Pm output: Filesystem 1M-blocks Used Available Capacity Mounted-on
    const availableMb = parseInt(parts[3], 10);
    if (Number.isFinite(availableMb) && availableMb < MIN_FREE_DISK_MB) {
      errors.push(`Only ${availableMb}MB free; need at least ${MIN_FREE_DISK_MB}MB`);
    }
  } catch (e) {
    // If df fails, don't block — log and continue. Better to attempt
    // and fail loudly than refuse to update because of a missing
    // utility.
    console.warn('[updater] df check skipped:', e.message);
  }

  // 2. Git working tree must be clean. Uncommitted changes shouldn't
  // exist on a prod deployment, but if they do we refuse rather than
  // clobber them — the operator clearly meant to do something locally.
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    if (stdout.trim()) {
      errors.push('Working tree has uncommitted changes — refusing to update');
    }
  } catch (e) {
    errors.push('git status failed: ' + e.message);
  }

  // 3. DB integrity. SQLite's PRAGMA integrity_check returns "ok" on a
  // healthy DB and a list of issues otherwise. We don't want to ship
  // an upgrade that runs migrations against a corrupt DB.
  try {
    const result = db.db.prepare('PRAGMA integrity_check').get();
    const value = result && (result.integrity_check || Object.values(result)[0]);
    if (value !== 'ok') {
      errors.push('DB integrity check failed: ' + value);
    }
  } catch (e) {
    errors.push('DB integrity check threw: ' + e.message);
  }

  // 4. Active-show check. If a voting round is in progress with cast
  // votes, or the jukebox queue has entries, refuse — restarting
  // mid-show is hostile to viewers. Admin can manually clear the
  // queue / end the round if they really want to update right now.
  try {
    const cfg = db.getConfig();
    if (cfg.viewer_control_mode === 'VOTING') {
      const voteCount = db.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n;
      if (voteCount > 0) {
        errors.push('Voting round has active votes — clear the round before updating');
      }
    }
    const queueCount = db.db.prepare(
      "SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0"
    ).get().n;
    if (queueCount > 0) {
      errors.push(`Jukebox queue has ${queueCount} pending request(s) — clear the queue before updating`);
    }
  } catch (e) {
    errors.push('Show-state check failed: ' + e.message);
  }

  return errors;
}

// ------------------------------------------------------------
// Snapshot / restore of data/
// ------------------------------------------------------------

// We snapshot data/ before each update. Only ONE snapshot is kept
// (overwritten on each new update) so disk usage stays bounded.
//
// Notable exclusions: data/.snapshots/ itself (recursion!), and
// data/audio-cache/ which can be 100s of MB and is regenerable from
// the FPP plugin. The cache will repopulate automatically as
// sequences play after a rollback.
async function snapshotData(currentVersion) {
  // Wipe any previous snapshot first — we only keep one.
  if (fs.existsSync(SNAPSHOT_DIR)) {
    await execFileP('rm', ['-rf', SNAPSHOT_DIR], { timeout: 30000 });
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // Use rsync for atomic-ish copy with exclusions. Falls back to cp
  // if rsync unavailable (rare on Linux, common on minimal Alpine
  // Docker images — but Docker is excluded from updates anyway).
  try {
    await execFileP('rsync', [
      '-a',
      '--exclude=.snapshots',
      '--exclude=audio-cache',
      `${DATA_DIR}/`,
      `${SNAPSHOT_DIR}/`,
    ], { timeout: 120000 });
  } catch (e) {
    // Fallback: cp -a, then manually delete the excluded dirs.
    await execFileP('cp', ['-a', `${DATA_DIR}/.`, SNAPSHOT_DIR], { timeout: 120000 });
    for (const excl of ['.snapshots', 'audio-cache']) {
      const p = path.join(SNAPSHOT_DIR, excl);
      if (fs.existsSync(p)) {
        await execFileP('rm', ['-rf', p], { timeout: 30000 });
      }
    }
  }

  // Tag the snapshot with the version it represents — useful for the
  // UI ("Roll back to v0.32.14") and for sanity-checking on rollback.
  fs.writeFileSync(
    path.join(SNAPSHOT_DIR, '.snapshot-meta.json'),
    JSON.stringify({
      version: currentVersion,
      createdAt: new Date().toISOString(),
    }, null, 2)
  );
}

async function restoreSnapshot() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    throw new Error('No snapshot to restore');
  }
  // Restore everything except audio-cache (which we excluded from the
  // snapshot, so it's not in there anyway — but defensive). Critically
  // we DON'T wipe data/ first — we just rsync the snapshot OVER it. That
  // way audio-cache and any dirs created post-snapshot survive, and we
  // only replace what was actually snapshotted (DB, secrets, covers,
  // etc.). The DB file gets overwritten atomically by rsync.
  try {
    await execFileP('rsync', [
      '-a',
      '--delete',
      '--exclude=.snapshots',
      '--exclude=audio-cache',
      `${SNAPSHOT_DIR}/`,
      `${DATA_DIR}/`,
    ], { timeout: 120000 });
  } catch (e) {
    // No clean rsync fallback for the --delete semantics, so just cp -a.
    // This won't delete files that exist in data/ but not in snapshot,
    // which is acceptable — in practice the only things in data/ are
    // things ShowPilot knows about.
    await execFileP('cp', ['-af', `${SNAPSHOT_DIR}/.`, DATA_DIR], { timeout: 120000 });
  }
}

function readSnapshotMeta() {
  const metaPath = path.join(SNAPSHOT_DIR, '.snapshot-meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Apply update
// ------------------------------------------------------------

// Run the actual git operations + npm install. Returns the SHA we
// were on before the update (for the previous_version state row).
async function gitFetchAndCheckout(targetTag) {
  const { stdout: oldSha } = await execFileP('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 5000,
  });

  await execFileP('git', ['fetch', '--tags', 'origin'], {
    cwd: PROJECT_ROOT,
    timeout: 60000,
  });

  await execFileP('git', ['checkout', targetTag], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  return oldSha.trim();
}

async function npmInstall() {
  // --omit=dev is the modern flag (was --production); both work on
  // recent npm but --omit=dev is preferred. 5-minute timeout because
  // a fresh install on slow disk can take a while.
  await execFileP('npm', ['install', '--omit=dev'], {
    cwd: PROJECT_ROOT,
    timeout: 300000,
  });
}

// Apply an update: snapshot data/, fetch tag, checkout, npm install,
// record state, schedule clean exit. Throws if any step fails.
async function applyUpdate(targetTag) {
  const errors = await preflightChecks();
  if (errors.length) {
    const e = new Error('Pre-flight checks failed');
    e.preflightErrors = errors;
    throw e;
  }

  const currentVersion = readPackageVersion();

  // 1. Snapshot data/
  await snapshotData(currentVersion);

  // 2. Capture current SHA, fetch + checkout new tag
  const oldSha = await gitFetchAndCheckout(targetTag);

  // 3. npm install for any new dependencies
  await npmInstall();

  // 4. Record what we came from so the UI's rollback button knows
  // where to go back to. We set this AFTER all the risky operations
  // succeeded — if any earlier step failed, we never recorded the
  // pending state, so the rollback UI accurately reflects "we never
  // updated".
  db.setUpdateState({
    previous_version_tag: 'v' + currentVersion,
    previous_version_sha: oldSha,
    last_update_at: new Date().toISOString(),
    last_update_target: targetTag,
  });

  return { previousVersion: currentVersion, previousSha: oldSha, targetTag };
}

// Roll back to the previous version. Restores data/ from snapshot,
// checks out the previous SHA, runs npm install in case dependency
// versions changed.
async function applyRollback() {
  const state = db.getUpdateState();
  if (!state || !state.previous_version_sha) {
    throw new Error('No previous version recorded — rollback unavailable');
  }
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    throw new Error('Data snapshot missing — cannot safely roll back');
  }

  // Restore data/ first. If this fails we haven't touched git yet, so
  // the install is still self-consistent.
  await restoreSnapshot();

  // Check out the old SHA. We use the SHA rather than the tag because
  // it's unambiguous — even if the tag was deleted on origin, we still
  // have the commit locally.
  await execFileP('git', ['checkout', state.previous_version_sha], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  await npmInstall();

  // Clear the previous-version pointer. After a rollback there's no
  // "next previous" — the operator would have to update again before
  // a rollback button makes sense.
  db.setUpdateState({
    previous_version_tag: null,
    previous_version_sha: null,
    last_update_at: new Date().toISOString(),
    last_update_target: 'rollback to ' + state.previous_version_tag,
  });

  return { rolledBackTo: state.previous_version_tag };
}

// ------------------------------------------------------------
// Restart helpers
// ------------------------------------------------------------

// True if we're running in a context where the updater button should
// be disabled. Docker case shows the version-available info but no
// button (per the design discussion) because Watchtower handles
// updates externally.
function isUpdaterAvailable() {
  if (config.demoMode) return false;
  if (supervisor.detectSupervisor() === 'docker') return false;
  return true;
}

function scheduleCleanExit(reason) {
  // Mirrors routes/backup.js — exit AFTER the response flushes.
  setTimeout(() => {
    console.log('[updater] exiting for supervisor-managed restart:', reason);
    process.exit(0);
  }, 1500);
}

// ------------------------------------------------------------
// Background polling
// ------------------------------------------------------------

let pollTimer = null;
function startBackgroundPolling() {
  if (pollTimer) return;
  // Initial check at startup — wait 30s so we don't slow boot.
  setTimeout(() => { checkForUpdate({ force: true }).catch(() => {}); }, 30000);
  pollTimer = setInterval(() => {
    checkForUpdate({ force: true }).catch(() => {});
  }, BACKGROUND_POLL_MS);
  pollTimer.unref();
}

module.exports = {
  readPackageVersion,
  compareVersions,
  checkForUpdate,
  preflightChecks,
  applyUpdate,
  applyRollback,
  isUpdaterAvailable,
  scheduleCleanExit,
  startBackgroundPolling,
  readSnapshotMeta,
};
