// ============================================================
// ShowPilot — Admin API
// Authenticated endpoints for managing the show.
// Auth: JWT in httpOnly cookie.
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const config = require('../lib/config-loader');
const { db, getConfig, updateConfig,
        listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot, renameSnapshot } = require('../lib/db');

// ============================================================
// Rate limiting
// ============================================================
// Limit login attempts to slow brute-force attacks. We track by source IP
// (which respects the trustProxy config setting — direct deployments see
// real remote IPs, reverse-proxy deployments see X-Forwarded-For).
//
// 8 attempts per 15 minutes per IP is generous for legitimate users
// (forgotten passwords, typos) but ruinous for online brute force when
// combined with bcrypt's slow comparison.
//
// We don't count successful logins toward the limit. The handler checks
// the result and only triggers the limiter on auth failures.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Don't count successful logins. The limiter sees every request, but
  // skipSuccessfulRequests means a 200/2xx response doesn't burn the budget.
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
});

// ============================================================
// Auth
// ============================================================

// Session length defaults to config.sessionDurationHours (typically 24h).
// If user has remember_me=1, we extend to 30 days.
const REMEMBER_ME_DAYS = 30;

function requireAdmin(req, res, next) {
  const token = req.cookies[config.sessionCookieName];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (!payload.userId) return res.status(401).json({ error: 'Invalid session' });
    const user = require('../lib/db').getUserById(payload.userId);
    if (!user || !user.enabled) {
      res.clearCookie(config.sessionCookieName);
      return res.status(401).json({ error: 'User no longer exists or is disabled' });
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
}

function issueSessionCookie(res, user, req) {
  const expiresIn = user.remember_me ? `${REMEMBER_ME_DAYS}d` : `${config.sessionDurationHours}h`;
  const maxAge = user.remember_me
    ? REMEMBER_ME_DAYS * 24 * 3600 * 1000
    : config.sessionDurationHours * 3600 * 1000;
  const token = jwt.sign({ userId: user.id, username: user.username }, config.jwtSecret, { expiresIn });
  // Auto-set `secure` flag whenever the request came in over HTTPS. We
  // detect via req.secure (which respects Express's `trust proxy` setting,
  // so reverse-proxy users get HTTPS detected via X-Forwarded-Proto when
  // they have trustProxy enabled). For plain-HTTP deployments (LAN-only,
  // testing) the flag stays off — otherwise the browser would reject the
  // cookie and the user couldn't log in at all.
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!(req && req.secure),
  };
  // If remember_me is OFF, omit maxAge so it's a session cookie that dies with the browser
  if (user.remember_me) cookieOpts.maxAge = maxAge;
  res.cookie(config.sessionCookieName, token, cookieOpts);
}

// POST /api/admin/login — body: { username, password, rememberMe }
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const { getUserByUsername, recordUserLogin, updateUser } = require('../lib/db');
  const user = getUserByUsername(String(username).trim());
  if (!user || !user.enabled) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Persist remember_me preference if it changed
  if (!!user.remember_me !== !!rememberMe) {
    updateUser(user.id, { remember_me: rememberMe ? 1 : 0 });
    user.remember_me = rememberMe ? 1 : 0;
  }

  recordUserLogin(user.id);
  issueSessionCookie(res, user, req);
  res.json({
    ok: true,
    username: user.username,
    mustChangePassword: !!user.must_change_password,
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.sessionCookieName);
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    username: req.user.username,
    userId: req.user.id,
    rememberMe: !!req.user.remember_me,
    mustChangePassword: !!req.user.must_change_password,
  });
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
    'viewer_request_limit',
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
    'page_snow_enabled',
    'player_custom_color',
    // External access
    'public_base_url',
    'audio_gate_enabled',
    'audio_gate_radius_miles',
    'audio_sync_offset_ms',
    'viewer_source_obfuscate',
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

// ============================================================
// User self-service: change own password
// ============================================================

router.post('/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }

  const { setUserPassword } = require('../lib/db');
  const match = await bcrypt.compare(currentPassword || '', req.user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = await bcrypt.hash(newPassword, 10);
  setUserPassword(req.user.id, hash, false);
  res.json({ ok: true });
});

