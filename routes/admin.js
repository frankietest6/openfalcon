// ============================================================
// OpenFalcon — Admin API
// Authenticated endpoints for managing the show.
// Auth: JWT in httpOnly cookie.
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config');
const { db, getConfig, updateConfig } = require('../lib/db');

// ============================================================
// Auth
// ============================================================

function requireAdmin(req, res, next) {
  const token = req.cookies[config.sessionCookieName];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
}

// POST /api/admin/login — body: { password }
router.post('/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Missing password' });

  const cfg = getConfig();

  // First-run: no password set yet. Accept any non-empty and set it.
  if (!cfg.admin_password_hash) {
    const hash = await bcrypt.hash(password, 10);
    updateConfig({ admin_password_hash: hash });
    const token = jwt.sign({ admin: true }, config.jwtSecret, {
      expiresIn: `${config.sessionDurationHours}h`,
    });
    res.cookie(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.sessionDurationHours * 3600 * 1000,
    });
    return res.json({ ok: true, firstRun: true });
  }

  const match = await bcrypt.compare(password, cfg.admin_password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid password' });

  const token = jwt.sign({ admin: true }, config.jwtSecret, {
    expiresIn: `${config.sessionDurationHours}h`,
  });
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionDurationHours * 3600 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.sessionCookieName);
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// ============================================================
// Config
// ============================================================

router.get('/config', requireAdmin, (req, res) => {
  const cfg = getConfig();
  delete cfg.admin_password_hash;
  res.json(cfg);
});

router.put('/config', requireAdmin, (req, res) => {
  const allowed = [
    'show_name',
    'viewer_control_mode',
    'managed_psa_enabled',
    'interrupt_schedule',
    'viewer_page_html',
    'viewer_page_css',
    // Jukebox safeguards
    'jukebox_queue_depth',
    'jukebox_sequence_request_limit',
    'prevent_multiple_requests',
    // Voting safeguards
    'prevent_multiple_votes',
    'reset_votes_after_round',
    // PSA
    'play_psa_enabled',
    'psa_frequency',
    // Viewer presence
    'check_viewer_present',
    'viewer_present_mode',
    'show_latitude',
    'show_longitude',
    'check_radius_miles',
    // Misc
    'hide_sequence_after_played',
    'blocked_ips',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }

  // When admin sets viewer_control_mode to something other than OFF, remember it
  // so the FPP "Turn On" command can restore it later.
  if (updates.viewer_control_mode && updates.viewer_control_mode !== 'OFF') {
    updates.last_active_mode = updates.viewer_control_mode;
  }

  updateConfig(updates);
  res.json({ ok: true });
});

router.post('/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: 'Missing new password' });

  const cfg = getConfig();
  if (cfg.admin_password_hash) {
    const match = await bcrypt.compare(currentPassword || '', cfg.admin_password_hash);
    if (!match) return res.status(401).json({ error: 'Current password incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  updateConfig({ admin_password_hash: hash });
  res.json({ ok: true });
});

// ============================================================
// Sequences
// ============================================================

router.get('/sequences', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM sequences ORDER BY display_order, display_name`).all();
  res.json(rows);
});

router.post('/sequences', requireAdmin, (req, res) => {
  const {
    name, display_name, artist, category, duration_seconds,
    visible = 1, votable = 1, jukeboxable = 1, sort_order = 0,
  } = req.body || {};

  if (!name || !display_name) return res.status(400).json({ error: 'name and display_name required' });

  try {
    const info = db.prepare(`
      INSERT INTO sequences (name, display_name, artist, category, duration_seconds, visible, votable, jukeboxable, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, display_name, artist || null, category || null, duration_seconds || null, visible, votable, jukeboxable, sort_order);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Sequence name already exists' });
    }
    throw e;
  }
});

// PATCH is an alias for PUT here — both accept partial updates
router.patch('/sequences/:id', requireAdmin, (req, res) => updateSequence(req, res));
router.put('/sequences/:id', requireAdmin, (req, res) => updateSequence(req, res));

