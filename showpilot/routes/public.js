// ============================================================
// ShowPilot — Public API (v0.31.0+)
// ============================================================
// Endpoints that don't require authentication or a plugin token.
// Currently only used to expose demo-mode state to the admin/viewer
// pages so they can render a banner without forcing a login first.
//
// Mounted at /api/public — see server.js.
// ============================================================

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const config = require('../lib/config-loader');

// Path to the file that the external reset script writes after each
// reset. Lives inside data/ so backup-aware tooling can ignore it
// (it's regenerated every cycle anyway).
const NEXT_RESET_PATH = path.join(__dirname, '..', 'data', 'demo-next-reset.json');

// ============================================================
// GET /api/public/demo-status
// ============================================================
// Returns:
//   { demoMode: false }
//   — when demoMode is off (the common case in prod)
//
//   { demoMode: true,
//     credentialsHint: 'admin / admin',
//     resetIntervalMinutes: 10,
//     nextResetAt: '2026-04-29T18:30:00.000Z' | null }
//   — when demoMode is on. nextResetAt is null if the reset script
//     hasn't written the file yet (e.g. first boot before the first
//     reset has occurred).
//
// We deliberately don't gate this behind any auth — the banner needs
// to render on the login page, before the user has any session. The
// only data exposed is config the operator chose to expose, plus a
// public timestamp.
router.get('/demo-status', (req, res) => {
  if (!config.demoMode) {
    return res.json({ demoMode: false });
  }

  let nextResetAt = null;
  try {
    if (fs.existsSync(NEXT_RESET_PATH)) {
      const raw = fs.readFileSync(NEXT_RESET_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Validate shape — the file is written by an external script and
      // we don't want a malformed file to break the banner.
      if (parsed && typeof parsed.nextResetAt === 'string') {
        // Round-trip parse to confirm it's a real ISO timestamp.
        const t = Date.parse(parsed.nextResetAt);
        if (Number.isFinite(t)) {
          nextResetAt = new Date(t).toISOString();
        }
      }
    }
  } catch (err) {
    // Swallow — banner just won't have a countdown until the next
    // reset writes a fresh file. Log once so misconfigured demos
    // surface a hint in the logs.
    console.warn('[demo-status] could not read next-reset file:', err.message);
  }

  res.json({
    demoMode: true,
    credentialsHint: String(config.demoCredentialsHint || '').trim() || null,
    resetIntervalMinutes: Number(config.demoResetIntervalMinutes) || 10,
    nextResetAt,
  });
});

module.exports = router;