// ============================================================
// User management (admin actions on other users)
// ============================================================

router.get('/users', requireAdmin, (req, res) => {
  const { listUsers } = require('../lib/db');
  res.json({ users: listUsers() });
});

router.post('/users', requireAdmin, async (req, res) => {
  const { username, password, mustChangePassword } = req.body || {};
  const u = String(username || '').trim();
  if (!u) return res.status(400).json({ error: 'Username required' });
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(u)) {
    return res.status(400).json({ error: 'Username must be 2-32 characters: letters, digits, _ . -' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const { getUserByUsername, createUser } = require('../lib/db');
  if (getUserByUsername(u)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hash = await bcrypt.hash(password, 10);
  const id = createUser({
    username: u,
    passwordHash: hash,
    mustChangePassword: !!mustChangePassword,
  });
  res.json({ ok: true, id });
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { getUserById, getUserByUsername, updateUser, countUsers } = require('../lib/db');
  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const fields = {};
  if ('username' in req.body) {
    const u = String(req.body.username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(u)) {
      return res.status(400).json({ error: 'Username must be 2-32 characters: letters, digits, _ . -' });
    }
    const existing = getUserByUsername(u);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    fields.username = u;
  }
  if ('enabled' in req.body) {
    const newEnabled = req.body.enabled ? 1 : 0;
    // Don't allow disabling the last enabled user — would lock everyone out
    if (!newEnabled && target.enabled && countUsers() <= 1) {
      return res.status(400).json({ error: 'Cannot disable the last enabled user' });
    }
    // Also don't allow disabling yourself
    if (!newEnabled && id === req.user.id) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    fields.enabled = newEnabled;
  }
  if ('mustChangePassword' in req.body) {
    fields.must_change_password = req.body.mustChangePassword ? 1 : 0;
  }

  updateUser(id, fields);
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const { getUserById, setUserPassword } = require('../lib/db');
  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const hash = await bcrypt.hash(newPassword, 10);
  // Force the user to change it on next login (since admin chose it)
  setUserPassword(id, hash, true);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const { getUserById, deleteUser, countUsers } = require('../lib/db');
  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (countUsers() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last user' });
  }
  deleteUser(id);
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
  const id = Number(req.params.id);
  // Capture the media_name BEFORE delete so we can detach any cached
  // audio bytes pointing at it. Without this, deleting a sequence
  // leaves orphan rows in audio_cache_files and orphan files on disk.
  const seq = db.prepare(`SELECT media_name FROM sequences WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM sequences WHERE id = ?`).run(id);
  if (seq && seq.media_name) {
    detachCacheForMediaName(seq.media_name);
  }
  res.json({ ok: true });
});

// Helper: detach (set media_name = NULL) any audio_cache_files rows for
// the given media_name. Called when a sequence is deleted so orphaned
// cache rows can be cleaned by pruneOrphanedHashes(). We don't delete
// the bytes immediately — prune handles that — keeping cleanup batched
// and giving an admin a chance to re-create the sequence with the same
// media_name without re-uploading.
function detachCacheForMediaName(mediaName) {
  try {
    db.prepare(`
      UPDATE audio_cache_files SET media_name = NULL WHERE media_name = ?
    `).run(mediaName);
  } catch (err) {
    // Cache table may not exist on very old installs that haven't
    // migrated yet. Failing silently here is correct — the sequence
    // delete itself succeeded, this is just bookkeeping.
    console.warn('[admin] cache detach failed (table missing?):', err.message);
  }
}

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
  // Capture media_names of about-to-delete rows so cache cleanup can
  // follow. Same pattern as the single-delete endpoint.
  const doomed = db.prepare(`
    SELECT media_name FROM sequences
    WHERE visible = 0 AND votable = 0 AND jukeboxable = 0 AND is_psa = 0
      AND media_name IS NOT NULL
  `).all();
  const result = db.prepare(`
    DELETE FROM sequences
    WHERE visible = 0 AND votable = 0 AND jukeboxable = 0 AND is_psa = 0
  `).run();
  for (const row of doomed) {
    detachCacheForMediaName(row.media_name);
  }
  res.json({ ok: true, deleted: result.changes });
});

// Delete ALL sequences. Wrapped in a transaction so dependent rows (votes,
// jukebox queue, play history) come along too — these have ON DELETE CASCADE
// constraints, but the transaction still gives us atomicity if any of those
// cascade deletes were to fail. The frontend gates this behind a typed
// "DELETE ALL" confirmation so it's hard to fire accidentally.
router.post('/sequences/delete-all', requireAdmin, (req, res) => {
  const tx = db.transaction(() => {
    const r = db.prepare(`DELETE FROM sequences`).run();
    return r.changes;
  });
  try {
    const deleted = tx();
    // All sequences gone — every cache row is now orphaned. Detach them
    // all so the next prune sweeps them up. We don't drop the cache
    // wholesale here in case admin is reorganizing and plans to re-sync
    // the same files (saves re-upload).
    try {
      db.prepare(`UPDATE audio_cache_files SET media_name = NULL`).run();
    } catch (err) {
      console.warn('[admin] cache detach-all failed (table missing?):', err.message);
    }
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[delete-all] failed:', err);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
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

// ============================================================
// Visitor analytics — backs the Dashboard charts
// ============================================================
//
// Returns three time-bucketed series (unique visitors, total visits, total
// requests) plus summary KPIs across "today", "this season" (since Oct 1 of
// the most recent fall), and all-time. Buckets are picked based on range so
// the chart doesn't get unreadable: hourly for today, daily for 7d/30d/season,
// monthly for "all".
// Visitor analytics endpoint. The route is named /stats/audience instead of
// /stats/visitors because most ad/tracking blockers (uBlock Origin, AdGuard,
// Brave shields) flag any URL containing "visitors" as analytics tracking
// and silently block the request — even on first-party admin pages. The
// data is what matters; the URL just needs to not match common blocklists.
router.get('/stats/audience', requireAdmin, (req, res) => {
  try {
    const range = String(req.query.range || '7d');

    // Map range → SQL window + bucket strftime format.
    // SQLite strftime('%Y-%m-%d %H:00:00', ...) gives hourly buckets;
    // strftime('%Y-%m-%d', ...) gives daily; strftime('%Y-%m', ...) gives monthly.
    let sinceClause = '';
    let bucketFmt = '%Y-%m-%d';
    let bucketStep = 'day';

    if (range === 'today') {
      sinceClause = `visited_at >= date('now', 'localtime') AND visited_at < date('now', 'localtime', '+1 day')`;
      bucketFmt = '%Y-%m-%d %H:00:00';
      bucketStep = 'hour';
    } else if (range === '7d') {
      sinceClause = `visited_at >= date('now', '-7 days')`;
      bucketFmt = '%Y-%m-%d';
      bucketStep = 'day';
    } else if (range === '30d') {
      sinceClause = `visited_at >= date('now', '-30 days')`;
      bucketFmt = '%Y-%m-%d';
      bucketStep = 'day';
    } else if (range === 'season') {
      // "This season" = most recent fall (Oct 1 of current year if past Oct 1,
      // else Oct 1 of last year). Captures Halloween + Christmas in one window.
      const now = new Date();
      const seasonStart = new Date(now.getFullYear(), 9, 1); // month index 9 = October
      if (now < seasonStart) seasonStart.setFullYear(seasonStart.getFullYear() - 1);
      const iso = seasonStart.toISOString().slice(0, 10);
      sinceClause = `visited_at >= '${iso}'`;
      bucketFmt = '%Y-%m-%d';
      bucketStep = 'day';
    } else if (range === 'all') {
      sinceClause = `1=1`;
      bucketFmt = '%Y-%m';
      bucketStep = 'month';
    } else {
      return res.status(400).json({ error: 'Invalid range' });
    }

    // For requests, the source-of-truth is jukebox_queue (every request lands
    // there with requested_at). Voting submissions go to votes (with voted_at),
    // so we union both for "total requests" — anything a viewer actively chose.
    const requestsTable = `(
      SELECT requested_at AS at FROM jukebox_queue
      UNION ALL
      SELECT voted_at AS at FROM votes
    )`;

    // Replace visited_at in sinceClause for the requests query
    const requestsSinceClause = sinceClause.replace(/visited_at/g, 'at');

    const visitsBuckets = db.prepare(`
      SELECT strftime('${bucketFmt}', visited_at, 'localtime') AS bucket,
             COUNT(*) AS visits,
             COUNT(DISTINCT visitor_id) AS uniques
      FROM viewer_visits
      WHERE ${sinceClause}
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all();

    const requestsBuckets = db.prepare(`
      SELECT strftime('${bucketFmt}', at, 'localtime') AS bucket,
             COUNT(*) AS requests
      FROM ${requestsTable}
      WHERE ${requestsSinceClause}
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all();

    // Merge into a unified bucket-keyed map so frontend has aligned x-axis values
    const bucketMap = new Map();
    for (const row of visitsBuckets) {
      bucketMap.set(row.bucket, { bucket: row.bucket, uniques: row.uniques, visits: row.visits, requests: 0 });
    }
    for (const row of requestsBuckets) {
      const existing = bucketMap.get(row.bucket);
      if (existing) existing.requests = row.requests;
      else bucketMap.set(row.bucket, { bucket: row.bucket, uniques: 0, visits: 0, requests: row.requests });
    }
    const series = Array.from(bucketMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

    // Summary KPIs (range-bound + today + all-time)
    const todayStats = db.prepare(`
      SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniques
      FROM viewer_visits
      WHERE visited_at >= date('now', 'localtime')
    `).get();
    const todayRequests = db.prepare(`
      SELECT COUNT(*) AS n FROM ${requestsTable}
      WHERE at >= date('now', 'localtime')
    `).get().n;

    const allStats = db.prepare(`
      SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniques
      FROM viewer_visits
    `).get();
    const allRequests = db.prepare(`
      SELECT COUNT(*) AS n FROM ${requestsTable}
    `).get().n;

    // Range-bound summary (matches the chart window)
    const rangeStats = db.prepare(`
      SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniques
      FROM viewer_visits
      WHERE ${sinceClause}
    `).get();
    const rangeRequests = db.prepare(`
      SELECT COUNT(*) AS n FROM ${requestsTable}
      WHERE ${requestsSinceClause}
    `).get().n;

    res.json({
      range,
      bucketStep,
      series,
      summary: {
        today: { uniques: todayStats.uniques, visits: todayStats.visits, requests: todayRequests },
        range: { uniques: rangeStats.uniques, visits: rangeStats.visits, requests: rangeRequests },
        allTime: { uniques: allStats.uniques, visits: allStats.visits, requests: allRequests },
      },
    });
  } catch (err) {
    console.error('[stats/audience] failed:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Show the current show token (for pasting into FPP plugin)
router.get('/show-token', requireAdmin, (req, res) => {
  res.json({ showToken: config.showToken });
});

// Audio cache stats — file count and total bytes used. Drives the
// "Audio cache: N files, X MB" display in the admin Settings tab.
router.get('/audio-cache/stats', requireAdmin, (req, res) => {
  const audioCache = require('../lib/audio-cache');
  res.json(audioCache.getCacheStats());
});

// Clear the entire audio cache. Useful when the plugin uploaded files
// with a format issue (e.g. a bad ffmpeg invocation produced unplayable
// M4A) and we need to force a fresh re-sync. Removes both the on-disk
// files AND the database rows. Next plugin sync will repopulate.
router.post('/audio-cache/clear', requireAdmin, (req, res) => {
  const fs = require('fs');
  const audioCache = require('../lib/audio-cache');
  const { db } = require('../lib/db');
  let removed = 0;
  try {
    // Walk the on-disk cache dir directly — handles cases where the
    // DB and disk got out of sync.
    const dir = audioCache.cacheDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.bin'));
    for (const f of files) {
      try { fs.unlinkSync(`${dir}/${f}`); removed++; } catch (_) { /* ignore */ }
    }
    // Then truncate the DB table so subsequent manifest queries return empty.
    db.prepare('DELETE FROM audio_cache_files').run();
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[admin/audio-cache/clear] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// List all cached audio files with metadata. Drives the per-file table
// in admin Settings → Audio Cache, which lets admins see exactly what's
// cached and delete individual entries. Joins against sequences so the
// admin can see which display name (if any) each cache row maps to —
// orphan rows show as "(no sequence)".
router.get('/audio-cache/files', requireAdmin, (req, res) => {
  const { db } = require('../lib/db');
  try {
    const rows = db.prepare(`
      SELECT
        c.hash,
        c.media_name,
        c.size_bytes,
        c.mime_type,
        c.cached_at,
        s.display_name AS sequence_display_name,
        s.id AS sequence_id
      FROM audio_cache_files c
      LEFT JOIN sequences s ON s.media_name = c.media_name
      ORDER BY c.cached_at DESC
    `).all();
    res.json({ files: rows });
  } catch (err) {
    console.error('[admin/audio-cache/files] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete one specific cache entry (file + DB row). Useful for evicting
// known-bad uploads without nuking the whole cache. Hash is validated
// to match the SHA-256 hex format before touching the filesystem.
router.delete('/audio-cache/files/:hash', requireAdmin, (req, res) => {
  const fs = require('fs');
  const audioCache = require('../lib/audio-cache');
  const { db } = require('../lib/db');
  const hash = String(req.params.hash || '').toLowerCase();
  if (!audioCache.isValidHash(hash)) {
    return res.status(400).json({ error: 'Invalid hash format' });
  }
  try {
    const filePath = audioCache.pathForHash(hash);
    let fileRemoved = false;
    try {
      fs.unlinkSync(filePath);
      fileRemoved = true;
    } catch (_) {
      // File may already be gone; not an error from the user's POV.
    }
    const r = db.prepare(`DELETE FROM audio_cache_files WHERE hash = ?`).run(hash);
    res.json({ ok: true, fileRemoved, rowsRemoved: r.changes });
  } catch (err) {
    console.error('[admin/audio-cache/files/:hash] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Prune orphaned cache entries (rows whose media_name is NULL or no
// longer matches any sequence). Returns the count removed. Same as the
// plugin endpoint but admin-authenticated, callable from the Audio
// Cache UI.
router.post('/audio-cache/prune', requireAdmin, (req, res) => {
  const audioCache = require('../lib/audio-cache');
  try {
    const removed = audioCache.pruneOrphanedHashes();
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[admin/audio-cache/prune] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Viewer Page Templates (CRUD)
// ============================================================

router.get('/templates', requireAdmin, (req, res) => {
  // Summary list — don't ship the HTML body in the list endpoint (can be huge).
  // Include `locked` so the sidebar can show the 🔒 badge.
  const rows = db.prepare(`
    SELECT id, name, is_active, is_builtin, locked,
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
  const { name, html, favicon_url } = req.body || {};
  const existing = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  if (existing.locked) return res.status(423).json({ error: 'Template is locked. Unlock to edit.' });

  const updates = [];
  const params = { id, now: new Date().toISOString() };
  if (name !== undefined) { updates.push('name = @name'); params.name = String(name).trim(); }
  if (html !== undefined) { updates.push('html = @html'); params.html = String(html); }
  if (favicon_url !== undefined) {
    // Light validation — accept empty string (clears favicon), URL-ish strings,
    // or data: URLs from the file-upload path. Cap data URLs at ~200KB encoded
    // (a roomy ceiling for any reasonable favicon — even a 256x256 PNG fits)
    // to prevent someone from stuffing a large image into the field.
    const v = String(favicon_url);
    if (v.length > 200000) {
      return res.status(413).json({ error: 'Favicon too large (max ~200KB after base64 encoding).' });
    }
    updates.push('favicon_url = @favicon_url');
    params.favicon_url = v;
  }
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
  if (row.locked) return res.status(423).json({ error: "Can't delete a locked template. Unlock it first." });
  db.prepare(`DELETE FROM viewer_page_templates WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Toggle the lock state. Locked templates can be viewed but edits, commits,
// renames, and deletes are blocked until unlocked. This protects committed
// templates (especially purchased ones) from accidental overwrites during
// designer experimentation.
router.post('/templates/:id/toggle-lock', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  const newLocked = row.locked ? 0 : 1;
  db.prepare(`UPDATE viewer_page_templates SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newLocked, id);
  res.json({ ok: true, locked: newLocked });
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
// Visual Designer
//
// Settings & Blocks modes both generate HTML. We store the form values
// (settings_json) and block layout (blocks_json) on the template row so
// users can reopen and continue editing in those modes. The 'mode' column
// records which mode produced the current html.
//
// Live preview workflow: client PATCHes pending values to /draft, server
// re-renders draft_html and stores it. The viewer page can be loaded with
// ?preview=<id> to render against the draft instead of html. Promote draft
// to html with /commit when user clicks Save.
// ============================================================

router.get('/designer/blocks', requireAdmin, (req, res) => {
  const { listBlockTypes } = require('../lib/visual-designer');
  res.json({ blocks: listBlockTypes() });
});

router.get('/designer/defaults', requireAdmin, (req, res) => {
  const { DEFAULT_SETTINGS } = require('../lib/visual-designer');
  res.json({ settings: DEFAULT_SETTINGS });
});

// PATCH a draft for the active template (or one specified by ?id=).
// Body: { mode: 'settings'|'blocks'|'code', settings, blocks, html }
// Returns the rendered draft HTML so the client can refresh the preview.
router.post('/templates/:id/draft', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  if (row.locked) return res.status(423).json({ error: 'Template is locked. Unlock to edit.' });

  const { renderSettingsTemplate, renderBlocksTemplate } = require('../lib/visual-designer');
  const { mode, settings, blocks, html } = req.body || {};
  let draftHtml = '';
  let settingsJson = '';
  let blocksJson = '';

  if (mode === 'settings') {
    draftHtml = renderSettingsTemplate(settings || {});
    settingsJson = JSON.stringify(settings || {});
  } else if (mode === 'blocks') {
    draftHtml = renderBlocksTemplate(blocks || [], settings || {});
    blocksJson = JSON.stringify(blocks || []);
    settingsJson = JSON.stringify(settings || {});
  } else {
    // 'code' mode — html is authoritative
    draftHtml = String(html || '');
  }

  const updates = ['draft_html = @draft_html', 'draft_updated_at = CURRENT_TIMESTAMP', 'mode = @mode'];
  const params = { id, draft_html: draftHtml, mode: mode || 'code' };
  if (settingsJson) { updates.push('settings_json = @settings_json'); params.settings_json = settingsJson; }
  if (blocksJson) { updates.push('blocks_json = @blocks_json'); params.blocks_json = blocksJson; }
  db.prepare(`UPDATE viewer_page_templates SET ${updates.join(', ')} WHERE id = @id`).run(params);

  res.json({ ok: true, html: draftHtml });
});

// Commit the draft as the live HTML. Clears draft fields.
router.post('/templates/:id/commit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM viewer_page_templates WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  if (row.locked) return res.status(423).json({ error: 'Template is locked. Unlock to commit changes.' });
  if (!row.draft_html) return res.status(400).json({ error: 'No draft to commit' });
  db.prepare(`
    UPDATE viewer_page_templates
    SET html = draft_html,
        draft_html = '',
        draft_updated_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  res.json({ ok: true });
});

// Discard the current draft and return to the saved html.
router.post('/templates/:id/discard-draft', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`
    UPDATE viewer_page_templates
    SET draft_html = '', draft_updated_at = NULL
    WHERE id = ?
  `).run(id);
  res.json({ ok: true });
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

// Manual TRACK search — used by the per-row search modal in the Sequences
// tab. Different from /cover-search above (which takes artist+title and is
// used for the cover-only picker): this takes a single free-form query
// string and returns candidates with title, artist, AND cover. The user
// chooses one and the frontend POSTs to /sequences/:id/apply-search-result
// to write all three fields atomically.
router.get('/track-search', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const { searchTracks } = require('../lib/cover-art');
    const results = await searchTracks(q);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply a chosen search result to a sequence — atomic update of
// display_name + artist + cover. Frontend sends back the title/artist
// strings AND the coverUrl (the high-res variant from the search result),
// because the search result list is held in the browser and these are
// trivially small to round-trip.
router.post('/sequences/:id/apply-search-result', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const seq = db.prepare(`SELECT id FROM sequences WHERE id = ?`).get(id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  const { title, artist, coverUrl } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  // Pull the cover file first; if it fails we don't want to leave the row
  // half-updated (new title/artist but stale cover). We're tolerant of
  // missing cover URLs — those just don't update the image.
  let localCoverPath = null;
  if (coverUrl) {
    try {
      const { downloadCover } = require('../lib/cover-art');
      localCoverPath = await downloadCover(coverUrl, id);
    } catch (err) {
      // Don't fail the whole apply over a cover problem — surface it but
      // still write the title/artist updates the user explicitly chose.
      console.warn(`[apply-search-result] cover download failed for seq ${id}:`, err.message);
    }
  }

  const updates = ['display_name = ?', 'artist = ?'];
  const params = [String(title).trim(), String(artist || '').trim()];
  if (localCoverPath) {
    updates.push('image_url = ?');
    params.push(localCoverPath);
  }
  params.push(id);
  db.prepare(`UPDATE sequences SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const io = req.app.get('io');
  if (io) io.emit('sequencesReordered');

  const { bustCoverUrl } = require('../lib/cover-art');
  res.json({
    ok: true,
    image_url: localCoverPath ? bustCoverUrl(localCoverPath) : null,
    coverApplied: !!localCoverPath,
  });
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
  res.set('Content-Disposition', `attachment; filename="showpilot-stats-${new Date().toISOString().slice(0,10)}.csv"`);
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

// ============================================================
// Sequence snapshots — save/restore the sequences list as a named snapshot
// ============================================================

router.get('/snapshots', requireAdmin, (req, res) => {
  res.json({ snapshots: listSnapshots() });
});

router.post('/snapshots', requireAdmin, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = createSnapshot(String(name).trim(), description ? String(description).trim() : null);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/snapshots/:id/restore', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const restored = restoreSnapshot(id);
    if (restored === 0) return res.status(404).json({ error: 'snapshot not found or empty' });
    res.json({ ok: true, restored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/snapshots/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  renameSnapshot(id, String(name).trim(), description ? String(description).trim() : null);
  res.json({ ok: true });
});

router.delete('/snapshots/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  deleteSnapshot(id);
  res.json({ ok: true });
});

// ============================================================
// Geocoding — address → lat/lng via OpenStreetMap Nominatim
//
// Nominatim's usage policy requires a real User-Agent identifying the
// application + an absolute rate limit of 1 request/second. We proxy
// server-side so:
//   (1) We can set a proper User-Agent (browsers can't override it freely)
//   (2) We don't leak the admin's IP/headers to Nominatim
//   (3) We can rate-limit if needed (admin UI is not high-volume anyway)
// ============================================================
let _lastGeocodeAt = 0;
router.get('/geocode', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'query required' });
  if (q.length > 250) return res.status(400).json({ error: 'query too long' });

  // Simple rate limit: at most 1 geocode per second per server.
  // Nominatim's policy is strict; admins doing setup don't need more.
  const now = Date.now();
  const sinceLast = now - _lastGeocodeAt;
  if (sinceLast < 1000) {
    await new Promise(r => setTimeout(r, 1000 - sinceLast));
  }
  _lastGeocodeAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: {
        // Nominatim usage policy requires an identifiable User-Agent.
        // Don't claim to be a browser.
        'User-Agent': 'ShowPilot-Admin/1.0 (https://github.com/ShowPilotFPP/ShowPilot)',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return res.status(502).json({ error: 'geocode upstream returned ' + r.status });
    const results = await r.json();
    if (!Array.isArray(results) || results.length === 0) {
      return res.json(null);
    }
    const top = results[0];
    res.json({
      lat: parseFloat(top.lat),
      lng: parseFloat(top.lon),
      displayName: top.display_name || '',
    });
  } catch (err) {
    console.error('[geocode] error:', err.message);
    res.status(500).json({ error: 'geocode failed: ' + err.message });
  }
});

module.exports = router;
