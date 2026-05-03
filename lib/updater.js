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

// GitHub API endpoints. We use /releases?per_page=100 (the list endpoint)
// rather than /releases/latest because /releases/latest returns whichever
// release GitHub has manually marked as "latest" — which requires a manual
// step after every publish and silently stays stale otherwise. The list
// endpoint returns all releases; we pick the highest semver tag ourselves,
// which is always correct regardless of GitHub's "latest" marker.
// Falls back to the tags endpoint if no Release objects exist at all.
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ShowPilotFPP/ShowPilot/releases?per_page=100';
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

// Pick the highest-semver release from a releases list array.
// Skips drafts, pre-releases, and tags that aren't shaped like vX.Y.Z / X.Y.Z
// (guards against malformed release tags like "33.15" which parse as major
// version 33 and beat legitimate "v0.33.x" tags in the sort).
function pickHighestSemverRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  const semverShape = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
  const candidates = releases.filter(r =>
    r && r.tag_name &&
    semverShape.test(r.tag_name) &&
    !r.draft &&
    !r.prerelease
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name)); // descending
  return candidates[0];
}

// Try /releases?per_page=100 and /tags?per_page=100 in parallel, then
// return whichever has the higher semver. This handles the mixed state
// where some releases have GitHub Release objects (richer data) and newer
// ones were shipped as tags only (ShipPilot creates tags, not Releases).
async function fetchLatestRelease() {
  const [releasesRes, tagsRes] = await Promise.all([
    ghGetJson(GITHUB_RELEASES_URL),
    ghGetJson(GITHUB_TAGS_URL),
  ]);

  const bestRelease = (releasesRes.status === 200 && Array.isArray(releasesRes.body))
    ? pickHighestSemverRelease(releasesRes.body)
    : null;

  const bestTag = (tagsRes.status === 200)
    ? pickHighestSemverTag(tagsRes.body)
    : null;

  if (!bestRelease && !bestTag) {
    throw new Error('No releases or semver-shaped tags found on GitHub');
  }

  // Prefer the release object for its richer data (notes, published date),
  // but only if it's actually the highest version. If a newer tag exists
  // that has no Release object yet, use the tag.
  const releaseIsHigher = bestRelease && bestTag
    ? compareVersions(bestRelease.tag_name, bestTag) >= 0
    : !!bestRelease;

  if (releaseIsHigher) {
    return {
      tag: bestRelease.tag_name,
      name: bestRelease.name || bestRelease.tag_name,
      url: bestRelease.html_url || GITHUB_RELEASES_WEB_URL,
      publishedAt: bestRelease.published_at,
      body: bestRelease.body || '',
      source: 'releases',
    };
  }

  // Tag is higher (or no release objects exist at all)
  return {
    tag: bestTag,
    name: bestTag,
    url: `${GITHUB_RELEASES_WEB_URL}/tag/${encodeURIComponent(bestTag)}`,
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

async function preflightChecks({ force = false } = {}) {
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
      errors.push({ msg: `Only ${availableMb}MB free; need at least ${MIN_FREE_DISK_MB}MB`, override: false });
    }
  } catch (e) {
    // If df fails, don't block — log and continue. Better to attempt
    // and fail loudly than refuse to update because of a missing
    // utility.
    console.warn('[updater] df check skipped:', e.message);
  }

  // 2. Working-tree cleanliness used to be a blocking check here.
  // Removed in v0.33.7 because `npm install --omit=dev` (run as part
  // of every successful update) modifies the tracked package-lock.json,
  // which then dirties the tree and blocks the NEXT update. The fix
  // is to auto-stash in gitFetchAndCheckout instead — local changes
  // (including post-update package-lock churn) are preserved across
  // the checkout and dropped on success. If the stash itself fails
  // to apply we surface that as an error from the checkout step.

  // 3. DB integrity. SQLite's PRAGMA integrity_check returns "ok" on a
  // healthy DB and a list of issues otherwise. We don't want to ship
  // an upgrade that runs migrations against a corrupt DB.
  try {
    const result = db.db.prepare('PRAGMA integrity_check').get();
    const value = result && (result.integrity_check || Object.values(result)[0]);
    if (value !== 'ok') {
      errors.push({ msg: 'DB integrity check failed: ' + value, override: false });
    }
  } catch (e) {
    errors.push({ msg: 'DB integrity check threw: ' + e.message, override: false });
  }

  // 4. Active-show check. If a voting round is in progress with cast
  // votes, or the jukebox queue has entries, refuse — restarting
  // mid-show is hostile to viewers. Operator can override with the
  // "Update anyway" button when they're sure (e.g. testing, end of
  // night, no live audience).
  try {
    const cfg = db.getConfig();
    if (cfg.viewer_control_mode === 'VOTING') {
      const voteCount = db.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n;
      if (voteCount > 0 && !force) {
        errors.push({ msg: 'Voting round has active votes — clear the round before updating', override: true });
      }
    }
    const queueCount = db.db.prepare(
      "SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0"
    ).get().n;
    if (queueCount > 0 && !force) {
      errors.push({ msg: `Jukebox queue has ${queueCount} pending request(s) — clear the queue before updating`, override: true });
    }
  } catch (e) {
    errors.push({ msg: 'Show-state check failed: ' + e.message, override: false });
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

// Run the actual git operations + npm install. Returns {oldSha, stashRef}
// where stashRef is null if no stash was made, or a string identifying
// the stash so applyUpdate can drop it on success.
async function gitFetchAndCheckout(targetTag) {
  const { stdout: oldSha } = await execFileP('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 5000,
  });

  // Auto-stash if the working tree is dirty. This happens routinely
  // because `npm install --omit=dev` (run on every successful update)
  // modifies the tracked package-lock.json. Without the stash, the
  // next update's `git checkout` aborts with "your local changes
  // would be overwritten." We use a labeled stash so it's easy to
  // identify and drop on success. -u includes untracked files;
  // --include-untracked covers cases like a generated file that was
  // never added.
  let stashRef = null;
  try {
    const { stdout: status } = await execFileP('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    if (status.trim()) {
      const stashLabel = 'showpilot-updater-' + Date.now();
      await execFileP('git', ['stash', 'push', '--include-untracked', '-m', stashLabel], {
        cwd: PROJECT_ROOT,
        timeout: 30000,
      });
      stashRef = stashLabel;
      console.log('[updater] stashed working-tree changes as', stashLabel);
    }
  } catch (e) {
    // If stash itself failed, the checkout will probably fail too with
    // a clearer error. Continue and let git surface it.
    console.warn('[updater] auto-stash failed (continuing to checkout):', e.message);
  }

  await execFileP('git', ['fetch', '--tags', 'origin'], {
    cwd: PROJECT_ROOT,
    timeout: 60000,
  });

  await execFileP('git', ['checkout', targetTag], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  return { oldSha: oldSha.trim(), stashRef };
}

// Drop a labeled updater stash. Best-effort — if the stash was already
// dropped or the label doesn't match, log and move on.
async function dropUpdaterStash(stashLabel) {
  if (!stashLabel) return;
  try {
    // Find the stash entry by label and drop it. `git stash list`
    // outputs lines like "stash@{0}: On main: showpilot-updater-1234".
    const { stdout } = await execFileP('git', ['stash', 'list'], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    const lines = stdout.split('\n');
    const match = lines.find(l => l.includes(stashLabel));
    if (!match) {
      console.warn('[updater] stash', stashLabel, 'not found, nothing to drop');
      return;
    }
    const refMatch = match.match(/^(stash@\{\d+\})/);
    if (!refMatch) return;
    await execFileP('git', ['stash', 'drop', refMatch[1]], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    console.log('[updater] dropped stash', stashLabel);
  } catch (e) {
    console.warn('[updater] drop stash failed (non-fatal):', e.message);
  }
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
//
// Options:
//   force — when true, the active-show preflight check is skipped.
//           Used by the UI's "Update anyway" button. Other preflight
//           checks (disk, DB integrity) are NOT bypassed by force.
async function applyUpdate(targetTag, { force = false } = {}) {
  const errors = await preflightChecks({ force });
  if (errors.length) {
    const e = new Error('Pre-flight checks failed');
    e.preflightErrors = errors;
    throw e;
  }

  const currentVersion = readPackageVersion();

  // 1. Snapshot data/
  await snapshotData(currentVersion);

  // 2. Capture current SHA, fetch + checkout new tag (auto-stashes
  // dirty working tree; the stash is dropped after npm install
  // succeeds since the new versions of those files are now on disk).
  const { oldSha, stashRef } = await gitFetchAndCheckout(targetTag);

  // 3. npm install for any new dependencies
  await npmInstall();

  // 4. Drop the auto-stash if we made one. We do this AFTER npmInstall
  // so a failure during install can be debugged with the stash still
  // present (operator can `git stash list` and recover their changes).
  // Best-effort — drop failure doesn't fail the update.
  await dropUpdaterStash(stashRef);

  // 5. Record what we came from so the UI's rollback button knows
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

  // Auto-stash the working tree before checkout. After a forward
  // update, package-lock.json is typically dirtied by the trailing
  // npm install — same situation as gitFetchAndCheckout. Stash so
  // the checkout succeeds; drop after the rollback's npm install
  // completes (the new package-lock.json from the old version is
  // what we want).
  let rollbackStashRef = null;
  try {
    const { stdout: status } = await execFileP('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    if (status.trim()) {
      const stashLabel = 'showpilot-rollback-' + Date.now();
      await execFileP('git', ['stash', 'push', '--include-untracked', '-m', stashLabel], {
        cwd: PROJECT_ROOT,
        timeout: 30000,
      });
      rollbackStashRef = stashLabel;
      console.log('[updater] (rollback) stashed working-tree changes as', stashLabel);
    }
  } catch (e) {
    console.warn('[updater] (rollback) auto-stash failed (continuing to checkout):', e.message);
  }

  // Check out the old SHA. We use the SHA rather than the tag because
  // it's unambiguous — even if the tag was deleted on origin, we still
  // have the commit locally.
  await execFileP('git', ['checkout', state.previous_version_sha], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  await npmInstall();

  // Drop the rollback stash. Same reasoning as the forward path:
  // best-effort, post-install so a failure leaves the stash for
  // operator recovery.
  await dropUpdaterStash(rollbackStashRef);

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
