// ============================================================
// ShowPilot — Plugin API
// Endpoints that the ShowPilot FPP plugin calls.
// Auth: Authorization: Bearer <showToken>
//
// Endpoints:
//   GET  /api/plugin/state            — one call, returns everything FPP needs to act
//   POST /api/plugin/playing          — FPP reports what's playing now (track-change edge)
//   POST /api/plugin/position         — FPP reports live playback position (every ~500ms)
//   POST /api/plugin/next             — FPP reports what's scheduled next
//   POST /api/plugin/heartbeat        — keepalive + plugin version sync
//   POST /api/plugin/sync-sequences   — plugin pushes the full sequence list
//   GET  /api/plugin/health           — plugin status visibility
// ============================================================

const express = require('express');
const router = express.Router();
const config = require('../lib/config-loader');
const {
  getConfig,
  updateConfig,
  setNowPlaying,
  setNextScheduled,
  setBaselineNext,
  getHighestVotedSequence,
  detectVoteTie,
  getTiebreakLeader,
  clearVotesForRound,
  clearTiebreakState,
  popNextQueuedRequest,
  advanceVotingRound,
  db,
} = require('../lib/db');

// Live playback position from FPP. Updated by POST /api/plugin/position
// roughly twice per second. In-memory only — no need to persist; if the
// server restarts, the next plugin tick refreshes it.
//
// Shape: { sequence: 'Ghostbusters', position: 14.27, updatedAt: 1234567890123 }
// updatedAt is server-side Date.now() at receipt — used by viewers to
// extrapolate "where IS the track now" by adding (now - updatedAt) to
// position. Network latency between plugin and server gets baked into
// updatedAt; this is fine because both ends of the calculation use
// server-side timestamps so they cancel.
let livePosition = null;

// Exported so other modules (routes/viewer.js) can read latest position.
function getLivePosition() {
  return livePosition;
}

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

