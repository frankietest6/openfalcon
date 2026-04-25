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
    // Viewer player decoration
    'player_decoration',
    'player_decoration_animated',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }

  // When admin sets viewer_control_mode to something other than OFF, remember it
  // so the FPP "Turn On" command (and admin's Turn On toggle) can restore it later.
  if (updates.viewer_control_mode && updates.viewer_control_mode !== 'OFF') {
    updates.last_active_mode = updates.viewer_control_mode;
  }

  // When admin sets mode to OFF, stash the CURRENT (pre-change) mode so we can restore it
  if (updates.viewer_control_mode === 'OFF') {
    const cfg = getConfig();
    if (cfg.viewer_control_mode && cfg.viewer_control_mode !== 'OFF') {
      updates.last_active_mode = cfg.viewer_control_mode;
    }
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
  const { bustSequenceCovers } = require('../lib/cover-art');
  const rows = db.prepare(`SELECT * FROM sequences ORDER BY display_order, display_name`).all();
  res.json(bustSequenceCovers(rows));
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
  // queueLength excludes the in-flight (handed-off, currently-playing) entry —
  // those are tracked with handed_off_at IS NOT NULL.
  const queueLength = db.prepare(`
    SELECT COUNT(*) AS n FROM jukebox_queue
    WHERE played = 0 AND handed_off_at IS NULL
  `).get().n;

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
  const nowPlayingName = nowPlaying.sequence_name || null;

  // "Next up" priority order:
  //   1. JUKEBOX mode + queue has entries (after now-playing) → first queued
  //   2. VOTING mode + votes cast → highest-voted song
  //   3. Otherwise → schedule's next song (from FPP plugin)
  let nextUp = nowPlaying.next_sequence_name || null;
  if (cfg.viewer_control_mode === 'JUKEBOX') {
    // Skip the currently-playing entry — it's still in the queue with
    // played=0 (handed off but not confirmed-played yet).
    const firstQueued = db.prepare(`
      SELECT sequence_name FROM jukebox_queue
      WHERE played = 0 AND sequence_name != COALESCE(?, '')
      ORDER BY requested_at ASC LIMIT 1
    `).get(nowPlayingName);
    if (firstQueued) nextUp = firstQueued.sequence_name;
  } else if (cfg.viewer_control_mode === 'VOTING') {
    const top = db.prepare(`
      SELECT sequence_name, COUNT(*) AS n FROM votes
      WHERE round_id = ?
      GROUP BY sequence_name
      ORDER BY n DESC
      LIMIT 1
    `).get(cfg.current_voting_round);
    if (top) nextUp = top.sequence_name;
  }

  res.json({
    totalViewers,
    activeViewers,
    totalVotes,
    queueLength,
    totalPlays,
    topSequences,
    currentRound: cfg.current_voting_round,
    nowPlaying: nowPlayingName,
    nextUp,
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

// ============================================================
// Cover art endpoints
// ============================================================

// Auto-fetch cover for a single sequence (MusicBrainz primary, iTunes fallback)
router.post('/sequences/:id/fetch-cover', requireAdmin, async (req, res) => {
  const seq = db.prepare(`SELECT id, name, display_name, artist FROM sequences WHERE id = ?`).get(Number(req.params.id));
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  try {
    const { autoFetchCover, bustCoverUrl } = require('../lib/cover-art');
    const localPath = await autoFetchCover(seq);
    if (!localPath) return res.json({ ok: false, message: 'No cover found' });
    db.prepare(`UPDATE sequences SET image_url = ? WHERE id = ?`).run(localPath, seq.id);
    const io = req.app.get('io');
    if (io) io.emit('sequencesReordered'); // re-use to trigger list refresh
    res.json({ ok: true, image_url: bustCoverUrl(localPath) });
  } catch (err) {
    console.error('fetch-cover error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-fetch covers for ALL sequences missing one (background job)
router.post('/sequences/fetch-all-covers', requireAdmin, async (req, res) => {
  const missing = db.prepare(`
    SELECT id, name, display_name, artist FROM sequences
    WHERE (image_url IS NULL OR image_url = '') AND visible = 1
  `).all();
  // Respond immediately and run async — don't block the request
  res.json({ ok: true, queued: missing.length });

  const { autoFetchCover } = require('../lib/cover-art');
  const update = db.prepare(`UPDATE sequences SET image_url = ? WHERE id = ?`);

  for (const seq of missing) {
    try {
      const localPath = await autoFetchCover(seq);
      if (localPath) {
        update.run(localPath, seq.id);
        console.log(`Fetched cover for: ${seq.display_name || seq.name}`);
      } else {
        console.log(`No cover found for: ${seq.display_name || seq.name}`);
      }
    } catch (e) {
      console.warn(`Cover fetch failed for ${seq.name}:`, e.message);
    }
    // Be nice to MusicBrainz — they rate-limit at 1 req/s
    await new Promise(r => setTimeout(r, 1100));
  }
  console.log(`Bulk cover fetch complete (processed ${missing.length}).`);
});

// Manual search — returns candidate covers from both sources
router.get('/cover-search', requireAdmin, async (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const title = String(req.query.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { searchCovers } = require('../lib/cover-art');
    const candidates = await searchCovers(artist, title);
    res.json({ candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set a sequence's cover from a specific URL (used by manual search modal)
router.post('/sequences/:id/cover', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const seq = db.prepare(`SELECT id FROM sequences WHERE id = ?`).get(id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { downloadCover, bustCoverUrl } = require('../lib/cover-art');
    const localPath = await downloadCover(url, id);
    db.prepare(`UPDATE sequences SET image_url = ? WHERE id = ?`).run(localPath, id);
    const io = req.app.get('io');
    if (io) io.emit('sequencesReordered'); // re-use to trigger list refresh
    res.json({ ok: true, image_url: bustCoverUrl(localPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear a cover (delete file + null the URL)
router.delete('/sequences/:id/cover', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const seq = db.prepare(`SELECT id, image_url FROM sequences WHERE id = ?`).get(id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  if (seq.image_url && seq.image_url.startsWith('/covers/')) {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '..', 'data', 'covers', `${id}.jpg`);
    try { fs.unlinkSync(filePath); } catch (e) { /* file may not exist */ }
  }
  db.prepare(`UPDATE sequences SET image_url = NULL WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// ============================================================
// Title/artist metadata scraping
// ============================================================

// Scrape one sequence's metadata (used by per-row button)
router.post('/sequences/:id/scrape-metadata', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const seq = db.prepare(`SELECT id, name FROM sequences WHERE id = ?`).get(id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  try {
    const { scrapeMetadata } = require('../lib/metadata-scraper');
    const meta = await scrapeMetadata(seq.name);
    if (!meta || !meta.title) {
      return res.json({ ok: false, message: 'No metadata found' });
    }
    db.prepare(`UPDATE sequences SET display_name = ?, artist = ? WHERE id = ?`)
      .run(meta.title, meta.artist || null, id);
    res.json({ ok: true, ...meta });
  } catch (err) {
    console.error('scrape-metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scrape ALL sequences (background job, returns immediately)
router.post('/sequences/scrape-all-metadata', requireAdmin, async (req, res) => {
  // Optional: include-completed flag — by default we re-scrape everything
  // (per user preference: overwrite manual edits). Pass {skipExisting: true}
  // to opt into preserve-mode.
  const skipExisting = !!(req.body && req.body.skipExisting);
  const where = skipExisting
    ? `WHERE visible = 1 AND (artist IS NULL OR artist = '')`
    : `WHERE visible = 1`;
  const rows = db.prepare(`SELECT id, name FROM sequences ${where}`).all();

  res.json({ ok: true, queued: rows.length });

  const { scrapeMetadata } = require('../lib/metadata-scraper');
  const update = db.prepare(`UPDATE sequences SET display_name = ?, artist = ? WHERE id = ?`);
  let success = 0;
  let failed = 0;
  console.log(`[metadata] Scraping ${rows.length} sequences (skipExisting=${skipExisting})`);

  for (const row of rows) {
    try {
      const meta = await scrapeMetadata(row.name);
      if (meta && meta.title) {
        update.run(meta.title, meta.artist || null, row.id);
        success++;
        console.log(`[metadata] ${row.name} → "${meta.title}" / "${meta.artist || ''}" (${meta.source})`);
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.warn(`[metadata] Failed for ${row.name}:`, e.message);
    }
    // Be nice to iTunes — they don't publish a strict rate limit but we'll
    // pace ourselves at ~3/sec to stay under any reasonable threshold.
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`[metadata] Bulk scrape complete: ${success} updated, ${failed} skipped/failed`);

  // Tell admin clients to refresh their sequence list
  const io = req.app.get('io');
  if (io) io.emit('sequencesReordered'); // reuse existing event — admin reloads list
});

// ============================================================
// Per-sequence stats report
// Returns one row per sequence with plays/votes/requests/last_played.
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD to scope the date range.
// ============================================================
router.get('/stats/sequences', requireAdmin, (req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  // SQL date scoping clause
  let dateClause = '';
  const dateParams = [];
  if (from) { dateClause += ' AND played_at >= ?'; dateParams.push(from + ' 00:00:00'); }
  if (to)   { dateClause += ' AND played_at <= ?'; dateParams.push(to + ' 23:59:59'); }

  const sequences = db.prepare(`
    SELECT id, name, display_name, artist, image_url, last_played_at
    FROM sequences ORDER BY display_order, display_name
  `).all();

  // Plays per sequence (viewer-driven only)
  const playsBySource = db.prepare(`
    SELECT sequence_name,
           SUM(CASE WHEN source = 'vote' THEN 1 ELSE 0 END) AS votes_played,
           SUM(CASE WHEN source = 'request' THEN 1 ELSE 0 END) AS requests_played,
           SUM(CASE WHEN source = 'psa' THEN 1 ELSE 0 END) AS psa_played,
           SUM(CASE WHEN source = 'schedule' THEN 1 ELSE 0 END) AS schedule_played,
           COUNT(*) AS total_played,
           MAX(played_at) AS last_played_history
    FROM play_history
    WHERE 1=1${dateClause}
    GROUP BY sequence_name
  `).all(...dateParams);

  // Build lookup for fast merge
  const playsMap = {};
  for (const row of playsBySource) playsMap[row.sequence_name] = row;

  // Total votes received per sequence (across all time — votes don't have played_at, just timestamp)
  const voteParams = [];
  let voteDateClause = '';
  if (from) { voteDateClause += ' AND voted_at >= ?'; voteParams.push(from + ' 00:00:00'); }
  if (to)   { voteDateClause += ' AND voted_at <= ?'; voteParams.push(to + ' 23:59:59'); }
  const votesReceived = db.prepare(`
    SELECT sequence_name, COUNT(*) AS votes_received
    FROM votes
    WHERE 1=1${voteDateClause}
    GROUP BY sequence_name
  `).all(...voteParams);
  const votesMap = {};
  for (const row of votesReceived) votesMap[row.sequence_name] = row.votes_received;

  // Total requests received per sequence
  const reqParams = [];
  let reqDateClause = '';
  if (from) { reqDateClause += ' AND requested_at >= ?'; reqParams.push(from + ' 00:00:00'); }
  if (to)   { reqDateClause += ' AND requested_at <= ?'; reqParams.push(to + ' 23:59:59'); }
  const requestsReceived = db.prepare(`
    SELECT sequence_name, COUNT(*) AS requests_received
    FROM jukebox_queue
    WHERE 1=1${reqDateClause}
    GROUP BY sequence_name
  `).all(...reqParams);
  const requestsMap = {};
  for (const row of requestsReceived) requestsMap[row.sequence_name] = row.requests_received;

  const rows = sequences.map(seq => {
    const p = playsMap[seq.name] || {};
    return {
      id: seq.id,
      name: seq.name,
      display_name: seq.display_name || seq.name,
      artist: seq.artist || '',
      image_url: seq.image_url || null,
      total_played: p.total_played || 0,
      votes_played: p.votes_played || 0,
      requests_played: p.requests_played || 0,
      psa_played: p.psa_played || 0,
      schedule_played: p.schedule_played || 0,
      votes_received: votesMap[seq.name] || 0,
      requests_received: requestsMap[seq.name] || 0,
      last_played_at: p.last_played_history || seq.last_played_at,
    };
  });

  // Sort by viewer-driven plays desc by default
  rows.sort((a, b) =>
    (b.votes_played + b.requests_played) - (a.votes_played + a.requests_played)
  );

  res.json({ rows, from, to });
});

// CSV export
router.get('/stats/sequences.csv', requireAdmin, (req, res) => {
  // Reuse the sequences endpoint logic — just call ourselves internally
  // by duplicating the query. Simpler than abstracting since it's a small endpoint.
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  let dateClause = '';
  const dateParams = [];
  if (from) { dateClause += ' AND played_at >= ?'; dateParams.push(from + ' 00:00:00'); }
  if (to)   { dateClause += ' AND played_at <= ?'; dateParams.push(to + ' 23:59:59'); }

  const sequences = db.prepare(`SELECT name, display_name, artist FROM sequences ORDER BY display_name`).all();
  const playsBySource = db.prepare(`
    SELECT sequence_name,
           SUM(CASE WHEN source = 'vote' THEN 1 ELSE 0 END) AS votes_played,
           SUM(CASE WHEN source = 'request' THEN 1 ELSE 0 END) AS requests_played,
           COUNT(*) AS total_played,
           MAX(played_at) AS last_played_history
    FROM play_history
    WHERE 1=1${dateClause}
    GROUP BY sequence_name
  `).all(...dateParams);
  const playsMap = {};
  for (const row of playsBySource) playsMap[row.sequence_name] = row;

  const csvEscape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = ['Sequence,Artist,Total Plays,Votes Played,Requests Played,Last Played'];
  for (const seq of sequences) {
    const p = playsMap[seq.name] || {};
    lines.push([
      csvEscape(seq.display_name || seq.name),
      csvEscape(seq.artist || ''),
      p.total_played || 0,
      p.votes_played || 0,
      p.requests_played || 0,
      csvEscape(p.last_played_history || ''),
    ].join(','));
  }

  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="openfalcon-stats-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
});

// ============================================================
// Reset stats — separate endpoints for granular resets
// ============================================================
router.post('/stats/reset/play-history', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM play_history`).run();
  db.prepare(`UPDATE sequences SET last_played_at = NULL, plays_since_hidden = 0`).run();
  const io = req.app.get('io');
  if (io) io.emit('sequencesReordered');
  res.json({ ok: true });
});

router.post('/stats/reset/votes', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM votes`).run();
  // Reset round counter so a fresh round starts cleanly
  const cfg = getConfig();
  updateConfig({ current_voting_round: (cfg.current_voting_round || 0) + 1 });
  const io = req.app.get('io');
  if (io) io.emit('voteReset');
  res.json({ ok: true });
});

router.post('/stats/reset/queue', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM jukebox_queue`).run();
  const io = req.app.get('io');
  if (io) io.emit('queueUpdated');
  res.json({ ok: true });
});

router.post('/stats/reset/all', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM play_history`).run();
  db.prepare(`DELETE FROM votes`).run();
  db.prepare(`DELETE FROM jukebox_queue`).run();
  db.prepare(`UPDATE sequences SET last_played_at = NULL, plays_since_hidden = 0`).run();
  const cfg = getConfig();
  updateConfig({ current_voting_round: (cfg.current_voting_round || 0) + 1 });
  const io = req.app.get('io');
  if (io) {
    io.emit('sequencesReordered');
    io.emit('voteReset');
    io.emit('queueUpdated');
  }
  res.json({ ok: true });
});

// ============================================================
// Queue management — full queue with admin remove
// ============================================================
router.get('/queue', requireAdmin, (req, res) => {
  // Return the full queue: pending (handed_off_at IS NULL), in-flight (NOT NULL & played=0), and recently played
  const pending = db.prepare(`
    SELECT q.id, q.sequence_name, q.requested_at, q.viewer_token, q.handed_off_at, q.played,
           s.display_name, s.artist, s.image_url
    FROM jukebox_queue q
    LEFT JOIN sequences s ON s.name = q.sequence_name
    WHERE q.played = 0
    ORDER BY q.requested_at ASC
  `).all();

  const recentlyPlayed = db.prepare(`
    SELECT q.id, q.sequence_name, q.requested_at, q.played_at,
           s.display_name, s.artist, s.image_url
    FROM jukebox_queue q
    LEFT JOIN sequences s ON s.name = q.sequence_name
    WHERE q.played = 1
    ORDER BY q.played_at DESC
    LIMIT 20
  `).all();

  res.json({ pending, recentlyPlayed });
});

router.delete('/queue/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM jukebox_queue WHERE id = ?`).run(id);
  const io = req.app.get('io');
  if (io) io.emit('queueUpdated');
  res.json({ ok: true });
});

module.exports = router;
