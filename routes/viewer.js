// ============================================================
// OpenFalcon — Viewer API
// Public endpoints consumed by the viewer page (browser).
// Enforces all viewer-side safeguards configured in admin.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const config = require('../config');
const { db, getConfig, getNowPlaying, getActiveViewerCount, getSequenceByName } = require('../lib/db');

function ensureViewerToken(req, res) {
  let token = req.cookies[config.sessionCookieName + '_viewer'];
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    res.cookie(config.sessionCookieName + '_viewer', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  return token;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
}

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ipIsBlocked(cfg, ip) {
  if (!cfg.blocked_ips) return false;
  const list = cfg.blocked_ips.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(ip);
}

function isSequenceHidden(seq, cfg) {
  if (!cfg.hide_sequence_after_played || cfg.hide_sequence_after_played === 0) return false;
  if (!seq.last_played_at) return false;
  return seq.plays_since_hidden < cfg.hide_sequence_after_played;
}

function viewerPresenceCheck(req, cfg) {
  if (!cfg.check_viewer_present) return { ok: true };
  if (cfg.viewer_present_mode !== 'GPS') return { ok: true };
  if (!cfg.show_latitude || !cfg.show_longitude) {
    return { ok: false, error: 'Show location not configured on server' };
  }
  const lat = parseFloat(req.body?.viewerLat ?? req.query?.lat);
  const lng = parseFloat(req.body?.viewerLng ?? req.query?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'Location required to vote/request. Please allow location access.' };
  }
  const dist = distanceMiles(cfg.show_latitude, cfg.show_longitude, lat, lng);
  if (dist > cfg.check_radius_miles) {
    return { ok: false, error: `You must be within ${cfg.check_radius_miles} miles of the show to interact.` };
  }
  return { ok: true };
}

function runSafeguards(req, res, requiredMode) {
  const cfg = getConfig();
  if (cfg.viewer_control_mode !== requiredMode) {
    res.status(400).json({ error: `${requiredMode.toLowerCase()} is not currently enabled` });
    return null;
  }
  const ip = getClientIp(req);
  if (ipIsBlocked(cfg, ip)) {
    res.status(403).json({ error: 'Your IP has been blocked' });
    return null;
  }
  const presence = viewerPresenceCheck(req, cfg);
  if (!presence.ok) {
    res.status(403).json({ error: presence.error });
    return null;
  }
  return cfg;
}

router.get('/state', (req, res) => {
  const cfg = getConfig();
  const nowPlaying = getNowPlaying();
  const activeViewers = getActiveViewerCount();

  const allSequences = db.prepare(`
    SELECT id, name, display_name, artist, category, image_url,
           duration_seconds, votable, jukeboxable,
           last_played_at, plays_since_hidden
    FROM sequences
    WHERE visible = 1 AND is_psa = 0
    ORDER BY display_order, display_name
  `).all();

  const { bustSequenceCovers } = require('../lib/cover-art');
  const sequences = bustSequenceCovers(allSequences.filter(s => !isSequenceHidden(s, cfg)));

  const voteCounts = db.prepare(`
    SELECT sequence_name, COUNT(*) AS count FROM votes WHERE round_id = ? GROUP BY sequence_name
  `).all(cfg.current_voting_round);

  // Queue: all unplayed entries, ordered by request time. This now includes
  // entries currently handed off to the plugin (handed_off_at IS NOT NULL,
  // played=0). The currently-playing viewer request will be the first such
  // entry; everything after it is genuinely "queued behind."
  const queueAll = db.prepare(`
    SELECT sequence_name, requested_at, handed_off_at FROM jukebox_queue
    WHERE played = 0 ORDER BY requested_at ASC
  `).all();

  // Filter out the currently-playing entry from the queue display
  const nowPlayingName = nowPlaying.sequence_name || null;
  const queue = queueAll.filter(q => q.sequence_name !== nowPlayingName);

  // "Next up" priority order:
  //   1. JUKEBOX mode + queue has entries (after now-playing) → first queued
  //   2. VOTING mode + votes cast → highest-voted song
  //   3. Otherwise → whatever the schedule says
  let nextUp = nowPlaying.next_sequence_name || null;
  if (cfg.viewer_control_mode === 'JUKEBOX' && queue.length > 0) {
    nextUp = queue[0].sequence_name;
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
    showName: cfg.show_name,
    viewerControlMode: cfg.viewer_control_mode,
    nowPlaying: nowPlaying.sequence_name || null,
    nextScheduled: nextUp,
    activeViewers,
    sequences,
    voteCounts,
    queue,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
  });
});