// ============================================================
// Private IP validation for fppHost
// ============================================================
// We capture FPP's source IP from the heartbeat and use it as the upstream
// for our audio proxy. To prevent that proxy from being weaponized into an
// SSRF (e.g. if someone compromises the showToken AND can spoof X-
// Forwarded-For), we validate the source IP looks like a private LAN
// address. Public IPs are rejected outright — there is no legitimate
// scenario where FPP and ShowPilot are running on different sides of the
// public internet.
//
// We accept:
//   - RFC1918 ranges: 10.x, 172.16-31.x, 192.168.x
//   - Link-local: 169.254.x (rare but legitimate auto-config)
//   - Loopback: handled separately as null (means same-host install)
//
// We REJECT:
//   - Public IPv4 ranges
//   - 169.254.169.254 specifically (cloud metadata service — common SSRF target)
//   - IPv6 except loopback (no LAN IPv6 use case for FPP today)
function isPrivateLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // Cloud metadata endpoint — explicitly blocked even though it falls in 169.254.0.0/16
  if (ip === '169.254.169.254') return false;
  // Match RFC1918 + link-local
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  const m172 = ip.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172) {
    const n = Number(m172[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

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
    fppHost: cfg.plugin_fpp_host || null,
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

  // PSA check — if enabled and threshold met, play a PSA instead.
  // Two counting modes (psa_trigger_mode):
  //   'interactions' — count viewer interactions (votes / jukebox requests).
  //                    Counter is interactions_since_last_psa, incremented
  //                    in /vote and /jukebox/add. Only meaningful when
  //                    viewers are actually engaging.
  //   'sequences' —    count FPP sequence transitions (excluding PSAs
  //                    themselves). Counter is sequences_since_last_psa,
  //                    incremented in /playing below. Fires regardless of
  //                    viewer activity — best for schedule-driven shows.
  //
  // OFF-mode rule (v0.30.1+): when viewer_control_mode is OFF, ShowPilot
  // is hands-off — it observes FPP via /playing for the now-playing
  // display but never directs FPP. PSAs are a form of direction (we tell
  // the plugin to play a specific sequence), so they don't fire in OFF
  // mode regardless of trigger mode or threshold. The counters keep
  // incrementing in the background so when viewer mode is re-enabled,
  // PSAs can fire normally without a hard reset.
  if (cfg.viewer_control_mode !== 'OFF' && cfg.play_psa_enabled && cfg.psa_frequency > 0) {
    const mode = cfg.psa_trigger_mode === 'sequences' ? 'sequences' : 'interactions';
    const counter = mode === 'sequences'
      ? (cfg.sequences_since_last_psa || 0)
      : (cfg.interactions_since_last_psa || 0);

    if (counter >= cfg.psa_frequency) {
      const psa = db.prepare(`
        SELECT name, sort_order FROM sequences
        WHERE is_psa = 1 AND visible = 1
        ORDER BY COALESCE(last_played_at, '1970-01-01') ASC
        LIMIT 1
      `).get();

      if (psa) {
        const psaEntry = { sequence: psa.name, playlistIndex: psa.sort_order };
        response.psa = psaEntry;
        // Reset only the counter we acted on. The other counter keeps
        // accumulating in the background — operators switching modes
        // mid-show don't get a hard reset to zero.
        if (mode === 'sequences') {
          db.prepare(`UPDATE config SET sequences_since_last_psa = 0 WHERE id = 1`).run();
        } else {
          db.prepare(`UPDATE config SET interactions_since_last_psa = 0 WHERE id = 1`).run();
        }

        // Deliver PSA via the mode-appropriate slot so plugin acts on it
        if (cfg.viewer_control_mode === 'VOTING') response.winningVote = psaEntry;
        else if (cfg.viewer_control_mode === 'JUKEBOX') response.nextRequest = psaEntry;

        // Remember we handed this out as a viewer-driven play (PSA still counts as one)
        rememberHandoff(psa.name, 'psa');

        return res.json(response);
      }
    }
  }

  if (cfg.viewer_control_mode === 'VOTING') {
    // ---- Tiebreak resolution (v0.24.0+) ----
    //
    // Three tiebreak code paths possible here:
    //   (1) Tiebreak ALREADY active and resolves now (clear leader emerged
    //       from tiebreak votes) → return that as the winner.
    //   (2) Tiebreak ALREADY active and timer expired → dump all votes for
    //       the round, clear tiebreak state, return no winner. FPP plays
    //       its scheduled next song.
    //   (3) No tiebreak active and we'd normally pick a winner, but votes
    //       are tied at the top → start tiebreak, return no winner this
    //       poll, and emit a socket event so viewers can show the
    //       tiebreak banner + cast tiebreak votes.
    // If tiebreak feature is disabled (cfg.tiebreak_enabled === 0), we
    // skip all this and use the original first-vote-wins behavior.
    const tiebreakEnabled = cfg.tiebreak_enabled === 1;
    let returnedWinner = false;

    if (tiebreakEnabled && cfg.tiebreak_active === 1 && cfg.tiebreak_deadline_at) {
      const candidates = (cfg.tiebreak_candidates || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      // Use the stored deadline (set when tiebreak started, capped at
      // min(timer-expiry, current-song-end)) rather than re-computing
      // from started_at + duration. This ensures the deadline shown to
      // viewers and the deadline we enforce are the same value, even
      // across server restarts or clock weirdness.
      const deadlineMs = new Date(cfg.tiebreak_deadline_at + 'Z').getTime();
      const nowMs = Date.now();

      if (nowMs >= deadlineMs) {
        // Timer expired. Dump everything.
        clearVotesForRound(cfg.current_voting_round);
        clearTiebreakState();
        // Advance the round — votes are gone, we're moving on. Next
        // round starts fresh.
        require('../lib/db').advanceVotingRound();
        const io = req.app.get('io');
        if (io) {
          io.emit('voteReset');
          io.emit('tiebreakFailed', {
            candidates,
            reason: 'deadline reached without clear winner',
          });
        }
        // Fall through — no winner. Plugin handles this by letting FPP
        // play its scheduled next song.
      } else {
        // Tiebreak still active. Check for resolution.
        const leader = getTiebreakLeader(cfg.current_voting_round, candidates);
        if (leader) {
          response.winningVote = {
            sequence: leader.sequence_name,
            playlistIndex: leader.sort_order,
            votes: leader.vote_count,
          };
          rememberHandoff(leader.sequence_name, 'vote');
          // Resolution will be finalized in /playing when this winner
          // starts playing. Don't clear state yet — viewer banner still
          // shows tiebreak in progress until song actually changes.
          // (Same model as normal voting: round advances on song change.)
          returnedWinner = true;
        }
        // else: still tied within candidates, no winner this poll
      }
    } else if (tiebreakEnabled) {
      // Path 3: no tiebreak active. Check if we'd normally pick a winner
      // but there's a tie at the top.
      const tied = detectVoteTie(cfg.current_voting_round);
      if (tied) {
        // Compute the tiebreak deadline. The configured timer is the
        // worst-case max, but the tie window can never extend PAST the
        // current song's end — otherwise the banner stays up into the
        // next song's playback, which is wrong (next song was either
        // a tiebreak winner or a schedule fill, either way the round
        // moves on at song change).
        //
        // We need: the wall-clock moment the current song will end.
        //   currentSongEndMs = trackStartedAtMs + duration_seconds * 1000
        // If we don't know the duration (plugin hasn't synced sequences,
        // or the sequence row is missing), fall back to the configured
        // timer alone — better to over-extend than to expire instantly.
        const nowMs = Date.now();
        const durationCapMs = (cfg.tiebreak_duration_sec || 60) * 1000;
        const timerDeadlineMs = nowMs + durationCapMs;

        let songEndMs = null;
        try {
          const np = db.prepare(`SELECT sequence_name, started_at FROM now_playing WHERE id = 1`).get();
          if (np && np.sequence_name && np.started_at) {
            const seq = db.prepare(
              `SELECT duration_seconds FROM sequences WHERE name = ? COLLATE NOCASE`
            ).get(np.sequence_name);
            if (seq && seq.duration_seconds && seq.duration_seconds > 0) {
              // started_at is stored as UTC text in SQLite — append 'Z'
              // so JS treats it as UTC, not local.
              const startedMs = new Date(np.started_at + 'Z').getTime();
              if (isFinite(startedMs)) {
                songEndMs = startedMs + (seq.duration_seconds * 1000);
              }
            }
          }
        } catch (e) {
          console.warn('[tiebreak] could not compute song end:', e.message);
        }

        // Take the EARLIER of the two caps. If we have no song end,
        // use the timer alone.
        const deadlineMs = (songEndMs && songEndMs > nowMs)
          ? Math.min(timerDeadlineMs, songEndMs)
          : timerDeadlineMs;
        const deadlineIso = new Date(deadlineMs).toISOString().slice(0, 19).replace('T', ' ');
        const startedAtIso = new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
          UPDATE config
          SET tiebreak_active = 1,
              tiebreak_started_at = ?,
              tiebreak_deadline_at = ?,
              tiebreak_candidates = ?
          WHERE id = 1
        `).run(startedAtIso, deadlineIso, tied.join(','));

        const io = req.app.get('io');
        if (io) {
          // Look up display info for each candidate so viewers can render
          // a rich tiebreak banner with names + images.
          const placeholders = tied.map(() => '?').join(',');
          const rows = db.prepare(`
            SELECT name, display_name, artist, image_url
            FROM sequences
            WHERE name IN (${placeholders}) COLLATE NOCASE
          `).all(...tied);
          const candidateInfo = rows.map(r => ({
            sequenceName: r.name,
            displayName: r.display_name || r.name,
            artist: r.artist || '',
            imageUrl: r.image_url || '',
          }));
          // Send absolute deadline (server wall-clock ms) instead of a
          // relative duration. Viewers compute remaining = deadline - now,
          // which is correct regardless of when they receive the event
          // and accounts for any clock skew using the same burst-sync
          // offset they already have.
          io.emit('tiebreakStarted', {
            candidates: candidateInfo,
            deadlineAtMs: deadlineMs,
            startedAtMs: nowMs,
          });
        }
        // No winner returned this poll. Plugin lets FPP play schedule.
      } else {
        // No tie. Fall back to normal winner selection.
        const top = getHighestVotedSequence();
        if (top) {
          response.winningVote = {
            sequence: top.sequence_name,
            playlistIndex: top.sort_order,
            votes: top.vote_count,
          };
          rememberHandoff(top.sequence_name, 'vote');
          returnedWinner = true;
        }
      }
    } else {
      // Tiebreak feature disabled → original behavior (first-vote-wins).
      const top = getHighestVotedSequence();
      if (top) {
        response.winningVote = {
          sequence: top.sequence_name,
          playlistIndex: top.sort_order,
          votes: top.vote_count,
        };
        rememberHandoff(top.sequence_name, 'vote');
        returnedWinner = true;
      }
    }
    // Round advances when the new song starts playing — handled in /playing.
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

  // Snapshot the main-playlist return point at handoff time. Which song is
  // "next" depends on whether interrupt mode is on:
  //   interrupt ON  → FPP pauses the current song mid-track and resumes it
  //                   exactly where it left off, so the return point is the
  //                   currently-playing song (sequence_name).
  //   interrupt OFF → the current song plays to completion first, so the
  //                   return point is the next scheduled song (next_sequence_name).
  // Only save on the first handoff — subsequent vote/request wins before the
  // main playlist resumes don't change where FPP will return to.
  res.json(response);

  // Save the main-playlist return point AFTER sending the response so a
  // DB error here can never block the FPP handoff. If this fails it's
  // logged but jukebox/voting still works on that poll.
  if (response.winningVote || response.nextRequest) {
    try {
      const npState = db.prepare('SELECT sequence_name, next_sequence_name, baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
      if (npState && !npState.baseline_next_sequence_name) {
        const baselineName = cfg.interrupt_schedule === 1
          ? npState.sequence_name
          : npState.next_sequence_name;
        if (baselineName) setBaselineNext(baselineName);
      }
    } catch (e) {
      console.error('[baseline] Failed to save baseline_next_sequence_name:', e.message);
    }
  }
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
// Anything older than 5 minutes (handed-off) or 2 hours (un-handed) is
// marked played to keep the queue clean across plugin restarts.
setInterval(() => {
  const { cleanupStaleHandoffs, cleanupStaleRequests } = require('../lib/db');
  cleanupStaleHandoffs(300);
  cleanupStaleRequests(120);
}, 60 * 1000);

// ============================================================
// POST /api/plugin/playing
// ============================================================
router.post('/playing', (req, res) => {
  const { sequence, seconds_played } = req.body || {};
  const name = (sequence || '').trim();

  // Detect if this is a fresh sequence change (different from what was playing)
  // BEFORE setNowPlaying overwrites it. We use this to advance the voting
  // round on ANY song change in voting mode, not just when the winner plays.
  // (See round-close logic below.)
  const previouslyPlaying = db.prepare(`SELECT sequence_name FROM now_playing WHERE id = 1`).get();
  const isSequenceChange = !!name && (!previouslyPlaying || previouslyPlaying.sequence_name !== name);

  // When the main playlist resumes at the expected return point, clear the
  // baseline so subsequent "Up Next" display switches back to FPP's live report.
  if (isSequenceChange && name) {
    const npBaseline = db.prepare('SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
    if (npBaseline && npBaseline.baseline_next_sequence_name === name) {
      setBaselineNext(null);
    }
  }

  // If the plugin reported a playback position, backdate started_at so the
  // audio player knows the song has been playing for that long. This handles
  // the "interrupt-then-resume" case: when FPP plays a request and then comes
  // back to the original song mid-track, seconds_played > 0 and we shouldn't
  // pretend the song just started.
  const playedSec = (typeof seconds_played === 'number' && isFinite(seconds_played) && seconds_played > 0)
    ? seconds_played
    : 0;
  setNowPlaying(name || null, playedSec);

  if (name) {
    // Determine source: was this sequence just handed out to the plugin (viewer-driven),
    // or is FPP playing it from the schedule on its own?
    const handoffSource = consumeHandoff(name);
    const source = handoffSource || 'schedule';

    // When FPP plays a scheduled song (not a viewer vote/request/PSA handoff),
    // the main playlist has resumed. Clear the baseline so "Up Next" reverts
    // to FPP's live report. Using source rather than name-matching handles
    // the case where FPP resumes at an unexpected position (loop, admin skip).
    if (isSequenceChange && source === 'schedule') {
      try { setBaselineNext(null); } catch (e) {
        console.error('[baseline] Failed to clear baseline_next_sequence_name:', e.message);
      }
    }

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

    // ---- Voting round close (v0.23.10+) ----
    // The round advances whenever the playing sequence changes while in
    // VOTING mode, regardless of whether the new song was the vote winner
    // or a schedule fill. Earlier (v0.23.7) we only advanced when the
    // winner ACTUALLY played, but that broke when the plugin couldn't
    // queue the winner in time — the round never closed and viewers got
    // "already voted" forever. The cleaner model: each song = one round.
    //
    // If the winner did play, the toast still fires. If not, votes still
    // reset so the next round starts fresh.
    //
    // Diagnostic logging: log every /playing report with mode + change
    // detection + handoff source. Helps debug "round stuck" issues.
    const cfgForRound = getConfig();
    console.log(`[playing] seq="${name}" source=${source} mode=${cfgForRound.viewer_control_mode} isChange=${isSequenceChange}`);

    const isVoting = cfgForRound.viewer_control_mode === 'VOTING';
    if (isVoting && isSequenceChange && cfgForRound.reset_votes_after_round) {
      // Determine if this song change is a tiebreak resolution.
      // Tiebreak rules:
      //   - If the winning sequence (by handoff) is a tiebreak candidate
      //     AND tiebreak was active → tiebreak resolved successfully.
      //   - If tiebreak was active but song change happened to something
      //     else (FPP played schedule because winner couldn't queue in
      //     time) → tiebreak failed; emit tiebreakFailed.
      //   - If no tiebreak was active → normal round-end behavior.
      // Either way, the round advances now — song change always ends
      // the round. This makes the tiebreak window naturally cap at
      // current-song-end even if the configured timer is longer.
      let winnerInfo = null;
      const wasTiebreak = cfgForRound.tiebreak_active === 1;
      const tiebreakCandidates = (cfgForRound.tiebreak_candidates || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      if (source === 'vote') {
        const seqRow = db.prepare(`
          SELECT display_name, name, image_url, artist
          FROM sequences WHERE name = ? COLLATE NOCASE
        `).get(name);
        winnerInfo = {
          sequenceName: name,
          displayName: (seqRow && seqRow.display_name) || name,
          artist: (seqRow && seqRow.artist) || '',
          imageUrl: (seqRow && seqRow.image_url) || '',
        };
      }

      // Clear BOTH main-round and tiebreak votes for the closing round.
      clearVotesForRound(cfgForRound.current_voting_round);
      // If a tiebreak was active, clear that state too.
      if (wasTiebreak) clearTiebreakState();
      advanceVotingRound();
      const io = req.app.get('io');
      if (io) {
        io.emit('voteReset');
        if (winnerInfo) {
          // Vote-winning song actually played. Fire the celebratory toast.
          io.emit('votingRoundEnded', winnerInfo);
        } else if (wasTiebreak) {
          // Tiebreak was open but song change happened without a vote
          // winner playing. Either the timer expired (handled in /state)
          // or FPP played its scheduled song before tiebreak could
          // resolve. Tell viewers the tiebreak failed so they can
          // dismiss the banner.
          io.emit('tiebreakFailed', {
            candidates: tiebreakCandidates,
            reason: 'song changed before tiebreak resolved',
          });
        }
      }
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

    // Per-sequence cooldown (v0.29.2+): if the sequence that just started
    // has cooldown_minutes > 0, purge any OTHER pending requests for the
    // same sequence so it can't immediately repeat. We delete only entries
    // that haven't been handed off to FPP yet (handed_off_at IS NULL) —
    // an in-flight entry is the one currently playing or about to start
    // and shouldn't be removed. The cooldown timer itself is implicit:
    // last_played_at + cooldown_minutes is checked at request/voting time.
    const seq = db.prepare(`SELECT id, cooldown_minutes, is_psa FROM sequences WHERE name = ?`).get(name);
    if (seq && seq.cooldown_minutes > 0) {
      const purged = db.prepare(`
        DELETE FROM jukebox_queue
        WHERE sequence_id = ? AND played = 0 AND handed_off_at IS NULL
      `).run(seq.id);
      if (purged.changes > 0) {
        console.log(`[cooldown] Purged ${purged.changes} queued copies of "${name}" (cooldown ${seq.cooldown_minutes}m)`);
      }
    }

    // Sequence-based PSA counter (v0.30.0+). Increment on every NON-PSA
    // sequence transition. PSAs themselves don't count toward the next
    // PSA — otherwise frequency=1 would loop PSA→PSA forever. We also
    // only increment for sequences ShowPilot knows about (seq is non-null);
    // schedule fillers FPP plays that aren't in our DB don't count. The
    // counter increments regardless of psa_trigger_mode so switching
    // modes doesn't lose history. The threshold check in /state decides
    // whether to consult it.
    if (seq && !seq.is_psa) {
      db.prepare(`UPDATE config SET sequences_since_last_psa = sequences_since_last_psa + 1 WHERE id = 1`).run();
    }
  }

  const io = req.app.get('io');
  if (io) io.emit('nowPlaying', { sequenceName: name || null });

  // Relay disabled — audio sync now uses cache delivery + WebSocket position
  // correction via fppPosition events from the daemon. The relay was opening
  // one connection to FPP per song change and streaming bytes that nobody
  // was connecting to, wasting CPU and bandwidth.

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/position
// Plugin reports FPP's live playback position. Called every ~500ms
// while audio is playing. Updates in-memory livePosition and pushes
// to all viewer clients via socket.io for near-real-time sync.
//
// This is the new high-cadence position channel. The /playing
// endpoint stays for track-change events (which establish the
// initial anchor for new sequences); /position keeps the position
// fresh during a track. Both can fire — they don't conflict.
//
// Body: { sequence: string, position: number }
// ============================================================
router.post('/position', (req, res) => {
  const { sequence, position } = req.body || {};
  const name = (sequence || '').trim();
  const pos = (typeof position === 'number' && isFinite(position) && position >= 0)
    ? position : null;

  if (!name || pos === null) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  // Stamp arrival time using server clock. Viewers will use this to
  // extrapolate forward: actualPosition = position + (now - updatedAt) / 1000
  livePosition = {
    sequence: name,
    position: pos,
    updatedAt: Date.now(),
  };

  // Bump now_playing.last_updated so the viewer's showNotPlaying gate
  // (in routes/viewer.js#visual-config) sees a fresh heartbeat. Without
  // this, last_updated only advances on sequence CHANGE (via setNowPlaying),
  // which means it goes stale within seconds of a song starting and the
  // viewer flaps to "Show isn't playing." Plugin reports /position every
  // ~1s while a sequence is playing, so this naturally keeps the row
  // fresh and goes stale within seconds when the plugin stops reporting
  // (FPP idle / plugin hung / network partition).
  //
  // Guard with sequence_name match: if the server has already advanced
  // to a new sequence (via /playing) when a stale /position for the old
  // sequence races in, don't overwrite. The mismatched UPDATE is a no-op.
  db.prepare(`
    UPDATE now_playing
    SET last_updated = CURRENT_TIMESTAMP
    WHERE id = 1 AND sequence_name = ?
  `).run(name);

  // Emit to all connected viewers. They'll use this as the freshest
  // anchor for sync — replaces extrapolating from a stale started_at.
  const io = req.app.get('io');
  if (io) {
    io.emit('positionUpdate', {
      sequence: name,
      position: pos,
      updatedAt: livePosition.updatedAt,
    });
  }

  // Plugin doesn't care about response body — just status.
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
  if (io) {
    // While an interrupting song plays, FPP reports the next song in the
    // voting/request playlist. Emit the baseline instead so socket-connected
    // viewers see the main-playlist return point, consistent with /api/state.
    const npBaseline = db.prepare('SELECT baseline_next_sequence_name FROM now_playing WHERE id = 1').get();
    const emitName = (npBaseline && npBaseline.baseline_next_sequence_name) || name || null;
    io.emit('nextScheduled', { sequenceName: emitName });
  }

  res.json({ ok: true });
});

// ============================================================
// POST /api/plugin/heartbeat
// ============================================================
router.post('/heartbeat', (req, res) => {
  pluginStatus.lastSeen = new Date().toISOString();
  pluginStatus.version = req.body?.pluginVersion || null;
  // Capture the plugin's source IP — this is FPP's address, used as the
  // upstream for audio proxy streams. We strip ::ffff: prefix from IPv4-mapped
  // IPv6 addresses, and ignore localhost (means ShowPilot is on FPP itself).
  let fppHost = req.ip || req.connection?.remoteAddress || null;
  if (fppHost && fppHost.startsWith('::ffff:')) fppHost = fppHost.slice(7);
  if (fppHost === '::1' || fppHost === '127.0.0.1') fppHost = null;

  // Reject public IPs as fppHost. The audio proxy uses this value as the
  // upstream — if an attacker had a compromised showToken AND could spoof
  // their source IP, an unvalidated value here would allow them to redirect
  // every audio-stream request to any internet host (SSRF). FPP only ever
  // runs on a LAN, so a private-IP-only check is correct.
  if (fppHost && !isPrivateLanIp(fppHost)) {
    console.warn(`[plugin] Rejecting non-private fppHost: ${fppHost} (heartbeat ignored for IP storage)`);
    fppHost = null;
  }

  // Persist so server restarts don't lose state. We only update plugin_fpp_host
  // when we have a valid value — otherwise we'd clobber a known-good value
  // every time a malformed heartbeat arrived.
  const updates = {
    plugin_last_seen_at: pluginStatus.lastSeen,
    plugin_version: pluginStatus.version,
  };
  if (fppHost) updates.plugin_fpp_host = fppHost;
  updateConfig(updates);
  pluginStatus.fppHost = fppHost || pluginStatus.fppHost;
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
    INSERT INTO sequences (name, display_name, artist, image_url, media_name, duration_seconds, visible, votable, jukeboxable, sort_order, display_order)
    VALUES (@name, @display_name, @artist, @image_url, @media_name, @duration_seconds, 1, 1, 1, @sort_order, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      duration_seconds = excluded.duration_seconds,
      sort_order = excluded.sort_order,
      -- media_name comes straight from FPP — always trust the plugin's value
      media_name = excluded.media_name,
      -- display_name is preserved if it was customized — only update if it's still
      -- the default (NULL, empty, or equal to the raw filename name).
      display_name = CASE
        WHEN sequences.display_name IS NULL
             OR sequences.display_name = ''
             OR sequences.display_name = sequences.name
        THEN excluded.display_name
        ELSE sequences.display_name
      END,
      -- artist is the same idea: only fill if not already set
      artist = CASE
        WHEN (sequences.artist IS NULL OR sequences.artist = '')
             AND excluded.artist IS NOT NULL AND excluded.artist != ''
        THEN excluded.artist
        ELSE sequences.artist
      END,
      -- image_url: only set from sync if no image already exists. This protects
      -- manually-uploaded album art from being overwritten by a tag-derived URL.
      image_url = CASE
        WHEN (sequences.image_url IS NULL OR sequences.image_url = '')
             AND excluded.image_url IS NOT NULL AND excluded.image_url != ''
        THEN excluded.image_url
        ELSE sequences.image_url
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
        artist: String(seq.artist || '').trim() || null,
        image_url: String(seq.imageUrl || '').trim() || null,
        media_name: String(seq.mediaName || '').trim() || null,
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

// ============================================================
// AUDIO CACHE — see lib/audio-cache.js for full architecture notes.
// ============================================================
// Plugin pushes audio files to ShowPilot during sync so viewer requests
// can be served from local disk instead of proxying through FPP. This
// scales to many concurrent viewers and dramatically improves audio
// start latency by eliminating the cross-network hop.
//
// Three endpoints:
//   GET  /audio-cache/manifest  — list of hashes ShowPilot already has
//   POST /audio-cache/upload    — upload one file, body is raw bytes
//   POST /audio-cache/link      — associate (mediaName → hash) when
//                                 server already had the file from a
//                                 previous sync
// ============================================================

const audioCache = require('../lib/audio-cache');

// Plugin asks: "what hashes do you already have?" so it can upload only
// what's missing. Returns a flat array — the plugin computes the diff
// against its local file list. Cheap to call, idempotent.
//
// audioEnabled is the master server-side switch that tells the plugin
// whether to bother syncing audio at all. When false, the plugin should
// skip the upload phase entirely (don't even compute hashes — saves
// CPU and disk reads on FPP). The plugin's own "Enable audio sync"
// toggle is a local opt-out; the server's "audio_enabled" is global
// and authoritative. If the server says no, the plugin says no.
router.get('/audio-cache/manifest', (req, res) => {
  const cfg = getConfig();
  const audioEnabled = cfg.audio_enabled !== 0;
  if (!audioEnabled) {
    return res.json({
      audioEnabled: false,
      haveHashes: [],
      fileCount: 0,
      totalBytes: 0,
    });
  }
  const haveHashes = audioCache.getCachedHashes();
  const stats = audioCache.getCacheStats();
  res.json({
    audioEnabled: true,
    haveHashes,
    fileCount: stats.fileCount,
    totalBytes: stats.totalBytes,
  });
});

// Plugin uploads a single file. Query string carries the hash and
// mediaName; body is the raw bytes. We use raw body parsing (not JSON,
// not multipart) to keep the plugin side simple — file bytes go in the
// HTTP body verbatim, no encoding overhead.
//
// Why query string for hash/mediaName? Because the audio body can be
// 5+ MB and we don't want to base64 it into JSON (33% size penalty)
// or wrap it in multipart (more code on both sides for marginal benefit).
//
// Size limit is generous (50MB) — typical 4-min MP3 is 4-5MB but FLAC
// or longer mixes could be larger. Headlining limit is express.json's
// 1mb cap which doesn't apply here because we use express.raw().
router.post(
  '/audio-cache/upload',
  // express.raw with high limit, accepts any content-type. We don't
  // require a specific MIME because FPP could be serving MP3, OGG, FLAC,
  // WAV — whatever the user uploaded to FPP's music dir.
  express.raw({ type: '*/*', limit: '50mb' }),
  (req, res) => {
    // Defense in depth — even if an old plugin hasn't been updated to
    // honor the audioEnabled flag from /manifest, refuse the upload.
    // Admin chose to disable audio for a reason; we don't write 5MB
    // files to disk against their wishes.
    const cfg = getConfig();
    if (cfg.audio_enabled === 0) {
      return res.status(403).json({ error: 'Audio is disabled for this show', audioEnabled: false });
    }
    const claimedHash = String(req.query.hash || '').toLowerCase();
    const mediaName = String(req.query.mediaName || '');
    const mimeType = req.query.mimeType ? String(req.query.mimeType) : (req.headers['content-type'] || 'audio/mpeg');

    if (!audioCache.isValidHash(claimedHash)) {
      return res.status(400).json({ error: 'Invalid hash format' });
    }
    if (!mediaName) {
      return res.status(400).json({ error: 'mediaName required' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty body — expected raw audio bytes' });
    }

    try {
      audioCache.storeUploadedFile(req.body, claimedHash, mediaName, mimeType);
      // Also stamp the hash onto every sequence row whose media_name
      // matches. This is the v0.24.3+ many-to-one fix: cache lookup
      // now goes sequence → audio_hash → cache row, so a sequence
      // without audio_hash won't find its file even if the cache row
      // exists. Multiple sequences with the same media_name (e.g.
      // "indoor+outdoor" and "outdoor only" variants of the same song)
      // all get the same hash here and share the cache row cleanly.
      try {
        db.prepare(
          `UPDATE sequences SET audio_hash = ? WHERE media_name = ?`
        ).run(claimedHash, mediaName);
      } catch (e) {
        console.warn('[audio-cache/upload] could not stamp audio_hash on sequences:', e.message);
      }
      res.json({ ok: true, hash: claimedHash, sizeBytes: req.body.length });
    } catch (err) {
      // Hash mismatch is the most likely cause — return a structured error
      // so the plugin can decide whether to retry or skip.
      res.status(400).json({ error: err.message });
    }
  }
);

// Plugin says: "I have this mediaName mapped to this hash, and you
// already told me you have the hash, so just link them." Avoids
// re-uploading bytes we already have. Common case: same audio file
// appears in multiple sequences, or sync runs after a no-op restart.
router.post('/audio-cache/link', (req, res) => {
  const cfg = getConfig();
  if (cfg.audio_enabled === 0) {
    return res.status(403).json({ error: 'Audio is disabled for this show', audioEnabled: false });
  }
  const { mediaName, hash } = req.body || {};
  if (!hash || !audioCache.isValidHash(String(hash).toLowerCase())) {
    return res.status(400).json({ error: 'Invalid hash format' });
  }
  if (!mediaName) {
    return res.status(400).json({ error: 'mediaName required' });
  }
  try {
    const lowerHash = String(hash).toLowerCase();
    audioCache.linkMediaNameToHash(String(mediaName), lowerHash);
    // Stamp this hash onto every sequence row matching the media_name —
    // see /audio-cache/upload for the rationale. Defensive update
    // covers the case where two FPP sequences share the same audio
    // filename, AND the case where a sequence's media_name was just
    // renamed (the new name maps to the same bytes as before).
    try {
      db.prepare(
        `UPDATE sequences SET audio_hash = ? WHERE media_name = ?`
      ).run(lowerHash, String(mediaName));
    } catch (e) {
      console.warn('[audio-cache/link] could not stamp audio_hash on sequences:', e.message);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Plugin can ask us to clean up cache entries for media files that no
// longer correspond to any sequence. Useful at end of sync to keep
// the cache from growing forever.
router.post('/audio-cache/prune', (req, res) => {
  const removed = audioCache.pruneOrphanedHashes();
  res.json({ ok: true, removed });
});

module.exports = router;
module.exports.pluginStatus = pluginStatus;
module.exports.getLivePosition = getLivePosition;
