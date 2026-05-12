// ============================================================
// Process supervisor detection (v0.25.1+)
// ============================================================
// Used by the backup-restore flow to decide whether it's safe to
// call process.exit(0) — which only works when something will
// restart us. Without supervision, exiting kills the server until
// the operator manually starts it again, which is a terrible
// experience for "I just clicked Restore and the page won't load."
//
// Detection strategy: check well-known environment variables and
// filesystem markers each major supervisor leaves behind. These
// are imperfect heuristics, so the operator can override via
// SHOWPILOT_RESTART_MODE=exit|manual.
// ============================================================

const fs = require('fs');

function detectSupervisor() {
  // PM2 — most reliable indicator is `pm_id` (numeric instance ID).
  // PM2_HOME is set by PM2 when launching but can also be set by
  // the user to influence config dir; pm_id is only set when actually
  // running under PM2.
  if (process.env.pm_id !== undefined) return 'pm2';

  // systemd — INVOCATION_ID is a unique per-invocation ID set by
  // systemd, and is the canonical "am I running under systemd"
  // signal per systemd.exec(5). Way more reliable than checking
  // for systemd-specific paths.
  if (process.env.INVOCATION_ID) return 'systemd';

  // Docker — this only tells us we're in a container, not whether
  // `--restart` policy is set. We assume operators who containerize
  // a server-side app like ShowPilot configure restart policy. If
  // they didn't, they can set SHOWPILOT_RESTART_MODE=manual.
  if (fs.existsSync('/.dockerenv')) return 'docker';

  // Windows Service via NSSM/winsw — NSSM doesn't set environment
  // hints, and detecting Windows Service mode reliably from inside
  // Node is hard. Operators on this path should set the override
  // variable.

  return 'none';
}

// Returns one of:
//   'auto-exit'   — we'll process.exit(0); caller should expect supervisor revival
//   'manual'      — caller must NOT exit; show the user a restart instruction
function getRestartMode() {
  const override = (process.env.SHOWPILOT_RESTART_MODE || '').toLowerCase();
  if (override === 'exit') return 'auto-exit';
  if (override === 'manual') return 'manual';
  // 'auto' or anything else falls through to detection
  return detectSupervisor() === 'none' ? 'manual' : 'auto-exit';
}

// Returns a friendly description suitable for telling the admin
// what to do when restartMode === 'manual'. Heuristic — the
// operator's actual command might differ but this covers ~95% of
// real installs.
function getManualRestartHint() {
  // Best-effort guess at the right command.
  // If we got here it means we couldn't auto-detect a supervisor —
  // but we can still hint at common patterns.
  const supervisor = detectSupervisor(); // probably 'none'
  if (supervisor === 'pm2') return 'pm2 restart showpilot';
  if (supervisor === 'systemd') return 'sudo systemctl restart showpilot';
  if (supervisor === 'docker') return 'docker restart <container_name>';
  return 'Stop the current process and run `node server.js` again, or use whatever process manager you use to restart it.';
}

module.exports = {
  detectSupervisor,
  getRestartMode,
  getManualRestartHint,
};