function updateSequence(req, res) {
  const id = Number(req.params.id);
  const fields = ['display_name', 'artist', 'category', 'image_url',
                  'duration_seconds', 'visible', 'votable', 'jukeboxable',
                  'is_psa', 'display_order'];
  const updates = {};
  for (const k of fields) {
    if (k in req.body) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) return res.json({ ok: true });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE sequences SET ${setClause} WHERE id = @id`).run({ ...updates, id });
  res.json({ ok: true });
}

router.delete('/sequences/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM sequences WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// Reorder sequences in the admin table: expects { ids: [...] } in desired order.
// Writes display_order only — FPP playlist index (sort_order) is untouched.
router.post('/sequences/reorder', requireAdmin, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) {
    return res.status(400).json({ error: 'ids must be an array' });
  }
  const stmt = db.prepare(`UPDATE sequences SET display_order = ? WHERE id = ?`);
  const tx = db.transaction((items) => {
    items.forEach((id, index) => {
      stmt.run(index + 1, Number(id));
    });
  });
  tx(ids);
  res.json({ ok: true });
});

// Sort alphabetically by display_name and re-assign display_order sequentially.
// Does not affect FPP playlist index.
router.post('/sequences/sort-alphabetically', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT id FROM sequences
    ORDER BY LOWER(display_name) ASC, LOWER(name) ASC
  `).all();
  const stmt = db.prepare(`UPDATE sequences SET display_order = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    rows.forEach((r, i) => stmt.run(i + 1, r.id));
  });
  tx();
  res.json({ ok: true, sorted: rows.length });
});

// Delete inactive sequences (not visible, not votable, not jukeboxable, not PSA).
router.post('/sequences/delete-inactive', requireAdmin, (req, res) => {
  const result = db.prepare(`
    DELETE FROM sequences
    WHERE visible = 0 AND votable = 0 AND jukeboxable = 0 AND is_psa = 0
  `).run();
  res.json({ ok: true, deleted: result.changes });
});

// ============================================================
// Stats & history
// ============================================================

router.get('/stats', requireAdmin, (req, res) => {
  const cfg = getConfig();
  const totalViewers = db.prepare(`SELECT COUNT(*) AS n FROM active_viewers`).get().n;
  const activeViewers = db.prepare(`
    SELECT COUNT(*) AS n FROM active_viewers
    WHERE last_seen > datetime('now', '-${config.viewer.activeWindowSeconds} seconds')
  `).get().n;
  const totalVotes = db.prepare(`SELECT COUNT(*) AS n FROM votes WHERE round_id = ?`).get(cfg.current_voting_round).n;
  const queueLength = db.prepare(`SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0`).get().n;

  // Only count viewer-driven plays — not schedule fillers / resumes
  const totalPlays = db.prepare(`
    SELECT COUNT(*) AS n FROM play_history
    WHERE source IN ('vote', 'request', 'psa')
  `).get().n;

  const topSequences = db.prepare(`
    SELECT sequence_name, COUNT(*) AS plays
    FROM play_history
    WHERE source IN ('vote', 'request', 'psa')
    GROUP BY sequence_name
    ORDER BY plays DESC
    LIMIT 10
  `).all();

  // Now playing + next up — bundled into stats so admin only needs one poll
  const nowPlaying = db.prepare(`SELECT * FROM now_playing WHERE id = 1`).get() || {};

  res.json({
    totalViewers,
    activeViewers,
    totalVotes,
    queueLength,
    totalPlays,
    topSequences,
    currentRound: cfg.current_voting_round,
    nowPlaying: nowPlaying.sequence_name || null,
    nextUp: nowPlaying.next_sequence_name || null,
  });
});

router.get('/history', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = db.prepare(`
    SELECT * FROM play_history ORDER BY played_at DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// Reset votes for current round
router.post('/reset-votes', requireAdmin, (req, res) => {
  const cfg = getConfig();
  db.prepare(`DELETE FROM votes WHERE round_id = ?`).run(cfg.current_voting_round);
  res.json({ ok: true });
});

// Purge jukebox queue
router.post('/purge-queue', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM jukebox_queue WHERE played = 0`).run();
  res.json({ ok: true });
});

// Plugin status (for admin dashboard display)
router.get('/plugin-status', requireAdmin, (req, res) => {
  const { pluginStatus } = require('./plugin');
  res.json({
    lastSeen: pluginStatus.lastSeen,
    version: pluginStatus.version,
    lastSyncAt: pluginStatus.lastSyncAt,
    lastSyncPlaylist: pluginStatus.lastSyncPlaylist,
    lastSyncCount: pluginStatus.lastSyncCount,
  });
});

// Show the current show token (for pasting into FPP plugin)
router.get('/show-token', requireAdmin, (req, res) => {
  res.json({ showToken: config.showToken });
});

// ============================================================
// Viewer Page Templates (CRUD)
// ============================================================

router.get('/templates', requireAdmin, (req, res) => {
  // Summary list — don't ship the HTML body in the list endpoint (can be huge)
  const rows = db.prepare(`
    SELECT id, name, is_active, is_builtin,
           LENGTH(html) AS html_length,
           created_at, updated_at
    FROM viewer_page_templates
    ORDER BY is_builtin DESC, name ASC
  `).all();
  res.json(rows);
});

router.get('/templates/:id', requireAdmin, (req, res) => {
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Template not found' });
  res.json(row);
});

router.post('/templates', requireAdmin, (req, res) => {
  const { name, html } = req.body || {};
  if (!name || !html) return res.status(400).json({ error: 'name and html required' });
  const result = db.prepare(`
    INSERT INTO viewer_page_templates (name, html, is_active, is_builtin)
    VALUES (?, ?, 0, 0)
  `).run(String(name).trim(), String(html));
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/templates/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, html } = req.body || {};
  const existing = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  const updates = [];
  const params = { id, now: new Date().toISOString() };
  if (name !== undefined) { updates.push('name = @name'); params.name = String(name).trim(); }
  if (html !== undefined) { updates.push('html = @html'); params.html = String(html); }
  if (updates.length === 0) return res.json({ ok: true });

  updates.push('updated_at = @now');
  db.prepare(`UPDATE viewer_page_templates SET ${updates.join(', ')} WHERE id = @id`).run(params);
  res.json({ ok: true });
});

router.delete('/templates/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  if (row.is_builtin) return res.status(400).json({ error: "Can't delete built-in template. Duplicate and customize instead." });
  if (row.is_active) return res.status(400).json({ error: "Can't delete the active template. Activate another first." });
  db.prepare(`DELETE FROM viewer_page_templates WHERE id = ?`).run(id);
  res.json({ ok: true });
});

router.post('/templates/:id/activate', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT id FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE viewer_page_templates SET is_active = 0`).run();
    db.prepare(`UPDATE viewer_page_templates SET is_active = 1 WHERE id = ?`).run(id);
  });
  tx();
  res.json({ ok: true });
});

router.post('/templates/:id/duplicate', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  const newName = `${row.name} (copy)`;
  const result = db.prepare(`
    INSERT INTO viewer_page_templates (name, html, is_active, is_builtin)
    VALUES (?, ?, 0, 0)
  `).run(newName, row.html);
  res.json({ ok: true, id: result.lastInsertRowid });
});

module.exports = router;
