// ============================================================
// OpenFalcon — Plugin API
// Endpoints that the OpenFalcon FPP plugin calls.
// Auth: Authorization: Bearer <showToken>
//
// Endpoints:
//   GET  /api/plugin/state            — one call, returns everything FPP needs to act
//   POST /api/plugin/playing          — FPP reports what's playing now
//   POST /api/plugin/next             — FPP reports what's scheduled next
//   POST /api/plugin/heartbeat        — keepalive + plugin version sync
//   POST /api/plugin/sync-sequences   — plugin pushes the full sequence list
//   GET  /api/plugin/health           — plugin status visibility
// ============================================================

const express = require('express');
const router = express.Router();
const config = require('../config');
const {
  getConfig,
  updateConfig,
  setNowPlaying,
  setNextScheduled,
  getHighestVotedSequence,
  popNextQueuedRequest,
  advanceVotingRound,
  db,
} = require('../lib/db');

// Bearer token auth
function requireBearerToken(req, res, next) {
  const auth = req.header('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (!token || token !== config.showToken) {
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  }
  next();
}

router.use(requireBearerToken);

// Track plugin heartbeats and sync — hydrated from config on startup,
// re-saved to config whenever values change so restarts don't lose state.
const pluginStatus = (() => {
  const cfg = getConfig();
  return {
    lastSeen: cfg.plugin_last_seen_at || null,
    version: cfg.plugin_version || null,
    lastSyncAt: cfg.plugin_last_sync_at || null,
    lastSyncPlaylist: cfg.plugin_last_sync_playlist || null,
    lastSyncCount: cfg.plugin_last_sync_count || 0,
  };
})();

// ============================================================
// GET /api/plugin/state
// ============================================================
router.get('/state', (req, res) => {
  const cfg = getConfig();

  const response = {
    mode: cfg.viewer_control_mode,
    interruptSchedule: cfg.interrupt_schedule === 1,
    managedPsa: cfg.managed_psa_enabled === 1,
    winningVote: null,
    nextRequest: null,
    psa: null,
  };

  // PSA check — if enabled and threshold met, play a PSA instead
  if (cfg.play_psa_enabled &&
      cfg.psa_frequency > 0 &&
      cfg.interactions_since_last_psa >= cfg.psa_frequency) {

    const psa = db.prepare(`
      SELECT name, sort_order FROM sequences
      WHERE is_psa = 1 AND visible = 1
      ORDER BY COALESCE(last_played_at, '1970-01-01') ASC
      LIMIT 1
    `).get();

    if (psa) {
      const psaEntry = { sequence: psa.name, playlistIndex: psa.sort_order };
      response.psa = psaEntry;
      db.prepare(`UPDATE config SET interactions_since_last_psa = 0 WHERE id = 1`).run();

      // Deliver PSA via the mode-appropriate slot so plugin acts on it
      if (cfg.viewer_control_mode === 'VOTING') response.winningVote = psaEntry;
      else if (cfg.viewer_control_mode === 'JUKEBOX') response.nextRequest = psaEntry;

      // Remember we handed this out as a viewer-driven play (PSA still counts as one)
      rememberHandoff(psa.name, 'psa');

      return res.json(response);
    }
  }

  if (cfg.viewer_control_mode === 'VOTING') {
    const top = getHighestVotedSequence();
    if (top) {
      response.winningVote = {
        sequence: top.sequence_name,
        playlistIndex: top.sort_order,
        votes: top.vote_count,
      };
      rememberHandoff(top.sequence_name, 'vote');
      if (cfg.reset_votes_after_round) {
        db.prepare(`DELETE FROM votes WHERE round_id = ?`).run(cfg.current_voting_round);
        advanceVotingRound();
        const io = req.app.get('io');
        if (io) io.emit('voteReset');
      }
    }
  } else if (cfg.viewer_control_mode === 'JUKEBOX') {
    const next = popNextQueuedRequest();
    if (next) {
      response.nextRequest = {
        sequence: next.sequence_name,
        playlistIndex: next.sort_order,
        queuedAt: next.requested_at,
      };
      rememberHandoff(next.sequence_name, 'request');
      const io = req.app.get('io');
      if (io) io.emit('queueUpdated');
    }
  }

  res.json(response);
});

// ============================================================
// Handoff tracking — short-lived in-memory map of "we just handed
// this sequence to FPP, so when it starts playing it counts as a
// viewer-driven play, not a schedule fill."
// ============================================================
const pendingHandoffs = new Map(); // sequence_name -> { source, expiresAt }
const HANDOFF_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function rememberHandoff(sequenceName, source) {
  if (!sequenceName) return;
  pendingHandoffs.set(sequenceName, {
    source,
    expiresAt: Date.now() + HANDOFF_WINDOW_MS,
  });
}