router.post('/heartbeat', (req, res) => {
  const token = ensureViewerToken(req, res);
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const ua = (req.headers['user-agent'] || '').substring(0, 255);

  db.prepare(`
    INSERT INTO active_viewers (viewer_token, last_seen, ip_hash, user_agent)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT(viewer_token) DO UPDATE SET
      last_seen = CURRENT_TIMESTAMP,
      ip_hash = excluded.ip_hash
  `).run(token, ipHash, ua);

  res.json({ ok: true, token });
});

router.post('/vote', (req, res) => {
  const cfg = runSafeguards(req, res, 'VOTING');
  if (!cfg) return;

  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });
  if (!seq.votable || seq.is_psa) return res.status(400).json({ error: 'Sequence is not votable' });
  if (isSequenceHidden(seq, cfg)) {
    return res.status(400).json({ error: 'That sequence was recently played. Try another.' });
  }

  const token = ensureViewerToken(req, res);

  if (cfg.prevent_multiple_votes) {
    const already = db.prepare(
      `SELECT 1 FROM votes WHERE viewer_token = ? AND round_id = ? LIMIT 1`
    ).get(token, cfg.current_voting_round);
    if (already) return res.status(409).json({ error: 'You have already voted this round' });
  }

  try {
    db.prepare(`
      INSERT INTO votes (sequence_id, sequence_name, viewer_token, round_id)
      VALUES (?, ?, ?, ?)
    `).run(seq.id, seq.name, token, cfg.current_voting_round);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'You have already voted this round' });
    }
    throw e;
  }

  db.prepare(`UPDATE config SET interactions_since_last_psa = interactions_since_last_psa + 1 WHERE id = 1`).run();

  const io = req.app.get('io');
  if (io) {
    const counts = db.prepare(
      `SELECT sequence_name, COUNT(*) AS count FROM votes WHERE round_id = ? GROUP BY sequence_name`
    ).all(cfg.current_voting_round);
    io.emit('voteUpdate', { counts });
  }

  res.json({ ok: true });
});

router.post('/jukebox/add', (req, res) => {
  const cfg = runSafeguards(req, res, 'JUKEBOX');
  if (!cfg) return;

  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });
  if (!seq.jukeboxable || seq.is_psa) {
    return res.status(400).json({ error: 'Sequence is not available via jukebox' });
  }
  if (isSequenceHidden(seq, cfg)) {
    return res.status(400).json({ error: 'That sequence was recently played. Try another.' });
  }

  const token = ensureViewerToken(req, res);

  // queueSize, sequence-request-limit, and prevent-multiple-requests checks
  // should only count *pending* queue entries (handed_off_at IS NULL).
  // In-flight entries (handed_off_at IS NOT NULL but played=0) are already with
  // the plugin / FPP and shouldn't count against viewers anymore.

  if (cfg.jukebox_queue_depth > 0) {
    const queueSize = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0 AND handed_off_at IS NULL`
    ).get().n;
    if (queueSize >= cfg.jukebox_queue_depth) {
      return res.status(409).json({ error: 'The queue is full. Try again later.' });
    }
  }

  if (cfg.jukebox_sequence_request_limit > 0) {
    const seqCount = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue
       WHERE played = 0 AND handed_off_at IS NULL AND sequence_name = ?`
    ).get(seq.name).n;
    if (seqCount >= cfg.jukebox_sequence_request_limit) {
      return res.status(409).json({
        error: `That sequence has been requested the maximum number of times. Try another.`,
      });
    }
  }

  if (cfg.prevent_multiple_requests) {
    const existing = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue
       WHERE viewer_token = ? AND played = 0 AND handed_off_at IS NULL`
    ).get(token).n;
    if (existing >= 1) {
      return res.status(409).json({ error: 'You already have a request in the queue' });
    }
  }

  db.prepare(`
    INSERT INTO jukebox_queue (sequence_id, sequence_name, viewer_token)
    VALUES (?, ?, ?)
  `).run(seq.id, seq.name, token);

  db.prepare(`UPDATE config SET interactions_since_last_psa = interactions_since_last_psa + 1 WHERE id = 1`).run();

  const io = req.app.get('io');
  if (io) io.emit('queueUpdated');

  res.json({ ok: true });
});

module.exports = router;
