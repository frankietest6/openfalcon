// ============================================================
// ShowPilot — Viewer API
// Public endpoints consumed by the viewer page (browser).
// Enforces all viewer-side safeguards configured in admin.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const config = require('../lib/config-loader');
const { db, getConfig, getNowPlaying, getActiveViewerCount, getSequenceByName, castTiebreakVote, getNextUp } = require('../lib/db');
const { bustCoverUrl } = require('../lib/cover-art');

function ensureViewerToken(req, res) {
  let token = req.cookies[config.sessionCookieName + '_viewer'];
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    res.cookie(config.sessionCookieName + '_viewer', token, {
      httpOnly: true,
      sameSite: 'lax',
      // Auto-set secure flag when served over HTTPS. Same logic as admin
      // session cookie — req.secure respects Express's trust proxy.
      secure: !!req.secure,
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

// True if the client is on the same private LAN as FPP. Used to decide
// whether we can hand them a 192.168.x.x daemon URL or whether they need
// to go through our public proxy.
//
// Considered "same LAN" if:
//   - FPP host is a private/local IP (RFC 1918 / loopback / link-local), AND
//   - the client IP is also a private/local IP.
// Public-internet visitors get the proxy fallback only.
function isPrivateIp(ip) {
  if (!ip) return false;
  // Strip IPv6-mapped IPv4 prefix
  const v = ip.replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (v.startsWith('169.254.')) return true; // link-local
  // 172.16.0.0 – 172.31.255.255
  const m = v.match(/^172\.(\d+)\./);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
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

// Per-sequence cooldown check (v0.29.2+). Returns null if the sequence
// is NOT in cooldown (or has cooldown disabled), or an ISO timestamp
// string indicating when the cooldown expires. The check is purely
// query-time — there's no scheduled job to clear it; it just naturally
// stops being true once enough time has passed.
//
// Used in three places: viewer state (so the UI can gray out), jukebox
// add (defense in depth — UI hides it but reject the request server-side
// too), and voting nomination (filter out cooled-down sequences).
function sequenceCooldownUntil(seq) {
  if (!seq.cooldown_minutes || seq.cooldown_minutes <= 0) return null;
  if (!seq.last_played_at) return null;
  // SQLite stores last_played_at as a UTC string ('YYYY-MM-DD HH:MM:SS').
  // Treat it as UTC by appending 'Z' if no timezone is present, so Date
  // parsing doesn't apply local-time interpretation.
  const lpa = String(seq.last_played_at);
  const utc = /[Z+\-]/.test(lpa.slice(-6)) ? lpa : lpa.replace(' ', 'T') + 'Z';
  const lastMs = Date.parse(utc);
  if (!Number.isFinite(lastMs)) return null;
  const untilMs = lastMs + seq.cooldown_minutes * 60_000;
  if (untilMs <= Date.now()) return null;
  return new Date(untilMs).toISOString();
}

function viewerPresenceCheck(req, cfg) {
  // GPS check
  if (cfg.check_viewer_present && cfg.viewer_present_mode === 'GPS') {
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
  }
  // Location code check (v0.33.24+)
  if (cfg.location_code_enabled) {
    const submitted = (req.body?.locationCode ?? '').toString().trim();
    const expected  = (cfg.location_code ?? '').toString().trim();
    // If the admin enabled the feature but left the code blank, let everything
    // through — same "misconfigured = open" convention as the GPS gate.
    if (expected && submitted !== expected) {
      return { ok: false, error: 'Invalid or missing access code.', invalidLocationCode: true };
    }
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
    const status = presence.invalidLocationCode ? 403 : 403;
    res.status(status).json({ error: presence.error, invalidLocationCode: !!presence.invalidLocationCode });
    return null;
  }
  return cfg;
}

// GET /api/time
// ============================================================
// Lightweight time endpoint for NTP-style clock sync. The viewer
// calls this in bursts of 3-5 to estimate clock skew between phone
// and server with ~10-20ms accuracy. The implementation is deliberately
// minimal — no auth, no DB, no logging — to minimize server-side
// processing latency, which would otherwise corrupt the round-trip
// time measurement and skew the offset calculation.
//
// Why this matters: phones' Date.now() can be off from real time by
// hundreds of ms or more, especially after waking from sleep, and
// each phone is off by a different amount. Without accurate clock
// sync, two phones aligning to "FPP position + elapsed since update"
// drift apart because they each compute "elapsed" using their own
// (wrong) clocks. With this endpoint, both phones derive an accurate
// server-time reference and align to the same target.
router.get('/time', (req, res) => {
  res.json({ t: Date.now() });
});

router.get('/state', (req, res) => {
  const cfg = getConfig();
  const nowPlaying = getNowPlaying();
  const activeViewers = getActiveViewerCount();

  const allSequences = db.prepare(`
    SELECT id, name, display_name, artist, category, image_url,
           duration_seconds, votable, jukeboxable,
           last_played_at, plays_since_hidden, cooldown_minutes
    FROM sequences
    WHERE visible = 1 AND is_psa = 0
    ORDER BY display_order, display_name
  `).all();

  const { bustSequenceCovers } = require('../lib/cover-art');
  // Filter sequences the viewer shouldn't see right now:
  //   1. count-based hide rule (hide_sequence_after_played) — pre-existing
  //   2. per-sequence cooldown (v0.29.2+) — sequence in cooldown drops out
  //      of the response entirely so user-authored viewer templates don't
  //      need to know about cooldown. They just render whatever's in the
  //      list. When the cooldown expires, the sequence reappears on the
  //      next poll.
  // Both rules can apply independently — a sequence can be hidden by
  // either or both.
  //
  // cooldown_minutes is used internally by the cooldown filter but isn't
  // needed by the viewer client. Strip it so we don't ship configuration
  // state to anonymous users. last_played_at and plays_since_hidden
  // were already exposed to viewers pre-v0.29.2 and we keep them for
  // backward compat with custom templates.
  const sequences = bustSequenceCovers(
    allSequences
      .filter(s => !isSequenceHidden(s, cfg))
      .filter(s => !sequenceCooldownUntil(s))
      .map(({ cooldown_minutes, ...rest }) => rest)
  );

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

  const nextUp = getNextUp(cfg, nowPlayingName);

  // Now-playing timer support (v0.32.9+):
  // The {NOW_PLAYING_TIMER} placeholder in viewer templates needs two
  // pieces of info to render a countdown: when the song started and how
  // long the song is. started_at is stored as UTC text in SQLite
  // ("YYYY-MM-DD HH:MM:SS" with no zone marker); convert to ISO with
  // explicit Z so the client's Date parser treats it as UTC. We look up
  // duration with a direct query rather than searching `allSequences`
  // because the now-playing track might be a PSA, hidden, or in cooldown
  // — all of which are filtered out of allSequences. The timer should
  // still tick for those.
  let nowPlayingStartedAtIso = null;
  let nowPlayingDurationSeconds = null;
  if (nowPlaying.sequence_name && nowPlaying.started_at) {
    nowPlayingStartedAtIso = nowPlaying.started_at.replace(' ', 'T') + 'Z';
    const npRow = db.prepare(
      `SELECT duration_seconds FROM sequences WHERE name = ? LIMIT 1`
    ).get(nowPlaying.sequence_name);
    if (npRow && npRow.duration_seconds) {
      nowPlayingDurationSeconds = npRow.duration_seconds;
    }
  }

  res.json({
    showName: cfg.show_name,
    viewerControlMode: cfg.viewer_control_mode,
    nowPlaying: nowPlaying.sequence_name || null,
    nowPlayingStartedAtIso,
    nowPlayingDurationSeconds,
    nextScheduled: nextUp,
    activeViewers,
    sequences,
    voteCounts,
    queue,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
    requiresLocationCode: cfg.location_code_enabled === 1,
    // Vote shifting (v0.32.6+): mirror of bootstrap allowVoteChange so an
    // admin toggling this mid-show propagates to viewers without a reload.
    allowVoteChange: cfg.allow_vote_change === 1,
    // Current voting round id. Viewers track this so they can detect a
    // round change (server advanced past their last vote) and clear
    // their local hasVoted flag. This is the "last-write-wins" backup
    // for the voteReset socket event, which can be missed when mobile
    // devices background-suspend or briefly drop network. Without it,
    // "You've already voted" persists across rounds until manual refresh.
    currentVotingRound: cfg.current_voting_round,
    // Tiebreak state (v0.24.0+) — viewers use this to render the
    // tiebreak banner when reconnecting mid-tiebreak (e.g. someone
    // opened the page after the tiebreakStarted socket event already
    // fired). Empty/false when no tiebreak active.
    tiebreak: cfg.tiebreak_active === 1 ? {
      candidates: (cfg.tiebreak_candidates || '').split(',').map(s => s.trim()).filter(Boolean),
      // Absolute deadline timestamp (ISO server time). Viewer computes
      // remaining = deadline - now using its server-time offset from
      // burst clock sync, so the displayed countdown is accurate
      // regardless of network/render lag.
      deadlineAtIso: cfg.tiebreak_deadline_at,
      startedAtIso: cfg.tiebreak_started_at,
    } : null,
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
  const cooldownUntilV = sequenceCooldownUntil(seq);
  if (cooldownUntilV) {
    return res.status(400).json({
      error: 'That sequence was recently played. It will be available again shortly.',
      cooldown_until: cooldownUntilV,
    });
  }

  // Repeat blockers (v0.31.1+): block votes for the currently-playing song
  // or the one already winning the round (which would otherwise be next up).
  // For the "next up" case in voting, the highest-vote sequence is what
  // gets handed to FPP — checking the top of the tally matches /state.
  const npV = getNowPlaying();
  if (cfg.block_vote_currently_playing && npV.sequence_name === seq.name) {
    return res.status(409).json({ error: 'That song is playing right now. Try another.' });
  }
  if (cfg.block_vote_next_up) {
    const top = db.prepare(`
      SELECT sequence_name FROM votes
      WHERE round_id = ?
      GROUP BY sequence_name
      ORDER BY COUNT(*) DESC
      LIMIT 1
    `).get(cfg.current_voting_round);
    const nextUp = top ? top.sequence_name : (npV.next_sequence_name || null);
    if (nextUp && nextUp === seq.name) {
      return res.status(409).json({ error: 'That song is already up next. Try another.' });
    }
  }

  const token = ensureViewerToken(req, res);

  // Vote shifting (v0.32.6+):
  // When prevent_multiple_votes=1 AND allow_vote_change=1, a second vote in
  // the same round REPLACES the user's prior vote. Same effective limit (one
  // vote per viewer per round), just lets them change their mind. We track
  // whether this was an insert or a shift so the client can show appropriate
  // feedback ("Vote changed!" vs. "Vote cast!"), and so we don't double-count
  // for PSA interaction tracking — a shift is still ONE interaction.
  let shifted = false;
  let sameVote = false;
  if (cfg.prevent_multiple_votes) {
    const prior = db.prepare(
      `SELECT id, sequence_name FROM votes WHERE viewer_token = ? AND round_id = ? LIMIT 1`
    ).get(token, cfg.current_voting_round);
    if (prior) {
      if (!cfg.allow_vote_change) {
        return res.status(409).json({ error: 'You have already voted this round' });
      }
      // Vote-change is on. If the user clicked the same song they already
      // voted for, treat as a no-op (don't churn the row, don't emit a
      // misleading "vote changed" signal). Otherwise atomically swap.
      if (prior.sequence_name === seq.name) {
        sameVote = true;
      } else {
        // Atomic delete-then-insert in a transaction so concurrent voteUpdate
        // emissions never see "user has zero votes mid-shift."
        const swap = db.transaction(() => {
          db.prepare(`DELETE FROM votes WHERE id = ?`).run(prior.id);
          db.prepare(`
            INSERT INTO votes (sequence_id, sequence_name, viewer_token, round_id)
            VALUES (?, ?, ?, ?)
          `).run(seq.id, seq.name, token, cfg.current_voting_round);
        });
        try {
          swap();
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) {
            // Shouldn't happen — we just deleted the conflicting row in the
            // same txn — but handle defensively.
            return res.status(409).json({ error: 'Vote conflict, please retry' });
          }
          throw e;
        }
        shifted = true;
      }
    }
  }

  if (!shifted && !sameVote) {
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
  }

  // Diagnostic logging — emitted at info level so it shows up in pm2 logs.
  // Helps debug "votes always show 0" reports by confirming what was written.
  // Counts include all rounds for this token+sequence so we can spot if a
  // vote went into the wrong round_id (e.g. round was advanced unexpectedly).
  try {
    const totalForRound = db.prepare(
      `SELECT COUNT(*) AS n FROM votes WHERE round_id = ?`
    ).get(cfg.current_voting_round).n;
    const totalForSeq = db.prepare(
      `SELECT COUNT(*) AS n FROM votes WHERE sequence_name = ? AND round_id = ?`
    ).get(seq.name, cfg.current_voting_round).n;
    const action = sameVote ? 'same' : (shifted ? 'shift' : 'insert');
    console.log(`[vote:${action}] seq="${seq.name}" round=${cfg.current_voting_round} token=${(token||'').slice(0,8)} → seq_total=${totalForSeq} round_total=${totalForRound}`);
  } catch (e) {
    console.warn('[vote] diagnostic logging failed:', e.message);
  }

  // Don't double-count for PSA on a shift — it's the same user changing their
  // mind, not a new interaction. Same-vote no-op also doesn't count.
  if (!shifted && !sameVote) {
    db.prepare(`UPDATE config SET interactions_since_last_psa = interactions_since_last_psa + 1 WHERE id = 1`).run();
  }

  const io = req.app.get('io');
  if (io) {
    const counts = db.prepare(
      `SELECT sequence_name, COUNT(*) AS count FROM votes WHERE round_id = ? GROUP BY sequence_name`
    ).all(cfg.current_voting_round);
    io.emit('voteUpdate', { counts });
  }

  res.json({ ok: true, shifted, sameVote });
});

// ============================================================
// POST /api/tiebreak-vote
// ============================================================
// Casts a vote during an active tiebreak. Separate from /vote because
// the validation is different (must be a candidate; main-round voters
// allowed; uses tiebreak_votes table) and because the success response
// triggers a different toast on the client. Body: { sequenceName }.
router.post('/tiebreak-vote', (req, res) => {
  const cfg = runSafeguards(req, res, 'VOTING');
  if (!cfg) return;

  if (cfg.tiebreak_active !== 1) {
    return res.status(400).json({ error: 'No tiebreak in progress' });
  }
  const candidates = (cfg.tiebreak_candidates || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });
  if (!candidates.includes(sequenceName)) {
    return res.status(400).json({ error: 'That sequence is not a tiebreak candidate' });
  }

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });

  const token = ensureViewerToken(req, res);
  const result = castTiebreakVote(token, sequenceName, cfg.current_voting_round, candidates);
  if (result === 'duplicate') {
    return res.status(409).json({ error: 'You have already voted in this tiebreak' });
  }
  if (result === 'invalid_candidate') {
    return res.status(400).json({ error: 'Invalid tiebreak candidate' });
  }

  // Diagnostic logging — mirror the main /vote endpoint.
  try {
    const totalForRound = db.prepare(
      `SELECT COUNT(*) AS n FROM tiebreak_votes WHERE round_id = ?`
    ).get(cfg.current_voting_round).n;
    console.log(`[tiebreak-vote] seq="${seq.name}" round=${cfg.current_voting_round} token=${(token||'').slice(0,8)} → tiebreak_round_total=${totalForRound}`);
  } catch (e) {
    console.warn('[tiebreak-vote] diagnostic logging failed:', e.message);
  }

  // Broadcast updated tiebreak vote tallies so connected viewers see
  // the count tick up. Combined with main-round counts on the client
  // side for the final score display.
  const io = req.app.get('io');
  if (io) {
    const tbCounts = db.prepare(
      `SELECT sequence_name, COUNT(*) AS count FROM tiebreak_votes WHERE round_id = ? GROUP BY sequence_name`
    ).all(cfg.current_voting_round);
    io.emit('tiebreakVoteUpdate', { counts: tbCounts });
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
  // Cooldown check (v0.29.2+). The viewer UI already hides cooled-down
  // sequences, but a stale page or a direct API caller could still try
  // to request one — reject server-side too.
  const cooldownUntil = sequenceCooldownUntil(seq);
  if (cooldownUntil) {
    return res.status(400).json({
      error: 'That sequence was recently played. It will be available again shortly.',
      cooldown_until: cooldownUntil,
    });
  }

  // Repeat blockers (v0.31.1+): don't let viewers queue the song that's
  // currently playing or the one already lined up next. "Next up" mirrors
  // the same priority order /state computes — first in the jukebox queue
  // if there is one, otherwise FPP's scheduled next.
  const np = getNowPlaying();
  if (cfg.block_request_currently_playing && np.sequence_name === seq.name) {
    return res.status(409).json({ error: 'That song is playing right now. Try another.' });
  }
  if (cfg.block_request_next_up) {
    const firstQueued = db.prepare(
      `SELECT sequence_name FROM jukebox_queue
       WHERE played = 0 AND sequence_name != COALESCE(?, '')
       ORDER BY requested_at ASC LIMIT 1`
    ).get(np.sequence_name || null);
    const nextUp = firstQueued ? firstQueued.sequence_name : (np.next_sequence_name || null);
    if (nextUp && nextUp === seq.name) {
      return res.status(409).json({ error: 'That song is already up next. Try another.' });
    }
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
    const limit = Math.max(1, parseInt(cfg.viewer_request_limit, 10) || 1);
    const existing = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue
       WHERE viewer_token = ? AND played = 0 AND handed_off_at IS NULL`
    ).get(token).n;
    if (existing >= limit) {
      const noun = limit === 1 ? 'request' : 'requests';
      return res.status(409).json({
        error: `You already have ${existing} ${noun} in the queue. This show limits each viewer to ${limit} ${noun} at a time — please wait until your current ${noun} ${limit === 1 ? 'plays' : 'play'} before requesting another.`,
      });
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

// ============================================================
// AUDIO STREAMING
//
// Provides on-demand audio playback for viewers. The ShowPilot server proxies
// audio bytes from FPP's `/api/media/<file>` endpoint — viewers don't need
// direct network reach to FPP.
//
// Two endpoints:
//   GET /api/now-playing-audio        → metadata: which file, where in playback
//   GET /api/audio-stream/:sequence   → the actual audio bytes (proxied from FPP)
// ============================================================

// Page visuals endpoint — polled by viewer page (independent of audio player)
// so admin can toggle page snow / decoration live without anyone needing to
// open the audio player. Cheap: just one config read.
router.get('/visual-config', (req, res) => {
  const cfg = getConfig();
  // Audio gate: this endpoint controls whether the launcher BUTTON is visible.
  // It does NOT do location verification — that happens via the dedicated
  // location-verify flow when the user actually taps to listen. This means
  // the button is visible whenever the show is running; tapping it triggers
  // a fresh location check, which is the real copyright safeguard.
  //
  // (Legacy callers that DO pass lat/lng — like the now-playing-audio endpoint
  // and the in-player periodic re-checks — still get a location-aware result.)
  let audioGateBlocked = false;
  let audioGateReason = '';
  if (cfg.viewer_control_mode === 'OFF') {
    audioGateBlocked = true;
    audioGateReason = 'Show is offline.';
  } else if (req.query.gateCheck === 'mode') {
    // Page-level visibility check — only care about control mode here.
    // Location enforcement is the click-time + in-player concern.
  } else if (cfg.audio_gate_enabled === 1 && cfg.show_latitude && cfg.show_longitude) {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
      audioGateBlocked = true;
      audioGateReason = 'Audio requires location access.';
    } else {
      const dist = distanceMiles(cfg.show_latitude, cfg.show_longitude, lat, lng);
      if (dist > (cfg.audio_gate_radius_miles || 0.5)) {
        audioGateBlocked = true;
        audioGateReason = 'Audio is only available to listeners present at the show.';
      }
    }
  }
  // showNotPlaying is a separate, NON-sticky signal. The audio gate latches
  // on refresh (see applyAudioGateState) because gate state implies "you
  // can't listen here at all" — but show-not-playing should toggle freely
  // as FPP starts/stops between songs without forcing viewers to refresh.
  //
  // Threshold rationale: the plugin POSTs /api/plugin/position every ~1s
  // while a sequence is playing, and that handler bumps now_playing.last_updated.
  // 10s = ~10 missed position reports before we say "not playing" — comfortable
  // margin against transient network blips while still going stale within
  // seconds when FPP idles, the plugin hangs, or the network partitions.
  // (When FPP cleanly transitions to idle, the plugin POSTs /playing with an
  // empty sequence, which sets sequence_name = NULL and trips the first
  // branch below — instant, doesn't wait for the threshold.)
  let showNotPlaying = false;
  const np = getNowPlaying();
  if (!np || !np.sequence_name) {
    showNotPlaying = true;
  } else {
    // SQLite CURRENT_TIMESTAMP is UTC. last_updated is stored as 'YYYY-MM-DD HH:MM:SS'
    // (no TZ suffix). Adding 'Z' makes Date.parse treat it as UTC, matching how
    // it was written.
    const lastMs = Date.parse(np.last_updated + 'Z');
    if (!isFinite(lastMs) || (Date.now() - lastMs) > 10_000) {
      showNotPlaying = true;
    }
  }

  res.json({
    pageSnowEnabled: cfg.page_snow_enabled === 1 || cfg.page_effect === 'snow',
    pageEffect: cfg.page_effect || (cfg.page_snow_enabled === 1 ? 'snow' : 'none'),
    pageEffectColor: cfg.page_effect_color || '',
    pageEffectIntensity: cfg.page_effect_intensity || 'medium',
    playerDecoration: cfg.player_decoration || 'none',
    playerDecorationAnimated: cfg.player_decoration_animated !== 0,
    playerCustomColor: cfg.player_custom_color || '',
    audioGateBlocked,
    audioGateReason,
    showNotPlaying,
  });
});

// Lightweight metadata endpoint — viewer page polls this to know what to play
router.get('/now-playing-audio', (req, res) => {
  const np = getNowPlaying();
  const cfg = getConfig();

  // Master audio kill-switch. When admin has disabled audio entirely
  // (e.g. they use PulseMesh / Icecast / FM and don't want ShowPilot
  // hosting audio at all), respond with a stable shape that signals
  // the viewer to hide the launcher and skip polling. We bypass the
  // gate logic below — there's nothing to gate.
  if (cfg.audio_enabled === 0) {
    return res.json({ playing: false, audioDisabled: true });
  }

  // Audio distance gating — used for copyright compliance to prevent listeners
  // who aren't actually present at the show from streaming the audio.
  // Viewer page passes ?lat=&lng= when geolocation is available. If the gate
  // is enabled and we have a valid location for the viewer, check radius.
  // If the gate is enabled but the viewer hasn't shared location, block too —
  // we can't verify they're in range.
  let audioGateBlocked = false;
  let audioGateReason = '';
  if (cfg.viewer_control_mode === 'OFF') {
    audioGateBlocked = true;
    audioGateReason = 'Show is offline.';
  } else if (cfg.audio_gate_enabled === 1) {
    if (!cfg.show_latitude || !cfg.show_longitude) {
      // Admin enabled gate but didn't set show coords — fail open (otherwise
      // they'd lock everyone out and not realize why).
    } else {
      const lat = parseFloat(req.query.lat);
      const lng = parseFloat(req.query.lng);
      if (!isFinite(lat) || !isFinite(lng)) {
        audioGateBlocked = true;
        audioGateReason = 'Audio playback requires location access. Please enable location sharing for this page and refresh.';
      } else {
        const dist = distanceMiles(cfg.show_latitude, cfg.show_longitude, lat, lng);
        if (dist > (cfg.audio_gate_radius_miles || 0.5)) {
          audioGateBlocked = true;
          audioGateReason = `Audio is only available to listeners present at the show.`;
        }
      }
    }
  }

  // Visual settings that always apply regardless of playback state
  const visualConfig = {
    pageSnowEnabled: cfg.page_snow_enabled === 1 || cfg.page_effect === 'snow',
    pageEffect: cfg.page_effect || (cfg.page_snow_enabled === 1 ? 'snow' : 'none'),
    pageEffectColor: cfg.page_effect_color || '',
    pageEffectIntensity: cfg.page_effect_intensity || 'medium',
    playerDecoration: cfg.player_decoration || 'none',
    playerDecorationAnimated: cfg.player_decoration_animated !== 0,
    playerCustomColor: cfg.player_custom_color || '',
    audioGateBlocked,
    audioGateReason,
  };
  if (!np || !np.sequence_name) {
    return res.json({ playing: false, ...visualConfig });
  }
  const seq = getSequenceByName(np.sequence_name);
  if (!seq || !seq.media_name) {
    return res.json({ playing: true, hasAudio: false, sequenceName: np.sequence_name, ...visualConfig });
  }

  // How long has this song been playing? Used to seek the listener forward.
  const startedAtMs = np.started_at ? new Date(np.started_at.replace(' ', 'T') + 'Z').getTime() : null;
  const elapsedSec = startedAtMs ? Math.max(0, (Date.now() - startedAtMs) / 1000) : 0;

  // Look up the cached audio's hash and append it to the stream URL as a
  // cache buster. Without this, the browser may serve stale bytes from
  // its HTTP cache when the underlying file changes (e.g. the plugin
  // re-syncs after we fix a format bug). The /api/audio-stream/<seq> URL
  // itself doesn't change when bytes change — so we add ?v=<hash-prefix>.
  // When the hash changes, the URL changes, browser fetches fresh.
  //
  // Falls back to no version param when the file isn't cached (FPP-proxy
  // path) — there's no hash to anchor to. The route ignores unknown
  // query params, so adding ?v=... is always safe.
  let versionParam = '';
  try {
    const audioCache = require('../lib/audio-cache');
    // Look up via sequence name (resolves to sequence's audio_hash if
    // set, falls back to media_name for legacy installs).
    const cached = audioCache.getCachedFileForSequence(seq.name);
    if (cached && cached.hash) {
      versionParam = '?v=' + cached.hash.slice(0, 8);
    }
  } catch (_) {
    // Non-fatal — proceed without cache busting.
  }

  res.json({
    playing: true,
    hasAudio: true,
    sequenceName: np.sequence_name,
    displayName: seq.display_name || np.sequence_name,
    artist: seq.artist || '',
    imageUrl: bustCoverUrl(seq.image_url) || null,
    durationSec: seq.duration_seconds || null,
    elapsedSec: Math.round(elapsedSec * 10) / 10,
    startedAt: np.started_at,
    // Timestamp-anchored sync — Web Audio API uses these for sample-precise scheduling
    trackStartedAtMs: startedAtMs,
    serverNowMs: Date.now(),
    // Live position from FPP's reported playback. If the plugin is
    // sending /api/plugin/position updates, this reflects FPP's actual
    // hardware audio output position within the last ~500ms. Viewers
    // use this as an authoritative anchor instead of extrapolating from
    // trackStartedAtMs (which has whatever offset was baked in at
    // track-change time, drifting from FPP's true position over the
    // course of a track). Null if no live position has been reported
    // since server startup or the reported sequence doesn't match.
    livePosition: (() => {
      try {
        const { getLivePosition } = require('./plugin');
        const lp = getLivePosition && getLivePosition();
        if (lp && lp.sequence === np.sequence_name) {
          return {
            position: lp.position,
            updatedAt: lp.updatedAt,
          };
        }
      } catch (e) {
        // If the require fails for any reason, just omit live position.
      }
      return null;
    })(),
    // Audio is served via the ShowPilot proxy, which fetches bytes from
    // FPP's built-in /api/file/Music/<name> endpoint. Same-origin path always
    // works; the public URL is for cellular/external listeners hitting through
    // the public domain.
    streamUrl: `/api/audio-stream/${encodeURIComponent(seq.name)}${versionParam}`,
    publicStreamUrl: cfg.public_base_url
      ? `${String(cfg.public_base_url).replace(/\/+$/, '')}/api/audio-stream/${encodeURIComponent(seq.name)}${versionParam}`
      : '',
    // Relay URL — try this first for live sync. Falls back to streamUrl if relay
    // is not active (503 response). Relay is same-origin only (LAN/local listeners);
    // external listeners use publicStreamUrl which goes through the cache path.
    // Raw filename on FPP (e.g. "08 - Bloody Mary.mp3"). Used by the
    // client to match incoming fppSyncPoint events, which carry the
    // filename not the sequence name.
    mediaName: seq.media_name,
    relayUrl: `/api/audio-relay/${encodeURIComponent(seq.name)}`,
    relayActive: (() => {
      try {
        const a = require('../lib/audio-relay').getActiveSequence();
        // Also true if FPP host is configured — viewer will use fallback daemon proxy
        const cfg = getConfig();
        return !!(a && a.toLowerCase() === seq.name.toLowerCase()) ||
               !!(cfg.plugin_fpp_host && seq.media_name);
      } catch(_) { return false; }
    })(),
    // Per-show sync offset in milliseconds. Positive = play audio LATER
    // (compensates for audio arriving too early — the typical case after
    // the cache change, since cache delivery is faster than the previous
    // FPP-proxy path). Negative = play EARLIER. Set in admin Settings.
    audioSyncOffsetMs: cfg.audio_sync_offset_ms || 0,
    // Visual settings (snow, decoration, custom color) — always present
    ...visualConfig,
  });
});

// Audio proxy — checks the local audio cache first (populated by the plugin
// during sync). Falls back to proxying from FPP if not cached. Supports
// HTTP Range requests so browsers can seek/resume.
// ============================================================
// GET /api/audio-relay/:sequence
// ============================================================
// Primary: shared relay — one daemon connection fanned to all viewers
// simultaneously. All viewers get the same bytes at the same moment = sync.
// Fallback: per-viewer daemon proxy if shared relay isn't active yet.
router.head('/audio-relay/:sequence', (req, res) => {
  const cfg = getConfig();
  if (cfg.audio_enabled === 0 || !cfg.plugin_fpp_host) return res.status(503).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).end();
});

router.get('/audio-relay/:sequence', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const cfg = getConfig();
  if (cfg.audio_enabled === 0) return res.status(404).send('Audio is disabled.');
  if (!cfg.plugin_fpp_host) return res.status(503).json({ error: 'no_fpp_host' });

  const reqName = String(req.params.sequence || '');
  let seq = getSequenceByName(reqName);
  if (!seq) seq = db.prepare(`SELECT * FROM sequences WHERE LOWER(name) = LOWER(?) LIMIT 1`).get(reqName);
  if (!seq || !seq.media_name) return res.status(404).send('Sequence not found');

  // Try shared relay first — all viewers get identical bytes = automatic sync
  const { addListener, getActiveSequence } = require('../lib/audio-relay');
  const activeSeq = getActiveSequence();
  if (activeSeq && activeSeq.toLowerCase() === seq.name.toLowerCase()) {
    const added = addListener(seq.name, res);
    if (added) return;
  }

  // Fallback: direct per-viewer daemon connection.
  // Less ideal for sync but better than silence.
  const http = require('http');
  const daemonReq = http.get({
    hostname: cfg.plugin_fpp_host,
    port: cfg.audio_daemon_port || 8090,
    path: `/audio/${encodeURIComponent(seq.media_name)}`,
  }, (daemonRes) => {
    if (daemonRes.statusCode !== 200) {
      if (!res.headersSent) res.status(daemonRes.statusCode).send('Daemon error');
      return;
    }
    res.setHeader('Content-Type', daemonRes.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Audio-Source', 'daemon-direct');
    res.status(200);
    daemonRes.pipe(res);
    res.on('close', () => daemonRes.destroy());
  });

  daemonReq.on('error', (err) => {
    console.error('[audio-relay] fallback daemon error:', err.message);
    if (!res.headersSent) res.status(503).json({ error: 'daemon_unreachable' });
  });

  daemonReq.setTimeout(5000, () => {
    daemonReq.destroy();
    if (!res.headersSent) res.status(503).json({ error: 'daemon_timeout' });
  });
});

router.get('/audio-stream/:sequence', async (req, res) => {
  // Master audio kill-switch — admin disabled audio entirely. Bail before
  // any cache lookup or FPP proxy work. 404 (not 403) so the browser
  // treats this the same as a missing file rather than a permission
  // problem; viewer-side launcher is already hidden at this point.
  const cfg = getConfig();
  if (cfg.audio_enabled === 0) {
    return res.status(404).send('Audio is disabled for this show.');
  }

  // Case-insensitive lookup in case viewer page or admin renamed the sequence
  // with different casing than what we have in DB.
  const reqName = String(req.params.sequence || '');
  let seq = getSequenceByName(reqName);
  if (!seq) {
    seq = db.prepare(`SELECT * FROM sequences WHERE LOWER(name) = LOWER(?) LIMIT 1`).get(reqName);
  }
  if (!seq || !seq.media_name) {
    return res.status(404).send('Audio not available for this sequence');
  }

  // ============================================================
  // CACHE-FIRST PATH (v0.19.0+)
  // ============================================================
  // If the plugin has uploaded this audio file via the audio-cache
  // sync, serve it directly from local disk. This is the fast path:
  // no FPP round trip, no SD-card thrash, scales to many concurrent
  // viewers because OS page cache handles repeated reads natively.
  //
  // Express's res.sendFile() handles Range requests, content-type,
  // ETags, etc. for free. Falls through to the proxy path below
  // only if the cache lookup misses — preserves backward compat
  // with installs that haven't upgraded their plugin yet.
  try {
    const audioCache = require('../lib/audio-cache');
    const cachedFile = audioCache.getCachedFileForSequence(seq.name);
    if (cachedFile) {
      // Aggressive caching for cellular listeners. Audio file bytes are
      // immutable — same hash, same content. Cloudflare or other edge
      // caches can serve this aggressively.
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      // Set the correct MIME type from what the plugin uploaded. Critical
      // for non-MP3 audio (M4A from extracted video, OGG, FLAC, etc.) —
      // browsers can decode any of these via Web Audio API but ONLY if
      // the Content-Type matches the actual bytes. Without this, the
      // cache file is stored as <hash>.bin and Express's content-type
      // sniffing would label it application/octet-stream, which makes
      // the browser refuse to play it as audio.
      res.setHeader('Content-Type', cachedFile.mimeType);
      // Diagnostic header so admins can verify cache vs FPP-proxy paths
      // in browser dev tools without server log access. Visible under
      // the Network tab → click request → Response Headers.
      res.setHeader('X-Audio-Source', 'cache');
      // sendFile handles Range/304/Accept-Ranges automatically. Browser
      // gets sample-precise seeking exactly as it would from FPP.
      return res.sendFile(cachedFile.path, (err) => {
        if (err && !res.headersSent) {
          // Local file disappeared between lookup and send — extremely
          // rare race condition. Return 502 rather than retry; viewer's
          // audio scheduler will retry on the next sync cycle.
          console.error('[audio-stream] cache file send failed:', err.message);
          res.status(502).send('Cached audio file unavailable');
        }
      });
    }
  } catch (e) {
    // Cache subsystem error — fall through to FPP proxy. This is the
    // backstop that keeps audio working even if the cache breaks.
    console.warn('[audio-stream] cache lookup failed, falling back to FPP proxy:', e.message);
  }

  // ============================================================
  // FPP PROXY FALLBACK
  // ============================================================
  // No cache hit. Hit FPP directly. This is what every audio request
  // did before v0.19.0; it stays as the fallback for fresh installs
  // before the plugin has uploaded files, plugin downgrades, or any
  // case where cache is empty.
  //
  // Log cache miss so admins can spot unexpected fallbacks (e.g. the
  // plugin failed to upload some sequences, or a sequence got renamed
  // since the last sync). Once steady-state, this should rarely fire.
  console.warn(
    '[audio-stream] cache miss for "' + seq.media_name + '" — falling back to FPP proxy'
  );
  // Diagnostic header for the same reason as the cache-hit one above —
  // browser dev tools can show cache vs proxy at a glance.
  res.setHeader('X-Audio-Source', 'fpp');

  // Need FPP host from plugin status
  const fppHost = cfg.plugin_fpp_host;
  if (!fppHost) {
    return res.status(503).send('Audio streaming unavailable — plugin has not connected yet');
  }

  // Defense-in-depth SSRF check: even though plugin/heartbeat validates the
  // fppHost on capture, we re-check here to refuse forwarding to anything
  // that isn't a private LAN address. This handles two edge cases:
  // (1) Old DB rows from before the heartbeat validator was added.
  // (2) An attacker who somehow wrote a public IP into the config row
  //     bypassing the plugin route. The proxy itself must not be a
  //     trusting endpoint.
  if (!/^(10\.|192\.168\.|169\.254\.)/.test(fppHost) &&
      !/^172\.(1[6-9]|2\d|3[01])\./.test(fppHost)) {
    console.warn(`[audio-stream] refusing non-private fppHost: ${fppHost}`);
    return res.status(503).send('Audio streaming unavailable — invalid upstream configuration');
  }
  // Block cloud metadata endpoint specifically
  if (fppHost === '169.254.169.254') {
    return res.status(503).send('Audio streaming unavailable — invalid upstream configuration');
  }

  // Validate the media filename — refuse anything containing path traversal
  // characters before constructing the upstream URL. encodeURIComponent
  // doesn't actually defend here because FPP would decode the percent-
  // encoded `..` back to `..` on its end.
  if (/[\\/]/.test(seq.media_name) || seq.media_name.includes('..')) {
    return res.status(400).send('Invalid media filename');
  }

  // Build upstream URL. FPP serves audio file BYTES at /api/file/Music/<file>.
  // (/api/media/<file>/meta is the tag-reading endpoint — not the bytes.)
  const upstreamUrl = `http://${fppHost}/api/file/Music/${encodeURIComponent(seq.media_name)}`;

  try {
    // Forward Range header so the browser can seek
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(upstreamUrl, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('FPP returned ' + upstream.status);
    }

    // Mirror the relevant headers from FPP (excluding cache-control — we set our own)
    res.status(upstream.status);
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    // FPP returns `application/binary` for music files which makes some browsers
    // treat the response as opaque and disables seeking. Force audio/mpeg.
    const upstreamCt = (upstream.headers.get('content-type') || '').toLowerCase();
    if (upstreamCt.startsWith('audio/')) {
      res.setHeader('Content-Type', upstreamCt);
    } else {
      res.setHeader('Content-Type', 'audio/mpeg');
    }
    // Always advertise Accept-Ranges so browsers know they can seek
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    // Aggressive caching so Cloudflare can edge-serve subsequent requests for
    // external listeners. Audio files don't change after they're recorded.
    // 1 hour at edge + revalidation buys huge bandwidth + latency wins for
    // cellular listeners while keeping a path to invalidate if needed.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');

    // Stream the body through — Node 18+ supports response.body as ReadableStream
    if (upstream.body) {
      const reader = upstream.body.getReader();
      res.on('close', () => reader.cancel().catch(() => {}));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
      res.end();
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    console.error('[audio-stream] proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Could not reach FPP: ' + err.message);
  }
});

module.exports = router;
