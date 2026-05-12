// ============================================================
// ShowPilot — Cloudflare Tunnel admin routes (v0.29.0+)
// ============================================================
// Admin-only endpoints to manage an in-app cloudflared child process
// for exposing ShowPilot to the public internet. See lib/cloudflared.js
// for the supervisor design and the rationale for child-process vs
// systemd (Lite uses the latter; main can't, due to Docker support).
//
// Mounted at /api/admin/cloudflared. requireAdmin is applied at the
// mount point in server.js (matches /api/admin/backup pattern).
// ============================================================

const express = require('express');
const router = express.Router();
const cloudflared = require('../lib/cloudflared');

router.get('/status', async (req, res) => {
  try {
    const status = await cloudflared.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read tunnel status.' });
  }
});

router.post('/install', async (req, res) => {
  try {
    const r = await cloudflared.install();
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Install failed.' });
  }
});

// setToken auto-starts the tunnel after writing the token, so we don't
// need a separate /start call after /token like a stricter API would.
// Idempotent: re-pasting the same token is harmless (we stop+restart).
router.post('/token', async (req, res) => {
  const token = req.body && req.body.token;
  try {
    const r = await cloudflared.setToken(token);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Token registration failed.' });
  }
});

router.post('/start', async (req, res) => {
  try {
    const r = await cloudflared.start();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Start failed.' });
  }
});

router.post('/stop', async (req, res) => {
  try {
    const r = await cloudflared.stop();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Stop failed.' });
  }
});

router.post('/restart', async (req, res) => {
  try {
    const r = await cloudflared.restart();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Restart failed.' });
  }
});

router.post('/uninstall', async (req, res) => {
  try {
    const r = await cloudflared.uninstall();
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Uninstall failed.' });
  }
});

router.get('/logs', (req, res) => {
  const n = parseInt(req.query.n, 10) || 80;
  try {
    const logs = cloudflared.recentLogs(n);
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Log read failed.' });
  }
});

module.exports = router;