function consumeHandoff(sequenceName) {
  const entry = pendingHandoffs.get(sequenceName);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingHandoffs.delete(sequenceName);
    return null;
  }
  pendingHandoffs.delete(sequenceName);
  return entry.source;
}

// Periodic cleanup of expired handoffs
setInterval(() => {
  const now = Date.now();
  for (const [name, entry] of pendingHandoffs.entries()) {
    if (now > entry.expiresAt) pendingHandoffs.delete(name);
  }
}, 60 * 1000);

// Periodic cleanup of stale queue entries — handed off but never confirmed.
// Anything older than 5 minutes is marked played to keep the queue clean.
setInterval(() => {
  const { cleanupStaleHandoffs } = require('../lib/db');
  cleanupStaleHandoffs(300);
}, 60 * 1000);

// ============================================================
// POST /api/plugin/playing
// ============================================================
router.post('/playing', (req, res) => {
  const { sequence } = req.body || {};
  const name = (sequence || '').trim();

  setNowPlaying(name || null);

  if (name) {
    // Determine source: was this sequence just handed out to the plugin (viewer-driven),
    // or is FPP playing it from the schedule on its own?
    const handoffSource = consumeHandoff(name);
    const source = handoffSource || 'schedule';

    db.prepare(`
      INSERT INTO play_history (sequence_name, played_at, source)
      VALUES (?, CURRENT_TIMESTAMP, ?)
    `).run(name, source);

    // If this is a viewer-requested song, mark its queue entry as played now
    // (transitions from handed-off → confirmed-played)
    if (source === 'request') {
      const { markQueueEntryPlayed } = require('../lib/db');
      markQueueEntryPlayed(name);
      const io = req.app.get('io');
      if (io) io.emit('queueUpdated');
    }

    // Mark this sequence as played; reset its hidden counter
    // (only update sequences we actually know about — schedule fillers
    // may not be in our pool)
    db.prepare(`
      UPDATE sequences
      SET last_played_at = CURRENT_TIMESTAMP, plays_since_hidden = 0
      WHERE name = ?
    `).run(name);

    // Increment plays_since_hidden on all OTHER sequences (unhides them over time)
    db.prepare(`
      UPDATE sequences
      SET plays_since_hidden = plays_since_hidden + 1
      WHERE name != ? AND last_played_at IS NOT NULL
    `).run(name);
  }

  const io = req.app.get('io');
  if (io) io.emit('nowPlaying', { sequenceName: name || null });

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/next
// ============================================================
router.post('/next', (req, res) => {
  const { sequence } = req.body || {};
  const name = (sequence || '').trim();

  setNextScheduled(name || null);

  const io = req.app.get('io');
  if (io) io.emit('nextScheduled', { sequenceName: name || null });

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/heartbeat
// ============================================================
router.post('/heartbeat', (req, res) => {
  pluginStatus.lastSeen = new Date().toISOString();
  pluginStatus.version = req.body?.pluginVersion || null;
  // Persist so server restarts don't lose state
  updateConfig({
    plugin_last_seen_at: pluginStatus.lastSeen,
    plugin_version: pluginStatus.version,
  });
  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/sync-sequences
// Plugin pushes the current FPP playlist contents.
// Body: {
//   playlistName: "Remote Falcon Christmas",
//   sequences: [
//     { name: "Wizards_in_Winter", displayName: "Wizards in Winter", durationSeconds: 240 },
//     ...
//   ]
// }
//
// Behavior: upsert sequences by name. We DON'T delete sequences that aren't in
// the new list — that way admin can keep custom display_name/artist/category
// edits on sequences that get temporarily removed from the playlist.
// ============================================================
router.post('/sync-sequences', (req, res) => {
  const { playlistName, sequences } = req.body || {};

  if (!Array.isArray(sequences)) {
    return res.status(400).json({ error: 'sequences must be an array' });
  }

  // For inserts: display_order defaults to sort_order so new sequences sort naturally.
  // For updates: only touch sort_order (FPP index) + display_name. display_order is admin-owned.
  const upsert = db.prepare(`
    INSERT INTO sequences (name, display_name, duration_seconds, visible, votable, jukeboxable, sort_order, display_order)
    VALUES (@name, @display_name, @duration_seconds, 1, 1, 1, @sort_order, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      duration_seconds = excluded.duration_seconds,
      sort_order = excluded.sort_order,
      -- display_name is preserved if it was customized — only set if currently empty or equals name
      display_name = CASE
        WHEN sequences.display_name IS NULL
             OR sequences.display_name = ''
             OR sequences.display_name = sequences.name
        THEN excluded.display_name
        ELSE sequences.display_name
      END
  `);

  const toDisplayName = (fppName) =>
    String(fppName || '')
      .replace(/[_\-]+/g, ' ')          // underscores and dashes → spaces
      .replace(/\s+/g, ' ')             // collapse whitespace
      .trim();

  let inserted = 0;
  const tx = db.transaction((items) => {
    items.forEach((seq, index) => {
      const name = String(seq.name || '').trim();
      if (!name) return;
      upsert.run({
        name,
        display_name: String(seq.displayName || toDisplayName(name)).trim(),
        duration_seconds: Number.isFinite(seq.durationSeconds) ? seq.durationSeconds : null,
        sort_order: Number.isFinite(seq.playlistIndex) ? seq.playlistIndex : (index + 1),
      });
      inserted++;
    });
  });
  tx(sequences);

  // Track sync metadata + persist so it survives server restarts
  pluginStatus.lastSyncAt = new Date().toISOString();
  pluginStatus.lastSyncPlaylist = playlistName || null;
  pluginStatus.lastSyncCount = inserted;
  updateConfig({
    plugin_last_sync_at: pluginStatus.lastSyncAt,
    plugin_last_sync_playlist: pluginStatus.lastSyncPlaylist,
    plugin_last_sync_count: pluginStatus.lastSyncCount,
  });

  const io = req.app.get('io');
  if (io) io.emit('sequencesSynced', { count: inserted, playlistName });

  res.json({ ok: true, synced: inserted });

  // After responding, kick off auto-cover-fetch for any sequences without art.
  // Runs detached — sync response is already sent. Rate-limited internally.
  setImmediate(async () => {
    try {
      const missing = db.prepare(`
        SELECT id, name, display_name, artist FROM sequences
        WHERE (image_url IS NULL OR image_url = '') AND visible = 1
      `).all();
      if (missing.length === 0) return;

      const { autoFetchCover } = require('../lib/cover-art');
      const update = db.prepare(`UPDATE sequences SET image_url = ? WHERE id = ?`);
      console.log(`[cover-art] Auto-fetching covers for ${missing.length} sequences`);

      for (const seq of missing) {
        try {
          const localPath = await autoFetchCover(seq);
          if (localPath) {
            update.run(localPath, seq.id);
            console.log(`[cover-art] Got cover for ${seq.display_name || seq.name}`);
          }
        } catch (e) {
          console.warn(`[cover-art] Failed for ${seq.name}:`, e.message);
        }
        // Rate limit — MusicBrainz is 1 req/s per UA
        await new Promise(r => setTimeout(r, 1100));
      }
      console.log(`[cover-art] Auto-fetch complete`);
    } catch (e) {
      console.error('[cover-art] Auto-fetch crashed:', e.message);
    }
  });
});

// ============================================================
// POST /api/plugin/viewer-mode
// Body: { mode: "VOTING" | "JUKEBOX" | "OFF" | "ON" }
//
// Special cases:
//   mode = "ON"  — restore viewer control to the last non-OFF mode
//                  (useful for "Turn On" FPP commands that shouldn't
//                  hardcode a voting vs jukebox choice)
//   mode = "OFF" — also stashes the current mode so ON can restore it
//
// Used by FPP scheduler commands to toggle viewer control at showtime.
// Auth: same Bearer token as other plugin endpoints.
// ============================================================
router.post('/viewer-mode', (req, res) => {
  const { mode: requested } = req.body || {};
  const allowed = ['VOTING', 'JUKEBOX', 'OFF', 'ON'];

  if (!requested || !allowed.includes(requested)) {
    return res.status(400).json({
      error: 'mode must be VOTING, JUKEBOX, OFF, or ON',
    });
  }

  const { updateConfig } = require('../lib/db');
  const cfg = getConfig();
  let newMode;

  if (requested === 'ON') {
    // Restore the last active mode (defaults to VOTING)
    newMode = cfg.last_active_mode || 'VOTING';
    updateConfig({ viewer_control_mode: newMode });
  } else if (requested === 'OFF') {
    // Stash the current mode (if it's active) before turning off
    const updates = { viewer_control_mode: 'OFF' };
    if (cfg.viewer_control_mode && cfg.viewer_control_mode !== 'OFF') {
      updates.last_active_mode = cfg.viewer_control_mode;
    }
    updateConfig(updates);
    newMode = 'OFF';
  } else {
    // Explicit VOTING or JUKEBOX — also update last_active_mode
    updateConfig({ viewer_control_mode: requested, last_active_mode: requested });
    newMode = requested;
  }

  const io = req.app.get('io');
  if (io) io.emit('viewerModeChanged', { mode: newMode });

  res.json({ ok: true, mode: newMode, requested });
});

// ============================================================
// GET /api/plugin/health
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    plugin: pluginStatus,
  });
});

module.exports = router;
module.exports.pluginStatus = pluginStatus;
