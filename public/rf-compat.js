// ============================================================
// ShowPilot — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to ShowPilot's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__SHOWPILOT__ || {};
  let cachedLocation = null;
  let hasVoted = false;
  // Vote shifting (v0.32.6+): when allowVoteChange is true, a user who has
  // already voted can click another song to switch. Track which song they
  // last voted for so we can no-op a click on the same one and show
  // friendlier feedback ("Vote changed" vs. "Vote cast").
  // allowVoteChange is read from boot first and refreshed on every /api/state.
  let votedFor = null;
  let allowVoteChange = !!boot.allowVoteChange;
  // Last-known voting round id, refreshed on every /api/state response.
  // When this changes (server advanced past our vote), we clear hasVoted
  // so the user can vote in the new round. Backup mechanism for
  // voteReset socket events that may be missed on mobile when the
  // socket dies during backgrounding.
  let lastKnownRoundId = null;
  // Show name as last seen from the server. When this changes, we update
  // document.title — but only if the title currently matches what we last
  // saw, so a template that hard-coded its own <title> isn't stomped on.
  let lastKnownShowName = null;
  // Tiebreak state — separate from main-round vote tracking. A user who
  // voted in the main round can still cast a tiebreak vote; this flag
  // tracks the latter independently.
  let hasTiebreakVoted = false;
  // Active tiebreak metadata. Populated by socket event 'tiebreakStarted'
  // OR by /api/state when reconnecting mid-tiebreak (page reload during
  // a tiebreak window). Null when no tiebreak is in progress.
  let tiebreakState = null; // { candidates: [{sequenceName,...}], deadline_ms }
  let tiebreakCountdownTimer = null;

  // Now-playing timer (v0.32.9+).
  // RF compatibility: implements the {NOW_PLAYING_TIMER} placeholder
  // (countdown of remaining time in the current sequence). The renderer
  // emits <span data-showpilot-timer> elements with initial server-computed
  // text; this code ticks them client-side once a second. State is the
  // server-anchored start time + duration. When either is missing, the
  // ticker writes --:--; once remaining hits zero, it writes 0:00 and
  // stops updating until /api/state reports a new song.
  //
  // We deliberately do NOT use the audio engine's clock-sync (clockOffset)
  // here. The timer ticks at second granularity; sub-second sync isn't
  // visible. Avoiding the dependency keeps this code module-isolated and
  // works even when audio is disabled.
  let timerStartedAtMs = null;     // ms epoch when the song started (server's clock)
  let timerDurationSec = null;     // seconds, total length
  let timerInterval = null;        // setInterval handle

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  // Vote-specific success goes to #voteSuccessful when present (so templates
  // can word it differently from the jukebox "Successfully Added"); falls
  // back to #requestSuccessful for templates that don't define a separate
  // vote message. This keeps backward compatibility with all imported RF
  // templates while letting newer templates differentiate the two flows.
  const MSG_IDS = {
    success: 'requestSuccessful',
    voteSuccess: 'voteSuccessful',
    invalidLocation: 'invalidLocation',
    invalidLocationCode: 'invalidLocationCode',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
    songPlaying: 'songPlaying',
    songNextUp:  'songNextUp',
  };

  function showMessage(id, durationMs, textOverride, fallbackText) {
    let el = document.getElementById(id);
    let usedFallback = false;
    // Fallback: if a vote-specific success isn't defined in this template,
    // use the generic success element. Some templates only have one.
    if (!el && id === MSG_IDS.voteSuccess) {
      el = document.getElementById(MSG_IDS.success);
      usedFallback = true;
    }
    // Fallback: if a specific error element isn't in this template (e.g. code-mode
    // or imported RF templates that predate these IDs), show #requestFailed with
    // the actual server error text so the user gets a meaningful message.
    if (!el && fallbackText) {
      el = document.getElementById(MSG_IDS.failed);
      if (el) textOverride = fallbackText;
    }
    if (!el) {
      console.warn('[ShowPilot] no element with id', id, '— message could not be displayed');
      return;
    }
    // If we fell back from voteSuccess to requestSuccess, override the
    // text so the user doesn't see jukebox wording ("Successfully Added")
    // for a vote action. We stash the original HTML the first time we
    // override so the element returns to its original wording for
    // subsequent jukebox successes (templates may use the same element
    // for both, just changing wording per-action).
    //
    // Templates with their own #voteSuccessful div get whatever wording
    // they put inside it; this only kicks in for templates that don't
    // define one. textOverride lets callers pass custom wording too.
    const desiredText = textOverride || (
      (id === MSG_IDS.voteSuccess || (usedFallback && id === MSG_IDS.voteSuccess))
        ? 'You\'ve Successfully Voted! 🗳️'
        : null
    );
    if (desiredText) {
      if (!el.__showpilotOriginalHtml) {
        el.__showpilotOriginalHtml = el.innerHTML;
      }
      el.textContent = desiredText;
    } else if (el.__showpilotOriginalHtml) {
      // Restore original wording for non-vote uses of the same element
      el.innerHTML = el.__showpilotOriginalHtml;
    }
    el.style.display = 'block';
    // Tap-to-dismiss: most templates style these as floating overlays
    // with cursor: pointer, but no actual click handler. Add one so
    // users who tap the message can dismiss it immediately rather than
    // wait for the timeout. Idempotent — set once per element.
    if (!el.__showpilotDismissBound) {
      el.addEventListener('click', () => { el.style.display = 'none'; });
      el.__showpilotDismissBound = true;
    }
    if (el.__showpilotHideTimer) clearTimeout(el.__showpilotHideTimer);
    el.__showpilotHideTimer = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs || 3000);
  }

  function mapErrorToId(error, data) {
    // Server explicitly flags code failures (v0.33.24+) — use the dedicated toast.
    if (data && data.invalidLocationCode) return MSG_IDS.invalidLocationCode;
    const msg = (error || '').toLowerCase();
    if (msg.includes('access code')) return MSG_IDS.invalidLocationCode;
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    if (msg.includes('playing right now')) return MSG_IDS.songPlaying;
    if (msg.includes('already up next')) return MSG_IDS.songNextUp;
    return MSG_IDS.failed;
  }

  // ======= Now-playing timer ({NOW_PLAYING_TIMER}) =======
  // Format remaining seconds as m:ss. Negative/NaN → 0:00 (timer expired).
  // null → --:-- (no song or duration unknown). Matches RF's display.
  function formatTimerText(remainingSec) {
    if (remainingSec === null || !isFinite(remainingSec)) return '--:--';
    const sec = Math.max(0, Math.floor(remainingSec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Update every <span data-showpilot-timer> on the page with the current
  // remaining-time text. Called from the 1-second interval AND once
  // immediately on each /api/state poll (in case the song changed and the
  // tick is up to a second away from firing). Idempotent.
  function paintTimer() {
    const els = document.querySelectorAll('[data-showpilot-timer]');
    if (!els.length) return; // template doesn't include the placeholder; skip
    let text;
    if (timerStartedAtMs === null || timerDurationSec === null) {
      text = '--:--';
    } else {
      const elapsedSec = (Date.now() - timerStartedAtMs) / 1000;
      text = formatTimerText(timerDurationSec - elapsedSec);
    }
    els.forEach(el => { if (el.textContent !== text) el.textContent = text; });
  }

  // Update the anchor values from a /api/state response (or bootstrap).
  // We accept ISO string + duration in seconds. When the song or its anchor
  // changes, we replace state and immediately re-paint so the user doesn't
  // see a stale value for up to a second. The 1-second interval is started
  // on first call and lives for the page lifetime — cheap and ensures we
  // don't miss updates if a /api/state poll is delayed.
  function updateTimerFromState(startedAtIso, durationSeconds) {
    const newStartMs = startedAtIso ? Date.parse(startedAtIso) : null;
    const newDurSec = (typeof durationSeconds === 'number' && isFinite(durationSeconds) && durationSeconds > 0)
      ? durationSeconds : null;
    // Only re-paint when something actually changed — avoids a textContent
    // write per /api/state poll for songs that haven't changed.
    if (newStartMs !== timerStartedAtMs || newDurSec !== timerDurationSec) {
      timerStartedAtMs = newStartMs && isFinite(newStartMs) ? newStartMs : null;
      timerDurationSec = newDurSec;
      paintTimer();
    }
    // Lazy-start the interval. Once running, it stays running for the
    // page lifetime — there's no benefit to stopping it (it does nothing
    // when there's no [data-showpilot-timer] on the page anyway).
    if (timerInterval === null && document.querySelector('[data-showpilot-timer]')) {
      timerInterval = setInterval(paintTimer, 1000);
    }
  }
  // Seed from bootstrap so the timer is correct before the first poll.
  // boot.nowPlayingStartedAtIso / nowPlayingDurationSeconds are set by
  // viewer-renderer.js when a song is currently playing.
  if (boot.nowPlayingStartedAtIso || boot.nowPlayingDurationSeconds) {
    updateTimerFromState(boot.nowPlayingStartedAtIso, boot.nowPlayingDurationSeconds);
  }

  // ======= GPS =======
  async function getLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Location not supported');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        () => reject(new Error('Location required but denied')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  // Force-fresh location fetch — used by the audio gate at the moment the
  // user taps the player button. Bypasses the browser's position cache
  // (maximumAge: 0) so we get the user's CURRENT physical location, not
  // a cached reading from when they were elsewhere. This is the copyright
  // safeguard: even if they granted permission earlier at home and drove
  // to the show, or vice versa, this re-evaluates from scratch.
  function getFreshLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location not supported on this device'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          cachedLocation = loc; // update cache for follow-up requests
          resolve(loc);
        },
        (err) => {
          // Translate browser error codes to friendly messages
          let msg = 'Location required to listen';
          if (err.code === 1) msg = 'Location permission denied. Audio is restricted to listeners present at the show.';
          else if (err.code === 2) msg = 'Could not determine your location.';
          else if (err.code === 3) msg = 'Location lookup timed out.';
          reject(new Error(msg));
        },
        // maximumAge: 0 forces a brand-new GPS reading every tap.
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // Best-effort location fetch. Used by interaction endpoints (vote/jukebox)
  // that already have their own location-required logic. NOT used by the
  // audio gate — that uses getFreshLocation() above for stricter checks.
  function tryGetLocationSilently() {
    if (cachedLocation || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      },
      () => { /* silently ignore */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  // ============================================================
  // Haversine distance — copy of the server's calculation so the player can
  // do client-side proximity checks without a round trip. Used by the
  // continuous watchPosition watcher started in startup() to react in
  // seconds when a listener walks/drives away from the show, instead of
  // waiting for the periodic server re-check to fire.
  //
  // Server is still authoritative — every audio-stream request goes through
  // the server-side gate too, and the periodic re-check stays as a fallback
  // for tampered clients and GPS outages. This is just a fast first line.
  // ============================================================
  function haversineMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8; // Earth radius in miles
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Build query string with viewer location for endpoints that need it
  function locationQuery() {
    if (!cachedLocation) return '';
    return `?lat=${encodeURIComponent(cachedLocation.lat)}&lng=${encodeURIComponent(cachedLocation.lng)}`;
  }

  async function buildBody(baseBody) {
    const body = { ...baseBody };
    if (boot.requiresLocation) {
      try {
        const loc = await getLocation();
        body.viewerLat = loc.lat;
        body.viewerLng = loc.lng;
      } catch (e) {
        showMessage(MSG_IDS.invalidLocation);
        throw e;
      }
    }
    // Location code (v0.33.24+): read from #locationCodeInput if present.
    // Always include when requiresLocationCode so the server can validate;
    // silently omit on installs where the feature is off.
    if (boot.requiresLocationCode) {
      const codeEl = document.getElementById('locationCodeInput');
      body.locationCode = codeEl ? codeEl.value.trim() : '';
    }
    return body;
  }

  // ======= API calls =======
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // Globals exposed to template onclick handlers
  window.ShowPilotVote = async function (sequenceName) {
    // If a tiebreak is in progress, route through the tiebreak path
    // instead. Voting for a candidate goes via /api/tiebreak-vote;
    // voting for a non-candidate is rejected with a clear message.
    if (tiebreakState) {
      const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
      if (candidateNames.includes(sequenceName)) {
        return window.ShowPilotTiebreakVote(sequenceName);
      } else {
        // Non-candidate vote during tiebreak. Show a clear message.
        // Falls back to alreadyVoted message id since most templates
        // have it, with text users will recognize as "voting blocked."
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
    }
    if (hasVoted) {
      // Vote shifting: if the admin allows changing votes, let the click
      // through so the server can swap. Otherwise the existing block.
      if (!allowVoteChange) {
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
      // No-op: user clicked the same song they already voted for. Don't
      // round-trip; just acknowledge silently. (We could show "still
      // voted!" but that risks looking buggy.)
      if (votedFor === sequenceName) {
        return;
      }
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      votedFor = sequenceName;
      // Vote-specific success message. showMessage falls back to the
      // generic #requestSuccessful element if #voteSuccessful isn't
      // defined in the active template (backward compat for RF imports).
      // On a successful shift, override the text so users understand
      // their vote moved rather than "you've already voted."
      if (result.data && result.data.shifted) {
        showMessage(MSG_IDS.voteSuccess, undefined, 'Vote changed! 🗳️');
      } else {
        showMessage(MSG_IDS.voteSuccess);
      }
      // (v0.32.11+) Refresh state immediately so the count cell updates
      // the moment the server acks the vote, regardless of socket health.
      // Without this, count updates rely entirely on the voteUpdate
      // socket event reaching the browser — which is fast on a healthy
      // connection but unreliable behind some proxies or when socket.io
      // can't establish (mixed-content, blocked WebSockets, etc.). The
      // 3-second poll loop catches it eventually but feels broken to a
      // user clicking and watching a counter that doesn't move. Mirrors
      // ShowPilotRequest's behavior, which has always done this.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  window.ShowPilotRequest = async function (sequenceName) {
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/jukebox/add', body);
    if (result.ok) {
      showMessage(MSG_IDS.success);
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  // ======= Public template API aliases =======
  // ShowPilot's canonical names are ShowPilotRequest / ShowPilotVote, but
  // we expose every alias a viewer template might call so that:
  //   1. Existing templates written for the old "OpenFalcon" name keep working
  //   2. Imported Remote Falcon templates work unmodified — RF's own JS
  //      exposed `RemoteFalconRequest` / `RemoteFalconVote` plus generic
  //      `request` / `vote`. We honor all of those.
  // Removing any alias would break user-facing templates with no warning,
  // so this list is append-only.
  window.OpenFalconRequest = window.ShowPilotRequest;
  window.OpenFalconVote = window.ShowPilotVote;
  window.RemoteFalconRequest = window.ShowPilotRequest;
  window.RemoteFalconVote = window.ShowPilotVote;
  window.vote = window.ShowPilotVote;
  window.request = window.ShowPilotRequest;

  // ======= Live state refresh =======
  async function refreshState() {
    try {
      const res = await fetch('/api/state', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      applyStateUpdate(data);
    } catch {}
  }

  function applyStateUpdate(data) {
    // --- Vote counts ---
    if (data.voteCounts) {
      // Two attributes carry the count per row: [data-seq-count] on the
      // canonical-RF .cell-vote element, and [data-seq-votes] on the
      // RF Page Builder .sequence-votes span. Templates may style either
      // (or both), so live updates must hit both.
      // First clear all existing counts to 0 so a removed vote drops visibly
      const allCells = document.querySelectorAll('[data-seq-count], [data-seq-votes]');
      allCells.forEach(el => {
        el.textContent = '0';
      });
      // Build a name → cell map by reading the actual attribute values
      // back from the DOM. This avoids the CSS attribute-selector pitfall
      // where names with quotes, brackets, or other special chars don't
      // match — getAttribute returns the un-escaped value, so a direct
      // string compare always works regardless of how the attribute was
      // serialized in the HTML.

      // (array map, updates all matching elements). This is to fix a bug
      // where votes for songs are rendered on the first instance of the
      // voting div for a song only. There are 2 instances of those divs
      // (one for jukebox mode, one for voting mode) and the counts only
      // update on the first one. By building a map of all cells by name,
      // we can update all of them correctly.
      const cellsByName = {};
      allCells.forEach(el => {
          const n = el.getAttribute('data-seq-count') || el.getAttribute('data-seq-votes');
          if (n) {
              if (!cellsByName[n]) cellsByName[n] = [];
              cellsByName[n].push(el);
          }
      });
      data.voteCounts.forEach(v => {
          const els = cellsByName[v.sequence_name];
          if (els) els.forEach(el => { el.textContent = String(v.count); });
      });
    }

    // --- Reset "already voted" gate when the round id changes ---
    // Round-id check is the backup for voteReset socket events which
    // mobile devices can miss when backgrounded. If the server has
    // moved past our recorded round, our local "already voted" flag
    // is stale and must clear.
    // --- Allow-vote-change feature flag (v0.32.6+) ---
    // Refresh the local copy on every state poll so admin toggling the
    // setting mid-show propagates without a viewer reload.
    if (typeof data.allowVoteChange === 'boolean') {
      allowVoteChange = data.allowVoteChange;
    }

    // --- Location code flag (v0.33.24+) ---
    if (typeof data.requiresLocationCode === 'boolean') {
      boot.requiresLocationCode = data.requiresLocationCode;
    }

    // --- Show name → document title (v0.33.6+) ---
    // Admin renaming the show in settings updates every viewer's tab
    // title within a poll. We only overwrite document.title if it
    // currently matches the previously-seen show name — that way a
    // template that hard-coded its own <title> (which the server-side
    // renderer respects) keeps it.
    if (data.showName) {
      if (lastKnownShowName === null) {
        lastKnownShowName = data.showName;
      } else if (data.showName !== lastKnownShowName) {
        if (document.title === lastKnownShowName) {
          document.title = data.showName;
        }
        lastKnownShowName = data.showName;
      }
    }

    // --- Now-playing timer (v0.32.9+) ---
    // The server sends started_at + duration on every state poll. Pass
    // both (even if null — that's how we know to render --:--).
    updateTimerFromState(data.nowPlayingStartedAtIso || null, data.nowPlayingDurationSeconds || null);

    if (typeof data.currentVotingRound === 'number') {
      if (lastKnownRoundId !== null && data.currentVotingRound !== lastKnownRoundId) {
        // Round advanced. Clear local vote state regardless of whether
        // the new round has zero votes yet (someone else may have
        // already voted before this client polled).
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
      }
      lastKnownRoundId = data.currentVotingRound;
    }
    // Legacy fallback: if we have no round id (older server) but vote
    // counts came back empty, the round was reset. Same effect.
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
      votedFor = null;
    }

    // --- Tiebreak state (v0.24.0+) ---
    // If the server reports a tiebreak in progress and we don't already
    // have one displayed, render the UI now. This handles page-reload
    // mid-tiebreak — the socket event already fired before we connected,
    // so we rely on /api/state to surface the active tiebreak. If the
    // server says no tiebreak but we have one displayed (race or dump),
    // clean up.
    if (data.tiebreak && data.tiebreak.candidates && data.tiebreak.candidates.length >= 2) {
      if (!tiebreakState) {
        // Compute deadline. Server sends ISO timestamp for the absolute
        // deadline (capped at song-end on the server side). Append 'Z'
        // since SQLite stores UTC without the marker.
        const deadlineMs = data.tiebreak.deadlineAtIso
          ? new Date(data.tiebreak.deadlineAtIso + 'Z').getTime()
          : Date.now() + 60000;
        // Look up display info for each candidate from the sequences list
        const seqByName = {};
        (data.sequences || []).forEach(s => { seqByName[s.name] = s; });
        const candidates = data.tiebreak.candidates.map(name => {
          const seq = seqByName[name] || {};
          return {
            sequenceName: name,
            displayName: seq.display_name || name,
            artist: seq.artist || '',
            imageUrl: seq.image_url || '',
          };
        });
        showTiebreakUI({
          candidates,
          deadlineAtMs: deadlineMs,
        });
      }
    } else if (tiebreakState) {
      // Server says no tiebreak but we have one. Clean up.
      clearTiebreakUI();
    }

    // --- NOW_PLAYING text ---
    const nowEl = document.querySelector('.now-playing-text');
    if (nowEl) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      if (nowEl.textContent !== nowDisplay) nowEl.textContent = nowDisplay;
    }

    // --- NOW_PLAYING_IMAGE (v0.32.13+) ---
    // Updates any <img data-showpilot-now-img> elements when the playing
    // song changes. Hides the image when no song is playing, or when the
    // current song has no cover art (image_url empty / null on the
    // sequence row).
    const nowImgEls = document.querySelectorAll('[data-showpilot-now-img]');
    if (nowImgEls.length) {
      const nowSeq = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)
        : null;
      const nowImgUrl = nowSeq && nowSeq.image_url ? nowSeq.image_url : '';
      nowImgEls.forEach(el => {
        if (nowImgUrl) {
          if (el.getAttribute('src') !== nowImgUrl) el.setAttribute('src', nowImgUrl);
          if (el.style.display === 'none') el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    }

    // --- NEXT_PLAYLIST text (RF templates use .body_text inside the jukebox container) ---
    // We can't reliably pick "the right" .body_text element without a data attribute,
    // so we tag it during render-time. Fall back: leave it alone.
    // In templates we render server-side, we add data-showpilot-next to the NEXT_PLAYLIST spot.
    // The data-openfalcon-* selectors are kept for backward compat with templates
    // written against the old name.
    const nextEl = document.querySelector('[data-showpilot-next], [data-openfalcon-next]');
    if (nextEl) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      if (nextEl.textContent !== nextDisplay) nextEl.textContent = nextDisplay;
    }

    // --- Queue size & queue list ---
    const queueSizeEl = document.querySelector('[data-showpilot-queue-size], [data-openfalcon-queue-size]');
    if (queueSizeEl) queueSizeEl.textContent = String((data.queue || []).length);

    const queueListEl = document.querySelector('[data-showpilot-queue-list], [data-openfalcon-queue-list]');
    if (queueListEl) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      if ((data.queue || []).length === 0) {
        // Match the server-side renderQueue empty-state shape (v0.32.13+).
        queueListEl.innerHTML = '<div class="queue-empty">Queue is empty.</div>';
      } else {
        // Match the server-side renderQueue shape: each entry is its own
        // <div class="queue-item"> so RF Page Builder's `.queue-list > div`
        // selector matches.
        queueListEl.innerHTML = data.queue.map(e => {
          const seq = byName[e.sequence_name];
          const name = seq ? seq.display_name : e.sequence_name;
          return `<div class="queue-item" data-seq="${escapeAttr(e.sequence_name)}">${escapeHtml(name)}</div>`;
        }).join('');
      }
    }

    // --- Sequence list live rebuild (v0.33.6+) ---
    // When admin adds/removes/reorders/renames sequences (or edits
    // display_name / artist / image_url), the viewer's clickable grid is
    // stale until refresh. We mirror renderPlaylistGrid from
    // lib/viewer-renderer.js client-side and rebuild the affected
    // wrapper's innerHTML when the data signature changes.
    //
    // We find the wrapper by walking up from any [data-seq] element.
    // Templates have at most two wrappers (one in the jukebox container,
    // one in the voting container, if they support both modes). If the
    // server-rendered list was empty at page load, there are no [data-seq]
    // anchors and we can't find the wrapper — viewers in that narrow case
    // need a refresh to see newly-added sequences. Documented as known.
    rebuildPlaylistGridIfNeeded(data);

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated. After rebuildPlaylistGridIfNeeded this is
    // typically a no-op (the rebuild used the new url) — kept as a lighter-weight
    // path for the "only the cover changed" case where rebuild was skipped.
    (data.sequences || []).forEach(seq => {
      if (!seq.image_url) return;
      const imgs = document.querySelectorAll(`img[data-seq-name="${CSS.escape(seq.name)}"]`);
      imgs.forEach(img => {
        if (img.getAttribute('src') !== seq.image_url) {
          img.setAttribute('src', seq.image_url);
        }
      });
    });

    // --- Mode container visibility ---
    // Both data-showpilot-container and data-openfalcon-container are honored
    // so templates from earlier versions keep working. We toggle via the
    // HTML5 `hidden` attribute (matching the server-side renderer in
    // v0.33.8+), AND clear any inline `display:none` left by older
    // server renders (in case the user is running a viewer page that
    // was loaded before a server upgrade). Idempotent on repeat calls.
    function setVisible(el, visible) {
      if (visible) {
        el.removeAttribute('hidden');
        // If a previous render set inline display:none, clear it. Don't
        // touch any non-display inline styles the template author may
        // have placed (margin, etc.) — only flip display.
        if (el.style && el.style.display === 'none') el.style.display = '';
      } else {
        el.setAttribute('hidden', '');
        // Belt-and-braces: also set inline display:none for older
        // viewer-side code paths that may have read it directly.
        if (el.style) el.style.display = 'none';
      }
    }
    document.querySelectorAll('[data-showpilot-container="jukebox"], [data-openfalcon-container="jukebox"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'JUKEBOX');
    });
    document.querySelectorAll('[data-showpilot-container="voting"], [data-openfalcon-container="voting"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'VOTING');
    });
    // After-hours: visible when viewer control is OFF. Mirror of the server-side
    // logic in viewer-renderer.js, so flipping the admin "Off" toggle propagates
    // to viewers within one poll without requiring a reload.
    document.querySelectorAll('[data-showpilot-container="afterhours"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'OFF');
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Heartbeat (for active viewer count)
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  }, 15000);

  // Poll state every 3s for live updates (Socket.io provides instant updates too)
  setInterval(refreshState, 3000);

  // ============================================================
  // Tiebreak UI (v0.24.0+)
  // ============================================================
  // Renders a sticky banner at the top of the page when a tiebreak is
  // active, plus visual emphasis on the tied candidates within the
  // existing voting list. The banner shows a countdown timer and
  // lists the tied songs as tap targets — tapping casts a tiebreak
  // vote via /api/tiebreak-vote (rather than the regular /api/vote).
  //
  // Design intent: the existing voting list stays intact so users can
  // see the score progression. We just overlay an urgent banner and
  // mark the candidates with a visible badge so users know which two
  // are eligible for the tiebreak vote.
  function showTiebreakUI(data) {
    if (!data || !Array.isArray(data.candidates) || data.candidates.length < 2) return;
    // The deadline is a wall-clock moment, computed server-side as
    // min(timer-cap, current-song-end). The viewer countdown is just
    // (deadline - now) capped at 0 — no need to know the configured
    // timer duration, just the absolute end moment.
    const deadlineMs = data.deadlineAtMs || (data.startedAtMs && data.durationSec
      ? data.startedAtMs + data.durationSec * 1000
      : Date.now() + 60000);
    tiebreakState = {
      candidates: data.candidates,
      deadlineMs,
    };
    hasTiebreakVoted = false;
    renderTiebreakBanner();
    markTiebreakCandidatesInList();
    startTiebreakCountdown();
  }

  function clearTiebreakUI() {
    tiebreakState = null;
    if (tiebreakCountdownTimer) {
      clearInterval(tiebreakCountdownTimer);
      tiebreakCountdownTimer = null;
    }
    const banner = document.getElementById('showpilot-tiebreak-banner');
    if (banner) banner.remove();
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      el.classList.remove('showpilot-tiebreak-candidate');
      const badge = el.querySelector('.showpilot-tie-badge');
      if (badge) badge.remove();
    });
  }

  function renderTiebreakBanner() {
    let banner = document.getElementById('showpilot-tiebreak-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'showpilot-tiebreak-banner';
      // Inline styles — keeps the banner self-contained even if a
      // template's CSS doesn't include rules for it. Templates can
      // restyle by setting CSS variables (--showpilot-tiebreak-bg etc.)
      // or by overriding #showpilot-tiebreak-banner directly.
      banner.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 9997',
        'padding: 14px 18px',
        'background: var(--showpilot-tiebreak-bg, linear-gradient(135deg, #d63031, #6c0e0e))',
        'color: var(--showpilot-tiebreak-text, #fff)',
        'font-family: var(--showpilot-toast-font, system-ui, -apple-system, sans-serif)',
        'box-shadow: 0 6px 18px rgba(0,0,0,0.5)',
        'animation: showpilot-tb-shake 0.7s cubic-bezier(.36,.07,.19,.97) both',
        'animation-iteration-count: 2',
      ].join(';');
      document.body.appendChild(banner);
      // Add keyframes once
      if (!document.getElementById('showpilot-tb-keyframes')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'showpilot-tb-keyframes';
        styleEl.textContent = `
          @keyframes showpilot-tb-shake {
            10%, 90% { transform: translate3d(-1px, 0, 0); }
            20%, 80% { transform: translate3d(2px, 0, 0); }
            30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
            40%, 60% { transform: translate3d(3px, 0, 0); }
          }
          @keyframes showpilot-tb-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.7); }
            50% { box-shadow: 0 0 0 10px rgba(255, 80, 80, 0); }
          }
          .showpilot-tiebreak-candidate {
            outline: 3px solid var(--showpilot-tiebreak-accent, #ff5050) !important;
            outline-offset: -3px;
            animation: showpilot-tb-pulse 1.5s infinite;
          }
          .showpilot-tie-badge {
            display: inline-block;
            background: var(--showpilot-tiebreak-bg, #d63031);
            color: var(--showpilot-tiebreak-text, #fff);
            font-size: 0.7rem;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 999px;
            margin-left: 8px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            vertical-align: middle;
          }
          #showpilot-tiebreak-banner button {
            background: rgba(255,255,255,0.18);
            border: 1px solid rgba(255,255,255,0.4);
            color: inherit;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: 600;
            padding: 8px 14px;
            margin: 4px;
            border-radius: 8px;
            cursor: pointer;
          }
          #showpilot-tiebreak-banner button:hover {
            background: rgba(255,255,255,0.3);
          }
          #showpilot-tiebreak-banner button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `;
        document.head.appendChild(styleEl);
      }
    }
    if (!tiebreakState) return;
    const candList = tiebreakState.candidates.map(c => `
      <button data-tb-candidate="${escapeAttr(c.sequenceName)}" onclick="window.ShowPilotTiebreakVote('${escapeJsString(c.sequenceName)}')">
        ${escapeHtml(c.displayName || c.sequenceName)}
      </button>
    `).join('');
    banner.innerHTML = `
      <div style="text-align:center;">
        <div style="font-weight:800;font-size:1.05rem;letter-spacing:0.05em;text-transform:uppercase;">
          ⚡ Tiebreak — Vote Now ⚡
        </div>
        <div style="font-size:0.85rem;opacity:0.9;margin-top:4px;">
          Vote within <span id="showpilot-tb-countdown">--</span>s or all votes are dumped.
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;justify-content:center;">
          ${candList}
        </div>
      </div>
    `;
  }

  function markTiebreakCandidatesInList() {
    if (!tiebreakState) return;
    const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      const seqName = el.getAttribute('data-seq');
      if (seqName && candidateNames.includes(seqName)) {
        el.classList.add('showpilot-tiebreak-candidate');
        if (!el.querySelector('.showpilot-tie-badge')) {
          const badge = document.createElement('span');
          badge.className = 'showpilot-tie-badge';
          badge.textContent = 'TIE';
          el.appendChild(badge);
        }
      }
    });
  }

  function startTiebreakCountdown() {
    if (tiebreakCountdownTimer) clearInterval(tiebreakCountdownTimer);
    const tick = () => {
      if (!tiebreakState) return;
      const remaining = Math.max(0, Math.ceil((tiebreakState.deadlineMs - Date.now()) / 1000));
      const cdEl = document.getElementById('showpilot-tb-countdown');
      if (cdEl) cdEl.textContent = String(remaining);
      if (remaining <= 0) {
        // Visual feedback that timer is up. Server will emit tiebreakFailed
        // (or we'll get a state update with no tiebreak active) shortly,
        // and that will clean us up.
        if (cdEl) cdEl.textContent = 'time up';
      }
    };
    tick();
    tiebreakCountdownTimer = setInterval(tick, 250);
  }

  function showTiebreakFailedToast(data) {
    // Use the existing winner-toast infrastructure with different content.
    // We don't have the renderer's showWinnerToast helper exposed to us,
    // so just log and rely on the "votes dumped" implication being clear
    // when the tiebreak banner disappears. Templates can listen for the
    // socket event themselves if they want a custom failure UI.
    console.info('[ShowPilot] tiebreak expired — votes dumped:', data);
  }

  // Vote click during tiebreak — routes to the tiebreak endpoint instead
  // of the main vote endpoint. Exposed globally so the banner buttons can
  // call it directly. Returns nothing; uses showMessage for feedback.
  window.ShowPilotTiebreakVote = async function(sequenceName) {
    if (hasTiebreakVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }
    const result = await postJson('/api/tiebreak-vote', body);
    if (result.ok) {
      hasTiebreakVoted = true;
      showMessage(MSG_IDS.voteSuccess);
      // (v0.32.11+) Same reasoning as ShowPilotVote — refresh immediately
      // so the user sees their tiebreak vote register without waiting on
      // the tiebreakVoteUpdate socket event.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data), undefined, undefined, result.data?.error);
    }
  };

  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }
  function escapeJsString(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  }

  // ============================================================
  // Playlist grid live rebuild (v0.33.6+)
  // ============================================================
  // Mirrors lib/viewer-renderer.js#renderPlaylistGrid so the viewer's
  // clickable list updates without a refresh when admin edits the
  // sequence list. Called from applyStateUpdate on every state poll.
  //
  // We find playlist wrappers by walking up from any [data-seq]
  // element. The wrapper is the parent that holds rows. Templates may
  // have one (single-mode template) or two (dual-mode template, one
  // wrapper per mode-container). We rebuild each wrapper independently
  // and only when its computed signature differs from the data — so
  // unchanged wrappers don't churn the DOM and unrelated event handlers
  // / hover state survive.
  //
  // The empty-initial-load edge case: if the page was rendered with
  // zero sequences, there are no [data-seq] anchors to find a wrapper
  // by, and a subsequent admin sequence-add won't appear until the
  // viewer refreshes. Acceptable trade-off — alternative would be
  // emitting a sentinel element on every {PLAYLISTS} substitution,
  // which risks breaking template CSS that targets direct-child
  // siblings (.voting_table grid-template-columns, etc.).

  // Stable signature of the desired grid contents — name, display_name,
  // artist, and image_url. Order matters (admin-controlled ordering is
  // meaningful). Mode is included so a JUKEBOX→VOTING flip forces a
  // rebuild. Vote counts are intentionally excluded: they're managed by
  // the direct DOM update in applyStateUpdate and don't need a full
  // innerHTML rebuild on every vote change.
  function computeGridSignature(sequences, mode) {
    const parts = [mode];
    for (const s of sequences) {
      parts.push(
        s.name + '|' +
        (s.display_name || '') + '|' +
        (s.artist || '') + '|' +
        (s.image_url || '')
        // vote counts excluded — managed by the direct DOM update in applyStateUpdate
      );
    }
    return parts.join('\n');
  }

  // Mirror of the server's renderPlaylistGrid — must produce IDENTICAL
  // markup so click handlers and template CSS keep working. If you
  // change one side, change the other. (Tested by comparing rendered
  // HTML in /tmp/test-playlist-rebuild.js.)
  //
  // Note: we use escapeHtml (not escapeAttr) for data-seq and
  // data-seq-name values because that's what the server-side renderer
  // does — escapeAttr doesn't escape ' or > and would produce
  // divergent markup for sequences with those chars in their names.
  function renderRowsForMode(sequences, voteCountsByName, mode) {
    return sequences.map(seq => {
      const safeNameJs = escapeJsString(seq.name);
      const safeNameAttr = escapeHtml(seq.name);
      const safeDisplay = escapeHtml(seq.display_name || seq.name);
      const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
      const count = voteCountsByName[seq.name] || 0;
      // width/height are presentational hints — author CSS overrides them.
      // See lib/viewer-renderer.js renderPlaylistGrid for the full rationale.
      // Mirror the server-side defaults here so live rebuilds (mode flip,
      // sequence list change) don't reintroduce native-resolution images.
      const artImg = seq.image_url
        ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(seq.image_url)}" alt="" width="40" height="40" loading="lazy" />`
        : '';
      if (mode === 'VOTING') {
        return `<div class="cell-vote-playlist sequence-item" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="cell-vote-playlist-artist sequence-artist">${safeArtist}</div><span class="sequence-votes" data-seq-votes="${safeNameAttr}">${count}</span></div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
      } else {
        return `<div class="jukebox-list sequence-item" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="jukebox-list-artist sequence-artist">${safeArtist}</div><span class="sequence-requests" data-seq-requests="${safeNameAttr}"></span></div></div>`;
      }
    }).join('');
  }

  // Find the unique playlist wrapper(s) by walking up from existing rows.
  // Returns 0, 1, or 2 elements depending on template shape.
  function findPlaylistWrappers() {
    const wrappers = new Set();
    document.querySelectorAll('[data-seq]').forEach(el => {
      // Skip queue items and tiebreak candidate buttons — they also use
      // data-seq but live in different parents. Identify them by class.
      if (el.classList.contains('queue-item')) return;
      if (el.hasAttribute('data-tb-candidate')) return;
      if (el.parentElement) wrappers.add(el.parentElement);
    });
    return Array.from(wrappers);
  }

  // Per-wrapper signature cache so we only rebuild on actual change.
  // WeakMap so detached wrappers GC normally.
  const _gridSigCache = new WeakMap();

  function rebuildPlaylistGridIfNeeded(data) {
    const sequences = data.sequences || [];
    const mode = data.viewerControlMode || 'OFF';
    // Only meaningful in JUKEBOX or VOTING; in OFF the mode containers
    // are hidden, so rebuilding their stale contents wastes work but
    // doesn't hurt. Skip to keep churn low.
    if (mode !== 'JUKEBOX' && mode !== 'VOTING') return;

    const voteCountsByName = {};
    (data.voteCounts || []).forEach(v => { voteCountsByName[v.sequence_name] = v.count; });
    const desiredSig = computeGridSignature(sequences, mode);

    const wrappers = findPlaylistWrappers();
    if (wrappers.length === 0) return; // Empty-initial-load edge case.

    for (const wrapper of wrappers) {
      // Determine which mode this wrapper belongs to. Walk up to the
      // nearest [data-showpilot-container] ancestor and read its mode.
      // If no container ancestor (single-mode template with no mode
      // container), assume the active mode.
      let targetMode = mode;
      let cur = wrapper;
      while (cur && cur !== document.body) {
        const c = cur.getAttribute && cur.getAttribute('data-showpilot-container');
        if (c === 'jukebox') { targetMode = 'JUKEBOX'; break; }
        if (c === 'voting') { targetMode = 'VOTING'; break; }
        cur = cur.parentElement;
      }
      // Only rebuild a wrapper whose mode matches the active mode —
      // the inactive one is hidden anyway and won't be seen.
      if (targetMode !== mode) continue;

      const wrapperSig = _gridSigCache.get(wrapper);
      if (wrapperSig === desiredSig) continue;

      wrapper.innerHTML = renderRowsForMode(sequences, voteCountsByName, targetMode);
      _gridSigCache.set(wrapper, desiredSig);
    }
  }

  // Initial heartbeat + immediate state refresh
  fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  refreshState();

  // Try Socket.io if available for instant updates
  try {
    if (window.io) {
      const socket = window.io();
      socket.on('voteUpdate', () => refreshState());
      socket.on('queueUpdated', () => refreshState());
      socket.on('nowPlaying', () => refreshState());
      socket.on('voteReset', () => {
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
        // Clear any tiebreak banner that's still on screen — round
        // moved on (either resolution succeeded or timer expired).
        clearTiebreakUI();
        refreshState();
      });
      socket.on('sequencesReordered', () => refreshState());
      socket.on('sequencesSynced', () => refreshState());
      // Mode toggle (admin flipping JUKEBOX / VOTING / OFF) — fires
      // server-side in routes/plugin.js. Without this, viewers wait up
      // to 3s for the next poll to see the after-hours block appear or
      // the active grid swap. With it, propagation is instant.
      socket.on('viewerModeChanged', () => refreshState());
      // ---- Tiebreak events (v0.24.0+) ----
      socket.on('tiebreakStarted', (data) => {
        showTiebreakUI(data);
      });
      socket.on('tiebreakFailed', (data) => {
        showTiebreakFailedToast(data);
        clearTiebreakUI();
      });
      socket.on('tiebreakVoteUpdate', () => refreshState());
      // On reconnect (after network blip or mobile background-suspend),
      // resync state immediately. Otherwise we'd keep showing whatever
      // round we had before disconnect, including a stale "already
      // voted" gate. Socket.io fires 'connect' both on initial connect
      // and on each reconnect, so this covers both.
      socket.on('connect', () => refreshState());
    }
  } catch {}

  // Mobile devices commonly suspend background tabs aggressively. When
  // the user comes back to the page (visibilitychange to 'visible'),
  // pull a fresh state so we don't continue working from stale data.
  // Pairs with the socket reconnect handler above — covers the case
  // where the socket reconnected silently in the background but the
  // tab missed events while suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
    }
  });

  // ============================================================
  // LISTEN ON PHONE — Web Audio API player with sample-precise sync
  //
  // Sync strategy (timestamp-anchored, NTP-style):
  //   1. Server provides trackStartedAtMs (epoch ms when current track began on FPP)
  //      AND serverNowMs in same response — client computes clock offset
  //   2. Client decodes full audio file into AudioBuffer (~5MB per song, fine in RAM)
  //   3. Schedules playback at exact moment via AudioContext.start(when, offset):
  //        offset = (clientNow + clockOffset - trackStartedAtMs) / 1000
  //        when   = audioCtx.currentTime + 0.05  (small lead-in to be safe)
  //   4. Pre-fetches next song's AudioBuffer while current plays — zero gap
  //   5. Re-syncs once per second with cheap REST poll (no per-second WebSocket needed)
  //
  // This matches PulseMesh-quality sync without C++ or Node.
  //
  // Player UI is sticky bottom-of-page when open. "Hide" minimizes to a small
  // status pill while audio keeps playing.
  // ============================================================
  // ============================================================
  // ============================================================
  // PAGE EFFECTS — full-screen ambient overlays (snow, leaves,
  // fireworks, hearts, stars, bats, confetti, petals, embers,
  // bubbles, rain — plus 'none').
  //
  // Three knobs from the server:
  //   pageEffect          — string id (see EFFECTS table below)
  //   pageEffectColor     — '' for the effect's default, or any CSS color
  //   pageEffectIntensity — 'subtle' | 'medium' | 'heavy'
  //
  // Engine contract: each effect declares { name, defaultColor, build }.
  // build(layer, color, count) populates `layer` with absolutely-positioned
  // children using whatever animations the effect needs. The engine
  // handles the layer container, lifecycle (start/stop/swap), and
  // prefers-reduced-motion respect. Effects don't need to clean up — when
  // we swap, we drop the whole layer and rebuild.
  //
  // Backward compat: bootstrap.pageSnowEnabled is mapped to pageEffect='snow'
  // by the server, so old templates that hardcoded that name keep working.
  //
  // pointer-events:none on the layer so it never blocks clicks. z-index
  // sits above page background but below the player bar.
  // ============================================================
  // ============================================================
  // Long-name truncation guard (v0.32.14+)
  // ============================================================
  // Some imported third-party templates (e.g. RF Page Builder)
  // style `.sequence-name` with `white-space: nowrap; overflow: hidden;
  // text-overflow: ellipsis;`. That assumes one-line song titles. Real
  // shows have titles like "Walk the Dinosaur (From Ice Age: Dawn of
  // the Dinosaurs)" which then truncate to "Walk the Din…". The
  // template author can't anticipate every show's catalog, and asking
  // every operator to learn CSS to fix it is a non-starter.
  //
  // Strategy: inject a low-specificity defensive rule that allows
  // wrapping AND caps at 2 lines. We scope it to .sequence-name inside
  // .sequence-item — that's RF Page Builder territory. Built-in
  // ShowPilot templates and canonical RF templates never style
  // .sequence-name (they target .jukebox-list / .cell-vote-playlist
  // descendants), so this override is invisible to them.
  //
  // We use !important so RFPB's existing rules don't beat us. The
  // 2-line clamp uses both the modern `line-clamp` and the legacy
  // `-webkit-line-clamp` for browser coverage; modern browsers honor
  // both. The min-width:0 guard prevents flex children from refusing
  // to shrink and overflowing their card.
  // ============================================================
  (function initSequenceNameWrap() {
    if (document.getElementById('of-seqname-wrap-style')) return; // idempotent
    const style = document.createElement('style');
    style.id = 'of-seqname-wrap-style';
    style.textContent = `
      .sequence-item .sequence-name {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
      .sequence-item .sequence-artist {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 1 !important;
        line-clamp: 1 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
    `;
    // Append to <head> so it lands before the template's late <style>
    // blocks at the end of <body>. CSS source order is what determines
    // which rule wins among tied specificity, so position matters; but
    // we also use !important to win across the board against templates
    // that put nowrap rules in the body's late <style>.
    (document.head || document.documentElement).appendChild(style);
  })();

  // ============================================================
  // Page effects engine — snow / leaves / etc.
  (function initPageEffects() {
    const prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return; // respect OS-level motion preference always

    let layer = null;
    let styleEl = null;
    // Track last-applied state to avoid pointless rebuilds. The poll runs
    // every 5s; if nothing changed we skip the DOM churn (and the visual
    // restart of the animations).
    let last = { name: null, color: null, intensity: null };

    // ============================================================
    // KEYFRAMES — emitted once, shared across all effects. We don't
    // namespace per-effect because most fall/drift effects share the
    // same fall + sway pattern; keeping it DRY makes the file shorter.
    // ============================================================
    function ensureStyle() {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.textContent = `
        @keyframes ofPageFall {
          0%   { transform: translateY(-30px) rotate(0deg); }
          100% { transform: translateY(108vh) rotate(360deg); }
        }
        @keyframes ofPageDrift {
          0%   { transform: translateY(-30px) rotate(-25deg); }
          100% { transform: translateY(108vh) rotate(335deg); }
        }
        @keyframes ofPageSway {
          0%   { margin-left: 0; }
          100% { margin-left: var(--of-sway, 30px); }
        }
        @keyframes ofPageRise {
          0%   { transform: translateY(110vh) rotate(0deg); opacity: 0; }
          10%  { opacity: var(--of-peak-opacity, 0.8); }
          90%  { opacity: var(--of-peak-opacity, 0.8); }
          100% { transform: translateY(-30px) rotate(360deg); opacity: 0; }
        }
        @keyframes ofPageTwinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        @keyframes ofPageBatFly {
          0%   { transform: translateX(-12vw) translateY(0); }
          100% { transform: translateX(112vw) translateY(var(--of-bat-dy, 8vh)); }
        }
        @keyframes ofPageBatFlap {
          0%, 100% { transform: scaleY(1); }
          50%      { transform: scaleY(0.55); }
        }
        @keyframes ofPageRain {
          0%   { transform: translateY(-30vh); }
          100% { transform: translateY(108vh); }
        }
        @keyframes ofPageBurst {
          0%   { transform: scale(0); opacity: 0; }
          10%  { opacity: 1; }
          70%  { opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `;
      document.head.appendChild(styleEl);
    }

    // ============================================================
    // INTENSITY MAPS — per-effect particle counts.
    // Heavier effects (fireworks, bats) ship fewer at "heavy" than
    // small confetti would, because each is bigger / more visually loud.
    // ============================================================
    const COUNTS = {
      // [subtle, medium, heavy]
      snow:      [25, 50, 90],
      leaves:    [15, 30, 55],
      fireworks: [3,  6,  12],
      hearts:    [20, 40, 70],
      stars:     [30, 60, 110],
      bats:      [3,  6,  10],
      confetti:  [40, 80, 140],
      petals:    [20, 40, 70],
      embers:    [25, 50, 90],
      bubbles:   [15, 30, 55],
      rain:      [60, 120, 200],
    };
    function pickCount(name, intensity) {
      const arr = COUNTS[name];
      if (!arr) return 0;
      const idx = intensity === 'subtle' ? 0 : intensity === 'heavy' ? 2 : 1;
      return arr[idx];
    }

    // ============================================================
    // EFFECT DEFINITIONS — each is { defaultColor, build(layer, color, count) }.
    // `color` is always a non-empty string here (the engine substitutes
    // defaultColor when the admin left the override blank).
    //
    // Each effect creates absolutely-positioned children inside `layer`.
    // Random number tweaks aim for "feels alive" not "looks identical".
    // ============================================================
    const EFFECTS = {
      // ---------- SNOW ----------
      snow: {
        defaultColor: '#ffffff',
        build(root, color, count) {
          const flakeSvg = (col) => `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><g stroke="${col}" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.9"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/><line x1="2.5" y1="11.5" x2="11.5" y2="2.5"/><path d="M 7,2 L 6,3 M 7,2 L 8,3"/><path d="M 7,12 L 6,11 M 7,12 L 8,11"/><path d="M 2,7 L 3,6 M 2,7 L 3,8"/><path d="M 12,7 L 11,6 M 12,7 L 11,8"/></g></svg>`;
          const svgMarkup = flakeSvg(color);
          for (let i = 0; i < count; i++) {
            const flake = document.createElement('div');
            const size = 8 + Math.random() * 14;
            const left = Math.random() * 100;
            const duration = 8 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.4 + Math.random() * 0.5;
            flake.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:drop-shadow(0 0 2px ${color}66);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            flake.innerHTML = svgMarkup;
            root.appendChild(flake);
          }
        },
      },

      // ---------- LEAVES ---------- (autumn maple-like silhouettes)
      leaves: {
        defaultColor: '#d2691e',
        build(root, color, count) {
          // Random palette around the chosen color so leaves look varied.
          // We render one default svg shape and tint it via CSS filter for
          // the "varied colors" feel without bloating the markup.
          const leafSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 C8 4, 4 8, 4 13 C4 18, 8 22, 12 22 C16 22, 20 18, 20 13 C20 8, 16 4, 12 2 Z M12 4 L12 22" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          for (let i = 0; i < count; i++) {
            const leaf = document.createElement('div');
            const size = 16 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 12;
            const delay = -Math.random() * duration;
            const sway = 60 + Math.random() * 80;
            const opacity = 0.55 + Math.random() * 0.4;
            // Vary the hue a little: ±20deg rotation gives autumnal range
            const hueShift = Math.round(-20 + Math.random() * 40);
            leaf.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:hue-rotate(${hueShift}deg) drop-shadow(0 1px 2px rgba(0,0,0,0.3));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            leaf.innerHTML = leafSvg(color);
            root.appendChild(leaf);
          }
        },
      },

      // ---------- FIREWORKS ---------- (radial bursts at random positions)
      fireworks: {
        defaultColor: '#ff5050',
        build(root, color, count) {
          // Each "firework" is a burst of N small dots radiating from a center.
          // We stagger their delays so the sky doesn't fire all at once.
          const sparksPerBurst = 14;
          for (let i = 0; i < count; i++) {
            const burst = document.createElement('div');
            const cx = 10 + Math.random() * 80; // vw
            const cy = 8 + Math.random() * 50;  // vh — keep above the fold mostly
            const burstDuration = 1.6 + Math.random() * 1.2;
            const cycle = 4 + Math.random() * 5;
            const cycleDelay = Math.random() * cycle;
            // Vary color slightly via hue-rotate on each spark's filter
            const baseHue = Math.round(Math.random() * 360);
            burst.style.cssText = `position:absolute;left:${cx}vw;top:${cy}vh;width:0;height:0;`;
            for (let s = 0; s < sparksPerBurst; s++) {
              const angle = (s / sparksPerBurst) * Math.PI * 2;
              const dist = 60 + Math.random() * 50;
              const dx = Math.cos(angle) * dist;
              const dy = Math.sin(angle) * dist;
              const spark = document.createElement('div');
              spark.style.cssText = `position:absolute;left:0;top:0;width:6px;height:6px;border-radius:50%;background:${color};filter:hue-rotate(${baseHue}deg) drop-shadow(0 0 6px ${color});transform-origin:0 0;animation:sparkFly_${i}_${s} ${cycle}s ease-out infinite;animation-delay:${cycleDelay}s;`;
              const styleId = `ofSpark_${i}_${s}`;
              const style = document.createElement('style');
              style.textContent = `@keyframes sparkFly_${i}_${s} { 0%,${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(0,0); opacity: 1; } ${(burstDuration/cycle*100*0.6).toFixed(0)}% { opacity: 1; } ${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(${dx}px,${dy}px); opacity: 0; } 100% { transform: translate(${dx}px,${dy}px); opacity: 0; } }`;
              root.appendChild(style);
              burst.appendChild(spark);
            }
            root.appendChild(burst);
          }
        },
      },

      // ---------- HEARTS ----------
      hearts: {
        defaultColor: '#ff4d8d',
        build(root, color, count) {
          const heartSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 21 C 12 21, 4 14, 4 8.5 C 4 5, 6.5 3, 9 3 C 10.5 3, 12 4, 12 5.5 C 12 4, 13.5 3, 15 3 C 17.5 3, 20 5, 20 8.5 C 20 14, 12 21, 12 21 Z" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          const svgMarkup = heartSvg(color);
          for (let i = 0; i < count; i++) {
            const heart = document.createElement('div');
            const size = 12 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 50;
            const opacity = 0.5 + Math.random() * 0.4;
            heart.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;--of-peak-opacity:${opacity};filter:drop-shadow(0 0 4px ${color}77);animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            heart.innerHTML = svgMarkup;
            root.appendChild(heart);
          }
        },
      },

      // ---------- STARS ---------- (twinkling, fixed positions)
      stars: {
        defaultColor: '#fff5b3',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const star = document.createElement('div');
            const size = 2 + Math.random() * 3;
            const left = Math.random() * 100;
            const top = Math.random() * 95;
            const duration = 1.5 + Math.random() * 3;
            const delay = -Math.random() * duration;
            star.style.cssText = `position:absolute;left:${left}vw;top:${top}vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 2}px ${color};animation:ofPageTwinkle ${duration}s ease-in-out infinite;animation-delay:${delay}s;`;
            root.appendChild(star);
          }
        },
      },

      // ---------- BATS ---------- (silhouettes flying horizontally)
      bats: {
        defaultColor: '#1a0033',
        build(root, color, count) {
          const batSvg = (col) => `<svg viewBox="0 0 32 18" xmlns="http://www.w3.org/2000/svg"><path d="M16 5 L13 2 L11 4 L8 2 L5 4 L2 5 L0 9 L4 8 L7 11 L11 9 L13 12 L16 10 L19 12 L21 9 L25 11 L28 8 L32 9 L30 5 L27 4 L24 2 L21 4 L19 2 Z" fill="${col}"/></svg>`;
          const svgMarkup = batSvg(color);
          for (let i = 0; i < count; i++) {
            const bat = document.createElement('div');
            const size = 24 + Math.random() * 18;
            const top = 5 + Math.random() * 60;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const dy = -8 + Math.random() * 16; // ± vertical drift across screen
            const flapDuration = 0.25 + Math.random() * 0.2;
            // Outer animates the horizontal+vertical sweep; inner animates the flap.
            // We achieve "two transforms at once" by nesting: the outer translate is
            // a separate element from the inner scaleY.
            const inner = document.createElement('div');
            inner.style.cssText = `width:${size}px;height:${size * 9 / 16}px;animation:ofPageBatFlap ${flapDuration}s ease-in-out infinite;`;
            inner.innerHTML = svgMarkup;
            bat.style.cssText = `position:absolute;left:0;top:${top}vh;animation:ofPageBatFly ${duration}s linear infinite;animation-delay:${delay}s;--of-bat-dy:${dy}vh;`;
            bat.appendChild(inner);
            root.appendChild(bat);
          }
        },
      },

      // ---------- CONFETTI ---------- (rectangular bits, multi-color)
      confetti: {
        defaultColor: '#ff4d4d',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const piece = document.createElement('div');
            const w = 4 + Math.random() * 6;
            const h = 8 + Math.random() * 8;
            const left = Math.random() * 100;
            const duration = 5 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 70;
            // Vary hue by ±60deg for confetti-rainbow look around the chosen color
            const hueShift = Math.round(-60 + Math.random() * 120);
            piece.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${w}px;height:${h}px;background:${color};filter:hue-rotate(${hueShift}deg);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(piece);
          }
        },
      },

      // ---------- PETALS ---------- (cherry blossom / spring)
      petals: {
        defaultColor: '#ffb3d1',
        build(root, color, count) {
          const petalSvg = (col) => `<svg viewBox="0 0 16 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 C 4 6, 2 14, 8 23 C 14 14, 12 6, 8 1 Z" fill="${col}" stroke="${col}" stroke-width="0.3" opacity="0.85"/></svg>`;
          const svgMarkup = petalSvg(color);
          for (let i = 0; i < count; i++) {
            const petal = document.createElement('div');
            const size = 12 + Math.random() * 12;
            const left = Math.random() * 100;
            const duration = 12 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 80 + Math.random() * 100;
            const opacity = 0.5 + Math.random() * 0.4;
            petal.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size * 1.5}px;opacity:${opacity};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.2));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 3}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            petal.innerHTML = svgMarkup;
            root.appendChild(petal);
          }
        },
      },

      // ---------- EMBERS ---------- (rising glowing dots)
      embers: {
        defaultColor: '#ff7a1a',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const ember = document.createElement('div');
            const size = 2 + Math.random() * 4;
            const left = Math.random() * 100;
            const duration = 6 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.6 + Math.random() * 0.4;
            ember.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 3}px ${color}aa, 0 0 ${size * 6}px ${color}55;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(ember);
          }
        },
      },

      // ---------- BUBBLES ---------- (rising spheres)
      bubbles: {
        defaultColor: '#a0d8ef',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const bubble = document.createElement('div');
            const size = 14 + Math.random() * 26;
            const left = Math.random() * 100;
            const duration = 9 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 25 + Math.random() * 50;
            const opacity = 0.3 + Math.random() * 0.4;
            bubble.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle at 30% 30%, ${color}cc, ${color}55 70%, ${color}11 100%);border:1px solid ${color}88;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(bubble);
          }
        },
      },

      // ---------- RAIN ---------- (vertical streaks)
      rain: {
        defaultColor: '#a8c5e0',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const drop = document.createElement('div');
            const left = Math.random() * 100;
            const len = 12 + Math.random() * 20;
            const duration = 0.5 + Math.random() * 0.7;
            const delay = -Math.random() * duration;
            const opacity = 0.25 + Math.random() * 0.45;
            drop.style.cssText = `position:absolute;left:${left}vw;top:0;width:1px;height:${len}px;background:linear-gradient(to bottom, ${color}00, ${color});opacity:${opacity};animation:ofPageRain ${duration}s linear infinite;animation-delay:${delay}s;`;
            root.appendChild(drop);
          }
        },
      },
    };

    // ============================================================
    // ENGINE — applyEffect drives the whole thing.
    // ============================================================
    function buildLayer() {
      ensureStyle();
      const el = document.createElement('div');
      el.id = 'of-page-effects';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9990;overflow:hidden;`;
      return el;
    }

    function teardown() {
      if (layer) { layer.remove(); layer = null; }
    }

    // Public-ish API. The visual-config poll calls this every 5s; if the
    // tuple (name, color, intensity) hasn't changed, we no-op.
    function applyEffect(rawName, rawColor, rawIntensity) {
      const name = String(rawName || 'none').toLowerCase();
      const intensity = (rawIntensity === 'subtle' || rawIntensity === 'heavy') ? rawIntensity : 'medium';
      const color = (rawColor && String(rawColor).trim()) || '';

      // Skip rebuild if nothing changed since last apply
      if (last.name === name && last.color === color && last.intensity === intensity) return;
      last = { name, color, intensity };

      teardown();
      const def = EFFECTS[name];
      if (!def) return; // 'none' or unknown — leave the page bare

      const effectiveColor = color || def.defaultColor;
      const count = pickCount(name, intensity);
      if (count <= 0) return;

      layer = buildLayer();
      try {
        def.build(layer, effectiveColor, count);
        document.body.appendChild(layer);
      } catch (err) {
        // Effect crashed — fail silent, leave page clean
        teardown();
      }
    }

    // Apply initial state from the bootstrap blob, with backward-compat
    // for the old pageSnowEnabled boolean (an older server / older template
    // bundle might still set it but not the new keys).
    const bootstrap = window.__SHOWPILOT__ || {};
    const initialName = bootstrap.pageEffect != null
      ? bootstrap.pageEffect
      : (bootstrap.pageSnowEnabled ? 'snow' : 'none');
    applyEffect(initialName, bootstrap.pageEffectColor || '', bootstrap.pageEffectIntensity || 'medium');

    // Expose so the unified visual-config poll (below) can drive updates
    window._ofApplyEffect = applyEffect;
    // Backward-compat shim: any caller still toggling _ofApplySnowState
    // gets routed through the new engine. Older RF-style templates might
    // poke this; preserving it is cheap.
    window._ofApplySnowState = function (enabled) {
      applyEffect(enabled ? 'snow' : 'none', '', 'medium');
    };
  })();

  // ============================================================
  // VISUAL CONFIG POLL — runs unconditionally. Drives snow toggle and the
  // server-side audio gate (control mode OFF, etc.). Does NOT include
  // location; location is checked at click time, not page load. The
  // server returns blocked: true only when the show is off — so the
  // button is visible whenever the show is running, and clicking it
  // triggers a fresh location prompt that's the actual safeguard.
  // ============================================================
  (function initVisualConfigPoll() {
    async function poll() {
      try {
        // Intentionally no location passed — see comment above. Server's
        // gate decision here is purely "is the show running?".
        const r = await fetch('/api/visual-config?gateCheck=mode', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          if (typeof window._ofApplyEffect === 'function') {
            // New three-knob API. Server sends pageEffect/Color/Intensity.
            // Falls back to legacy pageSnowEnabled boolean if the server
            // is older and only sends that.
            const name = data.pageEffect != null
              ? data.pageEffect
              : (data.pageSnowEnabled ? 'snow' : 'none');
            window._ofApplyEffect(name, data.pageEffectColor || '', data.pageEffectIntensity || 'medium');
          } else if (typeof window._ofApplySnowState === 'function') {
            // Pre-engine viewer (e.g. an older rf-compat.js on a stale tab) — keep working.
            window._ofApplySnowState(!!data.pageSnowEnabled);
          }
          applyAudioGateState(!!data.audioGateBlocked, data.audioGateReason || '');
          // Show-not-playing is a SEPARATE, non-sticky signal from the audio
          // gate. The launcher button stays visible (so viewers can still
          // tap it) but the player panel content swaps to a "Show isn't
          // playing right now" message. Toggles freely as FPP starts/stops.
          if (typeof window._ofApplyShowNotPlaying === 'function') {
            window._ofApplyShowNotPlaying(!!data.showNotPlaying);
          }
        }
      } catch {}
    }
    setInterval(poll, 5000);
    poll(); // immediate initial poll
  })();

  // ============================================================
  // AUDIO GATE
  //
  // Two distinct concerns, kept separate:
  //   (1) Server-side block — show offline, control OFF, manual disable, etc.
  //       When blocked, the launcher button is hidden via CSS class. This is
  //       polled every 5s.
  //   (2) Location verification — happens at the moment the user taps the
  //       button (and periodically while audio plays). NOT on page load.
  //       This means a stale page can't accidentally let someone who's
  //       walked away (or never been there) play audio.
  //
  // The latch: once a server-side block fires during this page session, we
  // don't auto-reveal the button. The user must refresh the page to start
  // a fresh evaluation. This prevents auto-resume when admin flips control
  // off→on while the page was open.
  // ============================================================
  let _audioGateBlocked = false;
  let _audioGateReason = '';
  // Latch state — null when not latched, otherwise the CATEGORY of block:
  //   'server'    — admin disabled the show, control mode flipped, etc.
  //                 Sticky: only a page refresh clears this. We don't
  //                 want auto-resume when an admin toggles control.
  //   'proximity' — client-side watcher saw user move out of the radius.
  //                 NOT sticky: auto-clears when the watcher reports
  //                 back in-range, so the button reappears for one-tap
  //                 resume. This is the common "user walked across the
  //                 street and came back" case.
  let _gateLatchedBlocked = null;

  // Apply gate state. `category` distinguishes the two latch behaviors:
  //   'server'    — server-side block, refresh required to recover
  //   'proximity' — client-side proximity block, auto-clears on return
  // Defaults to 'server' since that's the conservative/legacy behavior
  // and most callers (the show-state poll, /api/now-playing-audio path,
  // periodic fallback) all want the sticky latch. Only the watcher's
  // direct out-of-range path passes 'proximity'.
  function applyAudioGateState(blocked, reason, category) {
    _audioGateBlocked = blocked;
    _audioGateReason = reason;
    if (blocked) {
      // 'server' wins over 'proximity' — if the server has already said
      // "you're blocked because show is offline", a subsequent proximity
      // block shouldn't downgrade the latch. Once a server latch is set,
      // it stays until refresh.
      if (_gateLatchedBlocked !== 'server') {
        _gateLatchedBlocked = category || 'server';
      }
    }
    const effectiveBlocked = blocked || _gateLatchedBlocked !== null;
    const btn = document.getElementById('of-listen-btn');
    const pill = document.getElementById('of-listen-minimized-pill');
    const panel = document.getElementById('of-listen-panel');
    if (btn) {
      if (effectiveBlocked) {
        btn.classList.add('of-audio-gate-pending');
      } else {
        btn.classList.remove('of-audio-gate-pending');
      }
    }
    if (pill && effectiveBlocked) pill.style.display = 'none';
    if (panel && effectiveBlocked) {
      panel.style.display = 'none';
      try { window.dispatchEvent(new CustomEvent('showpilot:audio-gate-blocked')); } catch {}
    }
  }

  // Lift a proximity latch — called by the watcher when the user re-enters
  // the radius after walking out. Does NOT affect server latches: if the
  // show is genuinely offline or admin has disabled the gate, we leave
  // that block in place. Only the proximity-specific latch is cleared.
  // After this call, the button/pill is revealed again — user taps to
  // resume audio. We don't auto-restart playback for two reasons:
  //   (1) Mobile audio contexts (especially iOS) require a user gesture
  //       to start playing, so silent auto-restart would fail anyway.
  //   (2) User agency — surprise music playing when someone walks past
  //       a parked car would be jarring. They tap when they're ready.
  function liftProximityLatch() {
    if (_gateLatchedBlocked !== 'proximity') return; // not our latch to lift
    _gateLatchedBlocked = null;
    _audioGateBlocked = false;
    _audioGateReason = '';
    const btn = document.getElementById('of-listen-btn');
    if (btn) {
      btn.classList.remove('of-audio-gate-pending');
      // Also restore the inline display — it was likely 'none' from when
      // the panel was open at the moment the watcher kicked out. Without
      // this, removing the CSS class lifts the !important but the inline
      // display:none still wins, leaving the button invisible.
      btn.style.display = 'flex';
    }
    // Note: we don't reveal pill/panel here — those were closed by the
    // out-of-range event, and re-opening them automatically would feel
    // weird. The launcher button reappears; user taps to start fresh.
  }
  window._ofAudioGate = () => ({ blocked: _audioGateBlocked, latched: _gateLatchedBlocked, reason: _audioGateReason });

  // Verify location with the server BEFORE allowing audio to start. This is
  // called at click time (and during playback re-checks). Returns a Promise
  // that resolves with { allowed, reason }. Forces a fresh GPS reading every
  // call — no maximumAge cache trickery.
  async function verifyLocationForAudio() {
    let loc;
    try {
      loc = await getFreshLocation();
    } catch (err) {
      return { allowed: false, reason: err.message || 'Location required' };
    }
    try {
      const r = await fetch(
        `/api/visual-config?lat=${encodeURIComponent(loc.lat)}&lng=${encodeURIComponent(loc.lng)}`,
        { credentials: 'include' }
      );
      if (!r.ok) return { allowed: false, reason: 'Server unavailable' };
      const data = await r.json();
      if (data.audioGateBlocked) {
        return { allowed: false, reason: data.audioGateReason || 'Audio not available right now.' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'Network error verifying location' };
    }
  }
  window._ofVerifyLocationForAudio = verifyLocationForAudio;

  // ============================================================
  // GATE DENIAL MODAL
  // Replaces the browser's native alert() with a themed modal that fits the
  // viewer page. Used when the audio gate denies listening (out of range,
  // location denied, show offline, etc.). One modal per page session reused
  // for all denials.
  // ============================================================
  let _gateModalEl = null;
  function ensureGateModal() {
    if (_gateModalEl) return _gateModalEl;
    const style = document.createElement('style');
    style.textContent = `
      #of-gate-modal {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(0,0,0,0.65);
        display: none; align-items: center; justify-content: center;
        padding: 1rem;
        animation: ofGateFadeIn 0.18s ease-out;
      }
      #of-gate-modal.show { display: flex; }
      @keyframes ofGateFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      #of-gate-modal-card {
        background: linear-gradient(180deg, rgba(30,30,40,0.98), rgba(20,20,28,0.98));
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 14px;
        padding: 1.5rem 1.25rem 1.25rem;
        width: 100%; max-width: 380px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        text-align: center;
        animation: ofGateSlideUp 0.22s ease-out;
      }
      @keyframes ofGateSlideUp {
        from { transform: translateY(10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      #of-gate-modal-icon {
        font-size: 2.5rem; margin-bottom: 0.5rem; line-height: 1;
      }
      #of-gate-modal-title {
        font-size: 1.15rem; font-weight: 700;
        margin: 0 0 0.5rem; color: #fff;
      }
      #of-gate-modal-msg {
        font-size: 0.95rem; line-height: 1.4;
        color: rgba(255,255,255,0.88);
        margin: 0 0 1.25rem;
      }
      #of-gate-modal-btn {
        display: block; width: 100%;
        padding: 0.75rem 1rem;
        background: rgba(220,38,38,0.95); color: #fff;
        border: 0; border-radius: 8px;
        font-size: 0.95rem; font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, transform 0.1s;
      }
      #of-gate-modal-btn:hover { background: rgba(220,38,38,1); }
      #of-gate-modal-btn:active { transform: scale(0.98); }
    `;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = 'of-gate-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div id="of-gate-modal-card">
        <div id="of-gate-modal-icon">🎧</div>
        <h3 id="of-gate-modal-title">Audio unavailable</h3>
        <p id="of-gate-modal-msg"></p>
        <button id="of-gate-modal-btn">OK</button>
      </div>
    `;
    document.body.appendChild(modal);

    const closeFn = () => modal.classList.remove('show');
    modal.querySelector('#of-gate-modal-btn').onclick = closeFn;
    // Tap-outside dismiss
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFn();
    });
    // Escape dismiss
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeFn();
    });

    _gateModalEl = modal;
    return modal;
  }

  function showGateModal(reason) {
    const modal = ensureGateModal();
    const msgEl = modal.querySelector('#of-gate-modal-msg');
    msgEl.textContent = reason || 'Audio is not available right now.';
    modal.classList.add('show');
  }
  window._ofShowGateModal = showGateModal;

  (function initListenOnPhone() {
    // ---- Floating launcher button ----
    //
    // Customizable per admin Settings → Viewer Page → Listen Button:
    //   - launcherIconSource: 'default' | 'preset:<key>' | 'custom'
    //   - launcherIconData: base64 data URL when source='custom'
    //   - launcherShowChrome: round red button background visible
    //   - launcherSize: 'small' | 'medium' | 'large' (40 / 52 / 72 px)
    //
    // Presets are inline SVGs (compact, scale cleanly, no extra requests).
    // Sized to the button via 100% width/height; SVGs use currentColor so
    // they pick up the button's text color when chrome is enabled.

    const LAUNCHER_PRESETS = {
      headphones: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 1 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z"/></svg>',
      tree: '<svg viewBox="0 0 24 24" fill="currentColor" width="65%" height="65%" style="display:block;"><path d="M12 2L7 9h3l-4 6h3l-5 7h16l-5-7h3l-4-6h3l-5-7zm-1 19h2v2h-2v-2z"/></svg>',
      pumpkin: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 4c-.7 0-1.3.3-1.7.8A2.5 2.5 0 0 0 8 5C5 5 3 8 3 12s2 7 5 7c.6 0 1.2-.1 1.7-.4.7.5 1.5.8 2.3.8s1.6-.3 2.3-.8c.5.3 1.1.4 1.7.4 3 0 5-3 5-7s-2-7-5-7c-.8 0-1.6.3-2.3.8C12.6 4.3 12.3 4 12 4zm-3 7l1.5 2L9 15l-1.5-2L9 11zm6 0l1.5 2L15 15l-1.5-2L15 11zm-5 4h4l-1 2h-2l-1-2z"/></svg>',
      ghost: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 2a8 8 0 0 0-8 8v12l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2v-12a8 8 0 0 0-8-8zm-3 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
      snowflake: '<svg viewBox="0 0 24 24" fill="currentColor" width="65%" height="65%" style="display:block;"><path d="M12 2v3.5l2-1.5 1 1.3-3 2.2v3l2.6-1.5.5-3.6 1.7.2-.3 2.4 3-1.7.9 1.5-3 1.7 2.2.9-.7 1.6-3-1.2L17 12l2.2 1.2 3-1.2.7 1.6-2.2.9 3 1.7-.9 1.5-3-1.7.3 2.4-1.7.2-.5-3.6-2.6-1.5v3l3 2.2-1 1.3-2-1.5V22h-2v-3.5l-2 1.5-1-1.3 3-2.2v-3l-2.6 1.5-.5 3.6-1.7-.2.3-2.4-3 1.7-.9-1.5 3-1.7L4.6 13l.7-1.6 3 1.2L7 12l-2.2-1.2-3 1.2-.7-1.6 2.2-.9-3-1.7.9-1.5 3 1.7-.3-2.4 1.7-.2.5 3.6L9 9.5v-3L6 4.3l1-1.3 2 1.5V2h3z" transform="scale(0.85) translate(2.1,2.1)"/></svg>',
      music: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M19.952 1.651a.75.75 0 01.298.599V16.303a3 3 0 01-2.176 2.884l-1.32.377a2.553 2.553 0 11-1.403-4.909l2.311-.66a1.5 1.5 0 001.088-1.442V6.994l-9 2.572v9.737a3 3 0 01-2.176 2.884l-1.32.377a2.553 2.553 0 11-1.402-4.909l2.31-.66a1.5 1.5 0 001.088-1.442V5.25a.75.75 0 01.544-.721l10.5-3a.75.75 0 01.658.122z"/></svg>',
      heart: '<svg viewBox="0 0 24 24" fill="currentColor" width="60%" height="60%" style="display:block;"><path d="M12 21s-7-4.5-9.5-9.5C1 8 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6 4 4.5 7.5C19 16.5 12 21 12 21z"/></svg>',
      shamrock: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 11c-1.5-3-4.5-3-5.5-1.5S6 13 9 14c-2.5 1-3 4-1.5 5s4 .5 5-2c0 3 2 5 4 5s4-2 4-5c1 2.5 3.5 3 5 2s1-4-1.5-5c3-1 4-3.5 2.5-4.5S14 8 12.5 11l-.5-9-.5 9z" transform="translate(0,1)"/></svg>',
      star: '<svg viewBox="0 0 24 24" fill="currentColor" width="62%" height="62%" style="display:block;"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7l3-7z"/></svg>',
    };

    // Resolve config to concrete style values.
    const SIZES = { small: 40, medium: 52, large: 72 };
    const launcherPx = SIZES[boot.launcherSize] || SIZES.medium;
    const showChrome = boot.launcherShowChrome !== false;
    const iconSource = boot.launcherIconSource || 'default';

    // Build the icon HTML based on source. If a custom image fails to load,
    // we fall back to the default emoji visually (broken-image alt would
    // look bad as a launcher). Image fills more of the button when chrome
    // is off (no border to compete with) and leaves padding when chrome is
    // on so the icon doesn't crowd the red ring.
    const iconSizePct = showChrome ? 75 : 100;
    let iconHtml;
    if (iconSource === 'custom' && boot.launcherIconData) {
      iconHtml =
        '<img src="' + boot.launcherIconData + '" alt="" ' +
        'style="width:' + iconSizePct + '%;height:' + iconSizePct + '%;' +
        'object-fit:contain;display:block;" ' +
        'onerror="this.outerHTML=\'\\u{1F3A7}\';" />';
    } else if (iconSource && iconSource.indexOf('preset:') === 0) {
      const key = iconSource.slice(7);
      iconHtml = LAUNCHER_PRESETS[key] || '🎧';
    } else {
      iconHtml = '🎧';
    }

    const btn = document.createElement('button');
    btn.id = 'of-listen-btn';
    btn.setAttribute('aria-label', 'Listen on phone');
    btn.title = 'Listen on phone';
    btn.innerHTML = iconHtml;

    // Chrome ON — original red round button with image/SVG inside.
    // Chrome OFF — bare image: no background, no border, no shadow. The
    // image itself is the affordance. We still keep cursor:pointer and a
    // subtle drop-shadow so it reads as tappable on light backgrounds.
    const chromeStyles = showChrome
      ? `background: rgba(220,38,38,0.95); color: white;
         border: 2px solid rgba(255,255,255,0.4);
         box-shadow: 0 4px 12px rgba(0,0,0,0.4);`
      : `background: transparent; color: white;
         border: 0;
         filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));`;

    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      width: ${launcherPx}px; height: ${launcherPx}px; border-radius: 50%;
      ${chromeStyles}
      font-size: ${Math.round(launcherPx * 0.46)}px; cursor: pointer;
      transition: transform 0.15s, background 0.15s, opacity 0.2s;
      padding: 0; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    `;
    // If audio is disabled at the show level, force the button hidden.
    // Distinct from the audio-gate-pending class (which can be lifted
    // when location verifies) — this one stays hidden until admin
    // re-enables audio and the viewer reloads. We still build the rest
    // of the player so we don't have to add null-checks all through the
    // initialization code; it just stays out of view.
    if (!boot.audioEnabled) {
      btn.style.display = 'none';
    }
    // If audio gate is enabled, hide the button initially via CSS class
    // (with !important so other state changes like setMode('closed') can't
    // accidentally reveal it). The button is only revealed once the visual-config
    // poll confirms the viewer's location is within range AND the show is on.
    if (boot.audioGateEnabled) btn.classList.add('of-audio-gate-pending');
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };

    // ---- Theme palettes (player bar colors per decoration) ----
    // Each palette: bg gradient + border accent + glow color.
    // CSS variables let decoration code read the active theme color.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
      /* Audio gate — hides launcher button until server confirms viewer is in range.
         Uses !important so setMode('closed') and other state transitions can't
         accidentally reveal it. */
      .of-audio-gate-pending {
        display: none !important;
      }
      #of-listen-panel {
        --of-bg: rgba(20,20,30,0.97);
        --of-border: rgba(255,255,255,0.15);
        --of-glow: rgba(0,0,0,0);
        --of-text: #fff;
        --of-text-dim: #aaa;
        background: var(--of-bg) !important;
        border-top: 1px solid var(--of-border) !important;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.5), 0 -2px 12px var(--of-glow);
        color: var(--of-text);
        transition: background 0.4s, border-color 0.4s, box-shadow 0.4s;
      }
      #of-listen-panel.of-theme-christmas {
        --of-bg: linear-gradient(180deg, rgba(127,29,29,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(254,202,202,0.8);
        --of-glow: rgba(239,68,68,0.5);
      }
      #of-listen-panel.of-theme-halloween {
        --of-bg: linear-gradient(180deg, rgba(88,28,135,0.97), rgba(154,52,18,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(251,146,60,0.5);
      }
      #of-listen-panel.of-theme-easter {
        --of-bg: linear-gradient(180deg, rgba(168,85,247,0.95), rgba(96,165,250,0.95));
        --of-border: rgba(251,207,232,0.9);
        --of-glow: rgba(251,207,232,0.5);
      }
      #of-listen-panel.of-theme-stpatricks {
        --of-bg: linear-gradient(180deg, rgba(21,128,61,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(134,239,172,0.8);
        --of-glow: rgba(34,197,94,0.5);
      }
      #of-listen-panel.of-theme-independence {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.97), rgba(153,27,27,0.97));
        --of-border: rgba(255,255,255,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-valentines {
        --of-bg: linear-gradient(180deg, rgba(190,24,93,0.97), rgba(112,26,117,0.97));
        --of-border: rgba(251,207,232,0.85);
        --of-glow: rgba(244,114,182,0.5);
      }
      #of-listen-panel.of-theme-hanukkah {
        --of-bg: linear-gradient(180deg, rgba(29,78,216,0.97), rgba(30,58,138,0.97));
        --of-border: rgba(191,219,254,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-thanksgiving {
        --of-bg: linear-gradient(180deg, rgba(154,52,18,0.97), rgba(120,53,15,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(234,88,12,0.5);
      }
      #of-listen-panel.of-theme-snow {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.95), rgba(15,23,42,0.97));
        --of-border: rgba(186,230,253,0.85);
        --of-glow: rgba(186,230,253,0.5);
      }

      /* Player button polish — hover feedback that works regardless of theme */
      #of-listen-panel button {
        outline: none;
      }
      #of-listen-panel button:focus-visible {
        outline: 2px solid rgba(255,255,255,0.6);
        outline-offset: 2px;
      }
      #of-listen-panel #of-listen-playpause:hover {
        background: rgba(255,255,255,0.25) !important;
        transform: scale(1.05);
      }
      #of-listen-panel #of-listen-playpause:active {
        transform: scale(0.95);
      }
      #of-listen-panel #of-listen-mute:hover,
      #of-listen-panel #of-listen-min:hover,
      #of-listen-panel #of-listen-close:hover {
        background: rgba(255,255,255,0.12);
        color: #fff !important;
      }
      #of-listen-panel #of-listen-close:hover {
        color: #ef4444 !important;
      }

      /* Marquee scroll for long titles/artists */
      @keyframes ofMarquee {
        0%   { transform: translateX(0); }
        15%  { transform: translateX(0); }   /* hold start briefly */
        50%  { transform: translateX(var(--of-marquee-offset, 0)); }
        65%  { transform: translateX(var(--of-marquee-offset, 0)); }   /* hold end */
        100% { transform: translateX(0); }
      }
      #of-listen-title.of-marquee-on,
      #of-listen-artist.of-marquee-on {
        animation: ofMarquee var(--of-marquee-duration, 10s) ease-in-out infinite;
      }
      #of-listen-title-wrap:hover #of-listen-title,
      #of-listen-artist-wrap:hover #of-listen-artist {
        animation-play-state: paused;
      }
    `;
    document.head.appendChild(themeStyle);

    // ---- Sticky-bottom panel ----
    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      padding: 12px 16px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
      transform: translateY(100%);
      transition: transform 0.25s ease-out, background 0.4s, border-color 0.4s;
      backdrop-filter: blur(8px);
    `;
    panel.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto; display: flex; gap: 12px; align-items: center; position: relative; z-index: 2;">
        <img id="of-listen-cover" src="" alt=""
             style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;
                    background: #333; flex-shrink: 0;" />
        <div style="flex: 1; min-width: 0;">
          <div id="of-listen-title-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-title" style="font-weight: 600; display: inline-block;
                 white-space: nowrap;">Loading…</div>
          </div>
          <div id="of-listen-artist-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-artist" style="font-size: 12px; color: rgba(255,255,255,0.65);
                 display: inline-block; white-space: nowrap;"></div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: rgba(255,255,255,0.5);">
            <span id="of-listen-status">Preparing…</span>
            <span id="of-listen-drift"></span>
          </div>
        </div>
        <button id="of-listen-playpause" aria-label="Play/pause"
                style="background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.1); color: #fff;
                       width: 40px; height: 40px; border-radius: 50%;
                       cursor: pointer; flex-shrink: 0; padding: 0;
                       display: flex; align-items: center; justify-content: center;
                       transition: background 0.15s, transform 0.1s;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button id="of-listen-mute" aria-label="Mute"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>
          </svg>
        </button>
        <button id="of-listen-min" aria-label="Hide player (audio keeps playing)"
                title="Hide (audio keeps playing)"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 13H5v-2h14v2z"/>
          </svg>
        </button>
        <button id="of-listen-close" aria-label="Stop and close"
                title="Stop &amp; close"
                style="background: transparent; border: 0; color: rgba(255,255,255,0.75);
                       cursor: pointer; flex-shrink: 0; padding: 8px; line-height: 0;
                       border-radius: 6px; transition: background 0.15s, color 0.15s;
                       display: flex; align-items: center; justify-content: center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>
          </svg>
        </button>
      </div>
    `;

    // ---- Minimized "still playing" pill ----
    const minimizedPill = document.createElement('button');
    minimizedPill.id = 'of-listen-pill';
    minimizedPill.setAttribute('aria-label', 'Audio playing — tap to expand');
    minimizedPill.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      background: rgba(220,38,38,0.95); color: white;
      border: 2px solid rgba(255,255,255,0.4);
      border-radius: 999px; padding: 8px 14px 8px 12px;
      font-size: 13px; font-weight: 500;
      cursor: pointer; display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      align-items: center; gap: 6px; max-width: 240px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    `;
    minimizedPill.innerHTML = `
      <span style="display: inline-block; width: 8px; height: 8px; background: #4ade80; border-radius: 50%; animation: ofPulse 1.5s infinite;"></span>
      <span id="of-listen-pill-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Playing</span>
    `;

    // Add pulse animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes ofPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.2); }
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(btn);
    document.body.appendChild(panel);
    document.body.appendChild(minimizedPill);

    // ---- DOM refs ----
    const titleEl = panel.querySelector('#of-listen-title');
    const titleWrap = panel.querySelector('#of-listen-title-wrap');
    const artistEl = panel.querySelector('#of-listen-artist');
    const artistWrap = panel.querySelector('#of-listen-artist-wrap');
    const coverEl = panel.querySelector('#of-listen-cover');
    const statusEl = panel.querySelector('#of-listen-status');
    const driftEl = panel.querySelector('#of-listen-drift');
    const playBtn = panel.querySelector('#of-listen-playpause');
    const muteBtn = panel.querySelector('#of-listen-mute');
    const minBtn = panel.querySelector('#of-listen-min');
    const closeBtn = panel.querySelector('#of-listen-close');
    const pillText = minimizedPill.querySelector('#of-listen-pill-text');

    // ============================================================
    // SHOW-NOT-PLAYING STATE
    //
    // When the server reports that FPP isn't actively playing a sequence
    // (e.g. show is between songs, FPP stopped, plugin stale), we swap
    // the player into a stripped-down "Show isn't playing right now"
    // message instead of hiding the launcher. Per Will's spec: viewers
    // should NOT have to refresh to get the player back when the show
    // resumes — so the launcher stays available, and this state toggles
    // freely as FPP starts/stops.
    //
    // Stripped state hides: cover art, title/artist/status block, play,
    // mute, and minimize buttons. Shows: a centered message and the
    // close (×) button. Restoring un-hides everything.
    // ============================================================

    // Locate the inner column that holds title/artist/status — it's the
    // sibling of coverEl with no ID. Cache it so we don't re-query.
    const textCol = coverEl.nextElementSibling;

    // Inject the "not playing" message element. Hidden by default; lives
    // in the same flex row as the cover so it can take its place when
    // we hide the cover/text/buttons.
    const notPlayingMsg = document.createElement('div');
    notPlayingMsg.id = 'of-listen-not-playing';
    notPlayingMsg.style.cssText = `
      flex: 1; min-width: 0;
      text-align: center;
      font-size: 15px; font-weight: 500;
      color: rgba(255,255,255,0.92);
      padding: 4px 8px;
      display: none;
    `;
    notPlayingMsg.textContent = "Show isn't playing right now";
    // Insert before the close button so the close stays at the right edge.
    closeBtn.parentElement.insertBefore(notPlayingMsg, closeBtn);

    let _showNotPlaying = false;

    function applyShowNotPlaying(notPlaying) {
      // No-op if state hasn't changed — avoids redundant DOM thrash on
      // every 5s poll.
      if (notPlaying === _showNotPlaying) return;
      _showNotPlaying = notPlaying;

      if (notPlaying) {
        // Hide the hidden minimized pill if it was visible — a "Playing"
        // indicator while nothing is playing would be confusing.
        minimizedPill.style.display = 'none';

        // Stop any in-flight audio so we're not pumping silence (or worse,
        // stale buffer tails) through the speakers while showing "not
        // playing." Don't tear down audioCtx — recreating it later requires
        // a user gesture on iOS, which would break the resume-on-restart
        // flow.
        try { stopAudio(); } catch {}

        // Hide the player content. notPlayingMsg has flex:1 so it takes
        // the textCol's place. Close (×) stays visible.
        coverEl.style.display = 'none';
        if (textCol) textCol.style.display = 'none';
        playBtn.style.display = 'none';
        muteBtn.style.display = 'none';
        minBtn.style.display = 'none';
        notPlayingMsg.style.display = 'block';
      } else {
        notPlayingMsg.style.display = 'none';
        coverEl.style.display = '';
        if (textCol) textCol.style.display = '';
        playBtn.style.display = '';
        muteBtn.style.display = '';
        minBtn.style.display = '';
        // If the user has the panel open when the show resumes, get audio
        // going. If audioCtx already exists (panel was opened during a
        // prior playing window), a syncOnce() picks up the new track.
        // If not (panel was opened in the not-playing state), we need a
        // full startup() — but Web Audio init requires a user gesture on
        // iOS, so this will only succeed if the user interacted recently.
        // Acceptable: if startup fails silently, the panel still shows the
        // (now-empty) controls and they can tap play to retry.
        if (panelMode === 'open') {
          if (audioCtx) {
            try { syncOnce(); } catch {}
          } else {
            try { startup(); } catch {}
          }
        }
      }
    }
    window._ofApplyShowNotPlaying = applyShowNotPlaying;

    // Apply marquee scroll if text overflows the wrapper. Called after any
    // title/artist text update. Adds 24px padding on the "scrolled-to" position
    // so the user can see the full text comfortably. Speed scales with overflow:
    // ~30 pixels per second feels readable.
    function setupMarquee(textEl, wrapEl) {
      // Clear existing animation first
      textEl.classList.remove('of-marquee-on');
      textEl.style.removeProperty('--of-marquee-offset');
      textEl.style.removeProperty('--of-marquee-duration');
      // Defer measurement so layout has a chance to settle
      requestAnimationFrame(() => {
        const overflow = textEl.scrollWidth - wrapEl.clientWidth;
        if (overflow > 4) {
          // Overflow is the distance we need to scroll. Negative because we're
          // scrolling LEFT to reveal text on the right.
          const offset = -(overflow + 12); // +12px so end of text is fully visible
          const speed = 30; // px per second
          // Total animation time: scroll out (50%) + scroll back (50%)
          const duration = Math.max(6, (Math.abs(offset) * 2) / speed);
          textEl.style.setProperty('--of-marquee-offset', offset + 'px');
          textEl.style.setProperty('--of-marquee-duration', duration + 's');
          textEl.classList.add('of-marquee-on');
        }
      });
    }

    // Re-evaluate marquee on viewport resize (rotation, browser resize)
    let _marqueeResizeTimer = null;
    window.addEventListener('resize', () => {
      if (_marqueeResizeTimer) clearTimeout(_marqueeResizeTimer);
      _marqueeResizeTimer = setTimeout(() => {
        if (titleEl.textContent) setupMarquee(titleEl, titleWrap);
        if (artistEl.textContent) setupMarquee(artistEl, artistWrap);
      }, 250);
    });

    // ---- SVG icons (swapped by setPlayIcon, setMuteIcon) ----
    const SVG_PLAY  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const SVG_PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
    const SVG_VOLUME = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
    const SVG_MUTED  = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4a1 1 0 0 0 1 1h3l4 4a1 1 0 0 0 1.7-.7V5.7A1 1 0 0 0 11 5L7 9H4a1 1 0 0 0-1 1zm17.7 5.3l-1.4-1.4L21 12.2l-1.7-1.7 1.4-1.4 1.7 1.7 1.7-1.7 1.4 1.4-1.7 1.7 1.7 1.7-1.4 1.4-1.7-1.7-1.7 1.7z" transform="translate(-3.5 0)"/></svg>';
    function setPlayIcon(playing) { playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY; }
    function setMuteIcon(muted)   { muteBtn.innerHTML = muted ? SVG_MUTED : SVG_VOLUME; }

    // ---- State ----
    let panelMode = 'closed';     // 'closed' | 'open' | 'minimized'
    let audioCtx = null;
    let gainNode = null;
    let isMuted = false;
    let currentBuffer = null;     // AudioBuffer of currently-playing track
    let currentSource = null;     // AudioBufferSourceNode of currently playing
    let currentSequence = null;
    let currentMediaName = null;
    let prefetchPromise = null;   // pending fetch for next track
    let prefetchedSeq = null;     // seq name we pre-fetched
    let clockOffset = 0;          // serverNow - clientNow at last sync
    let trackStartedAtMs = 0;     // when this track started on server (server epoch)
    let trackDuration = 0;        // total length in seconds
    let audioSyncOffsetMs = 0;    // per-show offset to compensate for FPP audio output latency vs cache delivery speed. Server sends this; positive = audio plays LATER (compensates for too-early arrival)
    // Incremented on every stopAudio/teardown/track-change so in-flight async
    // operations (scheduled play, clock fetch) can detect they're stale and bail.
    let playGeneration = 0;

    // The HTML5 <audio> element used for playback. We use HTML5 audio
    // (rather than Web Audio API) because it provides much better
    // multi-phone sync — see comments in handleTrackChange. Reset to
    // null after stopAudio.
    let htmlAudio = null;
    let useRelay = false;  // true when audio is coming from the live relay stream

    // Post-startup correction state (v0.27.0).
    // The browser's `.play()` call has non-deterministic startup latency
    // — even on the same hardware between sessions, between 0 and 200ms
    // can elapse between calling .play() and the speakers actually
    // producing sound. Predicting this latency is hopeless. Measuring it
    // after the fact is straightforward.
    //
    // pendingPostStartCorrectionAtMs is the wall-clock time at which we
    // should perform a one-shot measurement of htmlAudio.currentTime
    // against the expected position from FPP and seek-correct any error.
    // Set when we call .play() for a new track; cleared once the
    // correction fires or the track ends.
    //
    // 1.0s after play start gives the audio element time to settle into
    // steady-state playback (initial buffer/decoder warmup is over) so
    // the measurement reflects real per-device startup error rather than
    // transient warmup wobble.
    let pendingPostStartCorrectionAtMs = 0;

    // Live position from FPP. When the plugin is running >= 0.11.0, it
    // pushes "FPP is at position X.Y as of timestamp T" updates every
    // ~500ms via socket.io. We use this as the authoritative anchor for
    // playback sync — it reflects FPP's actual hardware audio output
    // position, including buffer delay, so phones aligning to it
    // naturally match what the speakers are emitting.
    //
    // This replaces extrapolating from trackStartedAtMs, which has
    // whatever bias was baked in at track-change time and stays put
    // for the whole track regardless of how FPP's actual playback
    // progresses. Live position is fresh by definition.
    //
    // Shape: { sequence, position, updatedAt } or null if no update yet.
    // The viewer subscribes to 'positionUpdate' socket events to keep
    // this fresh; initial value comes from now-playing-audio response.
    let livePosition = null;
    let lastSyncResponse = null;  // raw response for debugging
    let pollTimer = null;
    let driftTimer = null;
    let locationVerifyTimer = null;
    // navigator.geolocation.watchPosition() handle — used for continuous
    // proximity checking while audio plays. Only set when audio gate is
    // enabled. Cleared in teardown() to release the GPS subscription.
    let watchPositionId = null;
    // Timestamp (ms) of the most recent watcher callback that confirmed
    // the user is IN range. Used to skip the periodic server re-check
    // when the watcher has done its job recently — see the periodic
    // check in startup() for the rationale.
    let lastWatcherInRangeMs = 0;
    // Timestamp (ms) when audio playback started. We use this to grace-
    // period the FIRST ~30 seconds of watchPosition updates, because the
    // browser often fires the first update with a stale cached position
    // from BEFORE the user reached the show. The click-time fresh-location
    // check already proved they're in range, so we trust that for the
    // first window and only start enforcing on watcher updates after.
    let audioStartedAtMs = 0;
    // ---- Drift measurement anchors (v0.18.17+) ----
    // When we schedule a buffer to play, we capture two things:
    //   trackScheduledAtAudioCtx — the audioCtx.currentTime value at the
    //     moment of src.start(). This is the audio-clock anchor that
    //     advances at exactly the rate of the audio output hardware.
    //   trackScheduledAtPositionSec — where in the track that anchor
    //     corresponds to (i.e. startOffset). Subsequent audio-clock time
    //     past the anchor maps directly to track position.
    // Together these let updateDriftDisplay() compute "where is audio
    // ACTUALLY playing right now?" and compare to "where SHOULD it be
    // per server time?" — the difference is the real drift.
    //
    // We also capture outputLatency at schedule time because some
    // browsers update it as audio devices change. Using a snapshot from
    // schedule-time means our drift number is consistent with what we
    // told the audio system to do.
    let trackScheduledAtAudioCtx = 0;
    let trackScheduledAtPositionSec = 0;
    let trackScheduledOutputLatency = 0;
    let pendingStartTimeout = null;

    // ---- Auto-sync state ----
    // We continuously adjust playbackRate based on smoothed drift. The
    // server's audio_sync_offset_ms acts as a constant target (a "bias")
    // and continuous resync corrects against it. Earlier versions tried
    // a "converge once then lock at 1.0" approach but it failed when
    // drift fluctuated mid-track (variable FPP audio output latency,
    // network jitter affecting clock sync, etc.) — once we locked at
    // 1.0, we wouldn't catch drift that developed later. This version
    // never stops adjusting.
    //
    // Key smoothing: we keep a rolling window of recent drift samples
    // and act on the AVERAGE, not the instantaneous reading. Without
    // this, normal jitter (±50–100ms tick to tick) would cause the rate
    // to constantly oscillate, producing audible warbling. Averaging
    // 5 samples (~1.25s at 250ms tick) absorbs most jitter while still
    // reacting to real trends.
    let lastAppliedRate = 1.0;
    const driftHistory = [];          // ring of recent drift values in seconds
    const DRIFT_HISTORY_SIZE = 5;     // ~1.25 seconds of samples

    // Integrated playback position. We need to track this separately from
    // (audioCtx.currentTime - trackScheduledAtAudioCtx) because the audio
    // context's clock advances at real time regardless of playbackRate.
    // When we set rate=0.98, real time advances at 1.0 but the audio file
    // position advances at 0.98. Without integrating rate over time, the
    // drift calculation diverges from reality whenever rate isn't 1.0,
    // which is exactly when we need it to be accurate.
    //
    // Each drift tick we add (real_dt * current_rate) to this counter.
    // It represents "how many seconds INTO THE FILE we have actually
    // played back since the track was scheduled."
    let integratedPlayedSec = 0;
    let lastIntegrationTime = 0;      // audioCtx.currentTime at last integration tick

    // Crossfade correction state. We use jump-cut + crossfade rather than
    // continuous rate adjustment because rate adjustment introduces
    // accumulated math errors over time and produces audible pitch shifts.
    // PulseMesh and other multi-room audio systems use this pattern.
    //
    // The plan: when drift exceeds threshold, fade out the current source
    // over a short window while a new source starts at the corrected
    // position with a fade-in. The crossfade is brief enough (~40ms) that
    // listeners don't perceive it as a discontinuity, but the position
    // snaps to truth instantly. No oscillation, no math errors.
    //
    // We hold the per-source GainNode so we can ramp ITS volume during
    // the crossfade — the main `gainNode` at the destination handles
    // user mute/volume and stays untouched by sync operations.
    let currentSourceGain = null;
    // Throttle: don't crossfade more than once per N seconds. Without
    // this, jitter near the threshold would trigger correction on every
    // tick, which would just produce an ugly chain of crossfades.
    let lastCrossfadeAtCtx = 0;
    // Same idea but for HTML5 re-seek correction (in wall-clock ms).
    let lastReseekAtMs = 0;

    // ---- UI handlers ----
    // When the audio distance gate is enabled (admin opt-in), tapping the
    // launcher triggers a fresh location verification before the player
    // opens. getFreshLocation forces a brand-new GPS reading every time,
    // so users who loaded the page elsewhere (or walked away after granting
    // earlier) can't bypass the radius check via cached coordinates.
    //
    // When the gate is disabled, the click opens the player directly — no
    // permission prompts, no GPS. Showrunners playing original or licensed
    // content shouldn't have to ask viewers for location just to listen.
    btn.onclick = async () => {
      // If the show isn't currently playing, there's no audio to gate on.
      // Skip the location prompt entirely — just open the panel so the
      // user sees the "Show isn't playing" message. We'll ask for location
      // when it actually matters (when they tap to listen to real audio).
      if (_showNotPlaying) {
        setMode('open');
        return;
      }
      if (!boot.audioGateEnabled) {
        setMode('open');
        return;
      }
      const origIcon = btn.innerHTML;
      btn.innerHTML = '⏳';
      btn.disabled = true;
      try {
        const result = await window._ofVerifyLocationForAudio();
        if (!result.allowed) {
          window._ofShowGateModal(result.reason);
          return;
        }
        setMode('open');
      } finally {
        btn.innerHTML = origIcon;
        btn.disabled = false;
      }
    };
    minBtn.onclick = () => setMode('minimized');
    closeBtn.onclick = () => setMode('closed');
    minimizedPill.onclick = () => setMode('open');
    playBtn.onclick = () => {
      // With HTML5 audio, the playBtn acts as a stop/restart toggle.
      // Stop: clear out the audio element so the user can re-sync.
      // Restart: kick a syncOnce() which triggers handleTrackChange with
      // fresh data, and that builds a new <audio> element seeked to the
      // current expected position.
      if (htmlAudio && !htmlAudio.paused) {
        stopAudio();
        statusEl.textContent = 'Resuming…';
        setPlayIcon(false);
        syncOnce();
      } else {
        // Either nothing playing yet, or audio is paused. Either way,
        // a fresh sync will rebuild and seek correctly.
        syncOnce();
      }
    };
    muteBtn.onclick = () => {
      isMuted = !isMuted;
      // Apply to HTML5 audio element (the active playback path).
      if (htmlAudio) htmlAudio.muted = isMuted;
      // Also toggle the Web Audio gain node for any legacy code paths
      // that might still produce sound through it.
      if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
      muteBtn.style.color = isMuted ? '#ef4444' : 'rgba(255,255,255,0.75)';
      setMuteIcon(isMuted);
    };

    function setMode(mode) {
      panelMode = mode;
      // Sticky panel takes ~75px height — push body content up so sticky doesn't
      // cover footer content the user scrolls to. Restored when panel closes/minimizes.
      document.body.style.paddingBottom = (mode === 'open') ? '88px' : '';
      if (mode === 'closed') {
        panel.style.display = 'none';
        panel.style.transform = 'translateY(100%)';
        minimizedPill.style.display = 'none';
        btn.style.display = 'flex';
        stopAudio();
        teardown();
      } else if (mode === 'open') {
        btn.style.display = 'none';
        minimizedPill.style.display = 'none';
        panel.style.display = 'block';
        // Force reflow then transition in
        void panel.offsetHeight;
        panel.style.transform = 'translateY(0)';
        // Skip audio init when the show isn't playing — there's nothing
        // to sync to, and starting audio + running the gate check would
        // cause syncOnce() to flip the gate latch and immediately hide
        // the panel we just opened. The applyShowNotPlaying transition
        // back to false will call startup() when the show resumes.
        if (!audioCtx && !_showNotPlaying) startup();
      } else if (mode === 'minimized') {
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => { panel.style.display = 'none'; }, 250);
        btn.style.display = 'none';
        minimizedPill.style.display = 'flex';
        // Audio keeps playing
      }
    }

    // ---- Initialization (when panel first opens) ----
    async function startup() {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = isMuted ? 0 : 1;
        gainNode.connect(audioCtx.destination);
        statusEl.textContent = 'Loading…';
        // Establish accurate clock offset BEFORE first sync poll. The first
        // poll's track-start timestamp uses clockOffset to compute initial
        // playback position; if clockOffset is wrong by 200ms here, every
        // viewer joining at the same time gets a different bias, and they
        // drift apart from each other. Burst sync up front prevents that.
        await syncClockBurst(5);
        await syncOnce();
        // Re-sync periodically — once per second is enough since track-start
        // anchoring means we don't need continuous position updates.
        pollTimer = setInterval(syncOnce, 1000);
        // Drift correction loop (cheap — just compares client clock to expected)
        driftTimer = setInterval(updateDriftDisplay, 250);
        // Refresh clock offset every 30s with a short burst. Clock drift on
        // most devices is a few ms/minute, but phones waking from sleep or
        // switching networks can suddenly jump by a lot. Cheap to keep
        // current rather than discover staleness when sync goes off.
        setInterval(() => syncClockBurst(3), 30000);

        // Subscribe to live position updates from the server. The plugin
        // pushes "FPP is at position X.Y" via /api/plugin/position; the
        // server relays as a socket.io 'positionUpdate' event. We update
        // our anchor each time, giving us near-real-time speaker-accurate
        // sync without polling overhead. socket.io is shared with the
        // outer (queue/voting) scope; window.io() returns a singleton.
        try {
          if (window.io) {
            const audioSock = window.io();
            audioSock.on('positionUpdate', (msg) => {
              if (!msg || !msg.sequence) return;
              if (currentSequence && msg.sequence !== currentSequence) return;
              livePosition = {
                sequence: msg.sequence,
                position: msg.position,
                updatedAt: msg.updatedAt,
              };
            });
          }
        } catch (e) {
          console.warn('[ShowPilot] could not subscribe to position updates:', e);
        }

        // ============================================================
        // Audio gate — continuous proximity enforcement (v0.18.15+)
        // ============================================================
        // Two layers, both copyright safeguards:
        //
        //   1. CONTINUOUS — navigator.geolocation.watchPosition() fires
        //      whenever the device's GPS subscription updates (typically
        //      every few seconds when moving, less when stationary). On
        //      each update, compute distance to the show. If outside the
        //      radius, kick out immediately. This is the fast cutoff that
        //      catches users who walk/drive away mid-playback.
        //
        //   2. PERIODIC — every 5 minutes, do a full server-side re-check
        //      via verifyLocationForAudio(). This catches things the
        //      continuous watcher can't: tampered clients (DevTools-
        //      disabled watcher), GPS outages where the watcher stops
        //      firing, and server-side state changes (admin turned the
        //      gate off, control mode changed, etc).
        //
        // Both layers only run when boot.audioGateEnabled is true. Without
        // an enabled gate, the player does no location checks at all.
        // ============================================================
        if (boot.audioGateEnabled) {
          // (1) Continuous watcher — only set up if we have show coords
          // from the boot bundle. We need them to compute distance
          // client-side. If they're missing (older server, gate enabled
          // without coords configured), fall back to the periodic check
          // alone — better than nothing.
          if (
            typeof boot.audioGateLatitude === 'number' &&
            typeof boot.audioGateLongitude === 'number' &&
            typeof boot.audioGateRadiusMiles === 'number' &&
            'geolocation' in navigator
          ) {
            try {
              watchPositionId = navigator.geolocation.watchPosition(
                (pos) => {
                  // Grace period: ignore the FIRST 30 seconds of watcher
                  // updates after audio starts. The first watchPosition
                  // callback often fires with a stale cached location
                  // from BEFORE the user reached the show — but the
                  // click-time fresh-location check already proved they
                  // were in range, so honor that. After 30 seconds the
                  // watcher's positions should be fresh.
                  if (audioStartedAtMs === 0) return;  // not playing yet
                  if (Date.now() - audioStartedAtMs < 30 * 1000) {
                    // During grace period, still record liveness so the
                    // periodic server re-check can skip — the click-time
                    // check already verified, no need to re-verify so soon.
                    lastWatcherInRangeMs = Date.now();
                    return;
                  }

                  const dist = haversineMiles(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    boot.audioGateLatitude,
                    boot.audioGateLongitude
                  );
                  if (dist > boot.audioGateRadiusMiles) {
                    // Out of range — tear down audio immediately. Pass
                    // 'proximity' as the latch category so the user can
                    // come back later and have the button auto-reveal
                    // (one-tap resume) without needing a refresh.
                    stopAudio();
                    applyAudioGateState(
                      true,
                      'Audio is only available to listeners present at the show.',
                      'proximity'
                    );
                    statusEl.textContent =
                      'Audio stopped — you have moved away from the show.';
                  } else {
                    // In range — record this so the periodic server check
                    // can skip itself. As long as the watcher is alive and
                    // reporting in-range, the server doesn't need to be
                    // re-asked the same question.
                    lastWatcherInRangeMs = Date.now();
                    // If we were proximity-latched (user walked away and
                    // is now back), lift the latch so the launcher button
                    // reappears. liftProximityLatch is a no-op for any
                    // other latch state, so this is safe to call on
                    // every in-range update.
                    liftProximityLatch();
                  }
                },
                (err) => {
                  // Watcher errors are non-fatal — the periodic server
                  // re-check below will still fire. Log for debugging.
                  if (window.console && console.warn) {
                    console.warn('[audio-gate] watchPosition error:', err.message || err);
                  }
                },
                {
                  // Coarse positioning is fine — we're checking "within
                  // half a mile?" not "within 5 meters?" Setting
                  // enableHighAccuracy: false saves significant battery
                  // since the device can use cell-tower / Wi-Fi positioning
                  // instead of waking the GPS chip continuously.
                  enableHighAccuracy: false,
                  // No maximumAge cap on the watcher — let the browser
                  // batch positions however it wants. If the user is
                  // stationary, fewer updates is correct.
                  // No timeout — watchPosition shouldn't error on slow
                  // fixes, it just doesn't fire until it has one.
                }
              );
            } catch (e) {
              // Browser threw on watchPosition setup — extremely rare,
              // but don't let it break audio playback.
              if (window.console && console.warn) {
                console.warn('[audio-gate] watchPosition setup failed:', e.message || e);
              }
            }
          }

          // (2) Periodic server re-check — fallback layer for cases the
          // continuous watcher can't handle. Now smart: skips itself when
          // the watcher has confirmed the user is in range within the
          // last 6 minutes. The watcher is already doing the work — re-
          // asking the server would just burn battery (waking GPS for
          // getCurrentPosition with maximumAge: 0) and bandwidth for no
          // security benefit.
          //
          // The 6-minute threshold is intentionally larger than this
          // interval (5 min) to handle small timing drift. If the
          // watcher reported "in range" at minute 4:55 and we run at
          // minute 5:00, that's only 5 seconds of staleness — still
          // fresh enough to trust.
          //
          // What does this actually catch?
          //   - Tampered client (DevTools-killed watcher). lastWatcherInRangeMs
          //     stays stale, so the periodic check fires and uses
          //     getFreshLocation to verify directly with the server.
          //   - Watcher silently dead due to GPS chip outage or browser
          //     bug. Same path: stale liveness → periodic check fires.
          //
          // What does this NOT need to catch?
          //   - Admin disabled the gate / show turned off. The 5-second
          //     /api/visual-config poll above already handles those —
          //     server returns audioGateBlocked=true, applyAudioGateState
          //     fires the showpilot:audio-gate-blocked event, audio
          //     stops within seconds. Independent mechanism.
          locationVerifyTimer = setInterval(async () => {
            const watcherFreshMs = Date.now() - lastWatcherInRangeMs;
            if (lastWatcherInRangeMs > 0 && watcherFreshMs < 6 * 60 * 1000) {
              // Watcher is alive and confirmed in-range recently. Skip
              // the server round trip.
              return;
            }
            const result = await window._ofVerifyLocationForAudio();
            if (!result.allowed) {
              stopAudio();
              // Categorize as 'proximity' — this fallback path exists
              // SPECIFICALLY to catch dead-watcher scenarios where the
              // user is likely out of range. A server-side block reason
              // (admin disabled show) gets surfaced through the 5-second
              // /api/visual-config poll independently. Keeping this as
              // 'proximity' preserves the auto-recover-on-return behavior
              // even when the fallback fires before the watcher does.
              applyAudioGateState(
                true,
                result.reason || 'Audio is no longer available.',
                'proximity'
              );
              statusEl.textContent = result.reason || 'Audio gate triggered.';
            }
          }, 5 * 60 * 1000);
        }
      } catch (err) {
        statusEl.textContent = 'Audio unavailable: ' + err.message;
      }
    }

    function teardown() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
      if (locationVerifyTimer) { clearInterval(locationVerifyTimer); locationVerifyTimer = null; }
      // Release the GPS subscription so the device can put the GPS chip
      // back to sleep. clearWatch is a no-op for null IDs but the guard
      // keeps the code symmetric with the other clearInterval calls.
      if (watchPositionId !== null) {
        try { navigator.geolocation.clearWatch(watchPositionId); } catch {}
        watchPositionId = null;
      }
      audioStartedAtMs = 0;
      lastWatcherInRangeMs = 0;

      // Clear a proximity latch on teardown — but only proximity, not
      // server. Reasoning:
      //
      // teardown() runs when the user closes the panel via the X button.
      // That's an explicit "I'm done with audio" signal. If they later
      // tap the launcher, the click-time fresh-location check is the
      // authoritative gate — they get blocked then if still out of range.
      //
      // BUT — if they were proximity-latched at the moment they closed
      // the panel, AND we keep the watcher dead (above), they have no
      // way to ever re-engage: the launcher button is hidden by the
      // latch's CSS class, so they can't even tap it. Clearing the
      // proximity latch here unblocks the launcher; if they're still
      // out of range, the click-time check still rejects them, so this
      // is safe.
      //
      // The 'server' latch (admin disabled show, etc.) is preserved
      // through teardown. Its purpose — preventing auto-resume after
      // an admin toggle — applies regardless of whether the panel was
      // closed in between.
      if (_gateLatchedBlocked === 'proximity') {
        _gateLatchedBlocked = null;
        const btn = document.getElementById('of-listen-btn');
        if (btn) btn.classList.remove('of-audio-gate-pending');
      }

      if (pendingStartTimeout) { clearTimeout(pendingStartTimeout); pendingStartTimeout = null; }
      if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; gainNode = null; }
      currentBuffer = null;
      prefetchPromise = null;
      prefetchedSeq = null;
      currentSequence = null;
      currentMediaName = null;
    }

    // ---- NTP-style clock sync (burst pings) ----
    //
    // Establishes accurate clock offset between this client and the server.
    // Without accurate sync, two phones aligning to "FPP position + elapsed
    // since update" will drift apart because each computes elapsed using
    // its own (skewed) Date.now(). The single-sample offset embedded in
    // now-playing-audio polls has 50-200ms of jitter from network variance;
    // burst sync improves this to ~10-20ms by:
    //   1. Firing N parallel pings to /api/time
    //   2. Recording (t_send_local, t_recv_local, t_server) for each
    //   3. Computing offset = t_server + rtt/2 - t_recv_local
    //   4. Discarding outlier RTTs (sort by rtt, keep best half)
    //   5. Averaging the offsets from the kept samples
    //
    // The "discard outliers" step is key — a single bad ping (network
    // hiccup, GC pause, etc.) would skew an unfiltered average by tens
    // of ms. PulseMesh's implementation does similar burst+filter logic
    // on a dedicated WebSocket; we use HTTP since we're not building a
    // separate connection just for this.
    let lastClockSyncAt = 0;
    async function syncClockBurst(burstSize = 5) {
      const samples = [];
      // Fire requests in PARALLEL — sequential would just sample at the
      // same network condition each time. Parallel exposes the variance
      // so outlier filtering can do its job.
      const promises = [];
      for (let i = 0; i < burstSize; i++) {
        promises.push((async () => {
          const t0 = Date.now();
          try {
            const r = await fetch('/api/time', { credentials: 'include', cache: 'no-store' });
            const t1 = Date.now();
            const data = await r.json();
            if (typeof data.t === 'number') {
              const rtt = t1 - t0;
              const oneWay = rtt / 2;
              const offset = data.t + oneWay - t1;
              samples.push({ rtt, offset });
            }
          } catch (e) {
            // Silently drop failed pings — we just have fewer samples.
          }
        })());
      }
      await Promise.all(promises);

      if (samples.length === 0) return; // bail if all failed
      // Sort by RTT ascending — lowest RTT samples have tightest one-way
      // latency estimate (network was quiet, less asymmetry to worry about).
      samples.sort((a, b) => a.rtt - b.rtt);
      // Keep the best half (or all if we have <4 samples).
      const keep = samples.length >= 4 ? samples.slice(0, Math.ceil(samples.length / 2)) : samples;
      // Use the MEDIAN offset from the kept samples, not the mean (v0.28.2).
      // On cellular networks, even after RTT-based outlier filtering, a
      // single sample can still be biased by event-loop lag or momentary
      // scheduling glitches on either end. Mean is sensitive to that one
      // bad sample; median ignores it. With 2-3 kept samples the median
      // and mean usually agree within a few ms; the win is when one of
      // the "best" samples is still a lemon.
      const offsets = keep.map(s => s.offset).sort((a, b) => a - b);
      const mid = Math.floor(offsets.length / 2);
      const medianOffset = offsets.length % 2 === 1
        ? offsets[mid]
        : (offsets[mid - 1] + offsets[mid]) / 2;

      clockOffset = medianOffset;
      lastClockSyncAt = Date.now();
    }

    async function syncOnce() {
      try {
        // Master audio kill-switch — admin disabled audio for this show.
        // No point polling /api/now-playing-audio: the server returns
        // {audioDisabled:true} and there's no launcher to drive anyway.
        // Bail to keep the network quiet on every viewer's tab.
        if (!boot.audioEnabled) return;

        // If the gate is latched (panel hidden, user kicked out for any
        // reason), don't keep polling for audio. The cached location may
        // be stale, audio might try to restart invisibly into a hidden
        // panel, and any way you slice it the user shouldn't hear music
        // they can't see the UI for. When the latch clears (proximity
        // latch lifts on return, server latch only clears on refresh),
        // polling resumes naturally on the next interval.
        if (_gateLatchedBlocked !== null) return;

        const reqStart = Date.now();
        const r = await fetch('/api/now-playing-audio' + locationQuery(), { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();
        const reqEnd = Date.now();

        // Server says viewer is outside the audio gate radius — stop audio
        // and signal the launcher to hide. /api/visual-config polling will
        // also pick this up but we react immediately when player is open.
        if (data.audioGateBlocked) {
          if (currentSource) stopAudio();
          applyAudioGateState(true, data.audioGateReason || '');
          return;
        }

        if (!data.playing || !data.hasAudio) {
          if (currentSource) stopAudio();
          titleEl.textContent = data.playing ? 'No audio for this sequence' : 'Show is not playing';
          artistEl.textContent = '';
          setupMarquee(titleEl, titleWrap);
          setupMarquee(artistEl, artistWrap);
          statusEl.textContent = '';
          pillText.textContent = 'Idle';
          return;
        }

        lastSyncResponse = data;

        // Update clock offset only if we haven't done a burst sync yet.
        // Burst sync (syncClockBurst) is much more accurate; once it's
        // run we leave clockOffset alone except for periodic refreshes.
        // This prevents the single-sample latency-jittered estimate from
        // overwriting our good measurement on every poll.
        if (lastClockSyncAt === 0) {
          const oneWayLatency = (reqEnd - reqStart) / 2;
          clockOffset = data.serverNowMs - reqEnd + oneWayLatency;
        }

        // Apply decoration theme (cheap — only does work if it changed)
        applyDecoration(data.playerDecoration, data.playerDecorationAnimated, data.playerCustomColor);

        // Track changed?
        if (data.sequenceName !== currentSequence) {
          handleTrackChange(data);
        } else {
          // Same track — just update timing anchor in case server has new info
          if (data.trackStartedAtMs) trackStartedAtMs = data.trackStartedAtMs;
          if (data.durationSec) trackDuration = data.durationSec;
          if (typeof data.audioSyncOffsetMs === 'number') audioSyncOffsetMs = data.audioSyncOffsetMs;
          // Refresh live position from response — covers the case where
          // the socket connection is down or hasn't pushed an update
          // since this poll arrived. Only accept if it matches our
          // current sequence (defensive against race-condition stale data).
          if (data.livePosition && data.livePosition.sequence === currentSequence) {
            livePosition = data.livePosition;
          }
          // Refresh metadata in case admin changed it
          if (data.imageUrl && coverEl.src !== data.imageUrl) coverEl.src = data.imageUrl;

          // Pre-fetch logic — could fetch upcoming tracks here in the future
        }

        // Update minimized pill text
        pillText.textContent = data.displayName || data.sequenceName || 'Playing';
      } catch (err) {
        console.warn('sync error', err);
      }
    }

    // ---- Track switch ----
    async function handleTrackChange(data) {
      currentSequence = data.sequenceName;
      currentMediaName = data.sequenceName;
      trackStartedAtMs = data.trackStartedAtMs || (Date.now() + clockOffset - (data.elapsedSec * 1000));
      trackDuration = data.durationSec || 0;
      if (typeof data.audioSyncOffsetMs === 'number') audioSyncOffsetMs = data.audioSyncOffsetMs;
      livePosition = (data.livePosition && data.livePosition.sequence === data.sequenceName)
        ? data.livePosition : null;

      titleEl.textContent = data.displayName || data.sequenceName;
      artistEl.textContent = data.artist || '';
      setupMarquee(titleEl, titleWrap);
      setupMarquee(artistEl, artistWrap);
      coverEl.src = data.imageUrl || '';
      coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
      statusEl.textContent = 'Loading audio…';
      setPlayIcon(false);

      stopAudio();

      // ---- HTML5 audio playback (v0.22.0+) ----
      // We switched away from Web Audio API (decodeAudioData + BufferSource)
      // because it pushed all timing burden onto each phone independently:
      // each phone bought its own audio clock, computed its own playback
      // position, and applied its own corrections — leading to phones
      // drifting from each OTHER even when each one was correctly synced
      // to FPP. HTML5 <audio src=...> hands timing to the browser, which
      // plays back at native 1.0x rate from a Range-seeked start point.
      // Two phones fetching the same source file at the same wall-clock
      // moment, seeked to the same position, drift apart only by their
      // network latency variance (a few tens of ms on LAN) — far better
      // than the multi-hundred-ms drift we saw with Web Audio scheduling.
      // Try the live relay first — one FPP connection fanned to all listeners
      // gives automatic sync without offset math. Connect directly with GET;
      // if the relay isn't active the server returns 503 and we fall back to
      // the cache path. No separate HEAD probe — that would open a dead
      // connection on the relay and stagger phone join times.
      // Source priority: relay (live sync) → cache (fallback)
      useRelay = false;

      try {
        if (htmlAudio) {
          try { htmlAudio.pause(); htmlAudio.src = ''; htmlAudio.load(); } catch {}
          htmlAudio = null;
        }

        useRelay = !!(data.relayActive && data.relayUrl);
        let chosenUrl = useRelay
          ? window.location.origin + data.relayUrl
          : (data.streamUrl ? window.location.origin + data.streamUrl : data.publicStreamUrl);

        if (!chosenUrl) {
          statusEl.textContent = 'No audio source available';
          return;
        }

        const a = new Audio();
        a.preload = 'auto';
        a.crossOrigin = 'anonymous';  // allow Web Audio to tap if we ever need it again
        a.src = chosenUrl;
        a.muted = isMuted;
        a.volume = 1;

        // Wait for enough data to play. For the relay (live stream, no
        // Content-Length) we use `canplay` immediately — `canplaythrough`
        // never fires on a stream because the browser can't know when
        // "through" is. For cached files we still prefer `canplaythrough`
        // (more conservative, avoids rebuffering) with a 3s fallback.
        await new Promise((resolve, reject) => {
          let settled = false;
          const onReady = () => { if (!settled) { settled = true; resolve(); } };
          const onErr = () => { if (!settled) { settled = true; reject(new Error('audio load failed')); } };
          if (useRelay) {
            // Live stream — canplay fires as soon as a few bytes arrive
            a.addEventListener('canplay', onReady, { once: true });
          } else {
            a.addEventListener('canplaythrough', onReady, { once: true });
            // Fallback to canplay if canplaythrough doesn't fire in 3s —
            // some browsers are stingy about firing it. Better to start
            // with less buffer than to never start.
            setTimeout(() => a.addEventListener('canplay', onReady, { once: true }), 3000);
          }
          a.addEventListener('error', onErr, { once: true });
          // Relay: long timeout — stream stays open for the whole song.
          // Cache: 15s is plenty for a file download.
          setTimeout(() => { if (!settled) { settled = true; reject(new Error('audio load timeout')); } }, useRelay ? 600000 : 15000);
        });

        // ---- Play immediately, correct after startup (v0.27.0) ----
        // Earlier versions tried to align phones by scheduling .play() at
        // the same wall-clock moment ~600ms in the future. That doesn't
        // work: even with perfectly synced clocks and identical seek
        // positions, the time between calling .play() and audio actually
        // leaving the speaker varies by 0-200ms per device per session
        // (decoder warmup, OS audio engine startup, buffer state). Two
        // phones aiming at the same scheduled moment land on it at
        // measurably different real moments and stay that distance apart
        // for the rest of the track — producing the constant offset that
        // listeners hear as an echo between car windows.
        //
        // Instead: every phone seeks to the expected position and plays
        // immediately. The startup latency error is unavoidable at this
        // step. Then ~1s later, after playback has stabilized, we measure
        // htmlAudio.currentTime against the expected position computed
        // from FPP's authoritative live-position channel, and seek-
        // correct the error in one shot. Because both phones are
        // correcting toward the same external reference (FPP), they
        // converge to within their measurement noise of FPP, and
        // therefore to within ~2x that noise of each other. Empirically
        // this is well under 100ms — below the threshold of perception
        // for synchronized music in adjacent cars.
        // Relay mode: don't seek. The stream starts at the current live
        // position already — seeking would break the connection. Just play.
        if (!useRelay) {
          const startPosition = getExpectedPosition();
          if (startPosition < 0) {
            a.currentTime = 0;
          } else if (a.duration && startPosition >= a.duration) {
            // Track will be over by the time we'd start. Track-change poll
            // will pick up the next sequence on its own.
            statusEl.textContent = 'Waiting for next track…';
            return;
          } else {
            a.currentTime = startPosition;
          }
        }

        // Set as active right before play so the drift loop's re-seek
        // correction doesn't compete with us during the post-start window.
        htmlAudio = a;

        if (useRelay) {
          // Relay mode: all phones schedule .play() at the same server-time moment.
          // Use the serverNowMs already in data — no extra fetch needed.
          // 1500ms window gives all phones time to buffer and reach this point.
          const myGeneration = playGeneration;
          const serverNow = data.serverNowMs || Date.now();
          const clockOff = serverNow - Date.now();
          const playAtClientMs = (serverNow + 1500) - clockOff;
          const waitMs = Math.max(0, playAtClientMs - Date.now());
          await new Promise(r => setTimeout(r, waitMs));
          if (playGeneration !== myGeneration) return; // cancelled
        }

        await a.play();
        pendingPostStartCorrectionAtMs = useRelay ? 0 : Date.now() + 1000;
        setPlayIcon(true);
        statusEl.textContent = '';
        if (audioStartedAtMs === 0) audioStartedAtMs = Date.now();
      } catch (err) {
        if (useRelay) {
          console.info('[ShowPilot] relay not ready yet, poll loop will retry');
          statusEl.textContent = 'Starting…';
          useRelay = false;
          currentSequence = null; // force poll loop to retry handleTrackChange
          return;
        }
        statusEl.textContent = 'Load failed: ' + (err.message || err);
        console.warn('[ShowPilot] HTML5 audio load failed:', err);
      }
    }

    // Fetch audio sequentially from a list of URLs, return the first successful
    // arrayBuffer.
    async function tryFetchAudio(urls) {
      let lastErr = null;
      for (const url of urls) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return await r.arrayBuffer();
        } catch (err) {
          lastErr = err;
          console.warn('[ShowPilot audio] fetch failed:', url, err.message);
        }
      }
      throw lastErr || new Error('No URLs to try');
    }

    // Compute the expected current playback position. This is the
    // single source of truth for "where SHOULD audio be right now."
    //
    // Two paths:
    //
    // 1. Live position (preferred) — when the plugin has pushed a
    //    recent FPP playback position via /api/plugin/position. The
    //    update has a server timestamp; we extrapolate forward from
    //    that point at native rate. Since this position came directly
    //    from FPP's seconds_played, it reflects what FPP's hardware
    //    audio output is actually doing, including buffer delay. Phones
    //    aligning to this number naturally match the speakers.
    //
    // 2. Track-start extrapolation (fallback) — older plugin or initial
    //    bootstrap before any position update has arrived. Uses the
    //    fixed trackStartedAtMs anchor and assumes audio has been
    //    progressing at native rate ever since. Less accurate over time
    //    because trackStartedAtMs is stamped at FPP's "I'm starting
    //    playback now" event, which precedes hardware audio emission
    //    by the FPP buffer delay (~200ms typical).
    //
    // The audioSyncOffsetMs adjustment is applied in BOTH paths but
    // serves different roles:
    //  - Path 1: usually 0 — FPP's seconds_played already accounts for
    //    its hardware audio path, so listeners hearing speakers will
    //    naturally match phone playback. Offset can still be used to
    //    deliberately bias if needed.
    //  - Path 2: typically positive — compensates for the buffer delay
    //    not reflected in trackStartedAtMs.
    //
    // Returns position in seconds. Caller decides what to do if value
    // is past the buffer duration (track ended).
    function getExpectedPosition() {
      const offsetSec = audioSyncOffsetMs / 1000;
      if (livePosition && livePosition.sequence === currentSequence) {
        // livePosition.updatedAt is a SERVER timestamp (Date.now() on
        // the server when FPP reported the position). To compute "how
        // long has it been since that update?" we have to express
        // current time on the same scale — i.e. server time. The
        // client's raw Date.now() is whatever its OS thinks the time
        // is, which can be off by hundreds of ms to several seconds
        // depending on the phone's NTP/cell-tower sync state. Two
        // phones with different clock biases here would see different
        // elapsed values and seek to different positions in the track,
        // producing exactly the constant phone-to-phone offset we're
        // trying to eliminate. clockOffset is computed by burst NTP-lite
        // on connect; adding it shifts client time onto server time.
        const serverNow = Date.now() + clockOffset;
        const elapsedSinceUpdate = (serverNow - livePosition.updatedAt) / 1000;
        return livePosition.position + elapsedSinceUpdate - offsetSec;
      }
      // Fallback: extrapolate from track-start anchor
      const serverNow = Date.now() + clockOffset;
      return (serverNow - trackStartedAtMs) / 1000 - offsetSec;
    }

    // ---- Schedule playback at sample-precise position ----
    function scheduleStart() {
      if (!currentBuffer || !audioCtx) return;
      stopAudio();

      // Where should we be in the track right now? Defer to
      // getExpectedPosition, which prefers live FPP-reported position
      // (speaker-accurate) and falls back to track-start extrapolation
      // (with offset applied) when no live position is available.
      const positionSec = getExpectedPosition();

      // If already past the end, skip — next sync will pick up new track
      if (positionSec >= currentBuffer.duration) {
        statusEl.textContent = 'Waiting for next track…';
        return;
      }

      // Schedule with small lead-in so we don't underrun
      const leadInSec = 0.05;
      const startWhen = audioCtx.currentTime + leadInSec;
      const startOffset = Math.max(0, positionSec + leadInSec);

      // Each source gets its own gain node so the crossfade correction
      // can ramp THIS source's volume independently. The main `gainNode`
      // (connected to destination) handles user mute/volume; this source
      // gain only handles sync transitions.
      const srcGain = audioCtx.createGain();
      srcGain.gain.value = 1;
      srcGain.connect(gainNode);

      const src = audioCtx.createBufferSource();
      src.buffer = currentBuffer;
      src.connect(srcGain);
      src.start(startWhen, startOffset);
      src.onended = () => {
        if (currentSource === src) { currentSource = null; setPlayIcon(false); }
      };
      currentSource = src;
      currentSourceGain = srcGain;
      // Reset crossfade throttle on fresh schedule — we're a new track,
      // any previous correction is irrelevant.
      lastCrossfadeAtCtx = 0;

      // Capture the drift-measurement anchors. Together with audioCtx.
      // currentTime at any later moment, these let updateDriftDisplay()
      // compute the actual playback position based on the AUDIO CLOCK
      // (which advances at exactly the rate of the audio output) rather
      // than wall time (which can drift relative to the audio clock,
      // especially on devices with crystal oscillator differences).
      trackScheduledAtAudioCtx = startWhen;
      trackScheduledAtPositionSec = startOffset;
      // Initialize integration counter — we've "played" startOffset seconds
      // into the file as of startWhen. Subsequent ticks accumulate from here.
      integratedPlayedSec = startOffset;
      lastIntegrationTime = startWhen;
      // outputLatency is the OS-reported delay between samples being
      // scheduled and samples actually leaving the speaker. We snapshot
      // it here so the drift display accounts for "what you HEAR now
      // was scheduled outputLatency seconds ago." Browsers without this
      // property fall back to baseLatency, then to 0.
      trackScheduledOutputLatency = (
        audioCtx.outputLatency
        || audioCtx.baseLatency
        || 0
      );

      // Mark when audio playback actually started. The watchPosition
      // grace period uses this to ignore the (frequently stale) first
      // watcher callback that fires immediately after audio begins.
      // Set on every track start — a multi-track session resets the
      // grace period each time, but that's fine since the user is by
      // definition still in range if a previous track played without
      // tripping the watcher.
      if (audioStartedAtMs === 0) audioStartedAtMs = Date.now();
      setPlayIcon(true);
      statusEl.textContent = '';
    }

    function stopAudio() {
      playGeneration++; // cancel any in-flight scheduled play
      if (currentSource) {
        try { currentSource.stop(); } catch {}
        try { currentSource.disconnect(); } catch {}
        currentSource = null;
      }
      if (currentSourceGain) {
        try { currentSourceGain.disconnect(); } catch {}
        currentSourceGain = null;
      }
      if (htmlAudio) {
        try { htmlAudio.pause(); } catch {}
        try { htmlAudio.src = ''; htmlAudio.load(); } catch {}
        htmlAudio = null;
      }
      // Clear drift anchors so updateDriftDisplay() bails until the
      // next track schedules new ones. Without this, the display would
      // keep drawing using stale anchors after stop().
      trackScheduledAtAudioCtx = 0;
      trackScheduledAtPositionSec = 0;
      trackScheduledOutputLatency = 0;
      // Reset auto-sync state so the next track starts fresh.
      lastAppliedRate = 1.0;
      driftHistory.length = 0;
      integratedPlayedSec = 0;
      lastIntegrationTime = 0;
      lastCrossfadeAtCtx = 0;
      lastReseekAtMs = 0;
      pendingPostStartCorrectionAtMs = 0;
    }

    // If the audio gate fires during playback (e.g. user walked outside the
    // radius and the next /api/visual-config poll reports blocked), stop audio
    // immediately. The launcher button is also hidden by applyAudioGateState.
    window.addEventListener('showpilot:audio-gate-blocked', () => {
      stopAudio();
      if (statusEl) statusEl.textContent = 'Audio paused — outside show range';
    });

    // ---- Drift display (real measurement) ----
    // Compares where audio is ACTUALLY playing (per the audio clock,
    // adjusted for output latency) to where it SHOULD be playing (per
    // server time). The difference is the real drift in milliseconds.
    //
    // Sign convention: positive = audio is AHEAD of server (audio came
    // out faster than expected); negative = audio is BEHIND (delayed).
    //
    // What this catches:
    //   - Initial sync error from asymmetric request/response latency
    //   - Audio clock drift over time (different oscillators)
    //   - Output latency that wasn't accounted for at scheduling
    //
    // What this does NOT catch:
    //   - Bluetooth/AirPods latency (hidden from the browser)
    //   - Receiver/DSP processing latency (downstream of OS audio)
    //   - Speaker physical placement delay (sound takes ~3ms per meter
    //     to travel — usually negligible, but two devices on opposite
    //     sides of a room can be 30-40ms apart just from physics)
    function updateDriftDisplay() {
      // In relay mode the browser's currentTime starts from 0 (time since
      // stream connected) while expected position is calculated from FPP's
      // started_at — completely different references. The number is meaningless
      // so just hide it rather than confuse the user.
      if (useRelay) {
        if (driftEl) driftEl.textContent = '';
        return;
      }
      // HTML5 audio path: compare element's currentTime to expected.
      // If we have no element or it's not far enough into playback to
      // measure meaningfully, clear the display and bail.
      if (!htmlAudio || htmlAudio.paused || !currentSequence) {
        if (driftEl) driftEl.textContent = '';
        return;
      }
      const actualPosition = htmlAudio.currentTime;
      const expectedPosition = getExpectedPosition();
      const drift = actualPosition - expectedPosition;
      const ms = Math.round(drift * 1000);
      driftEl.textContent = '· ' + (ms >= 0 ? '+' : '') + ms + 'ms';
      // Color thresholds: green <100ms, orange <500ms, red beyond.
      const absMs = Math.abs(ms);
      driftEl.style.color = absMs < 100 ? '#4ade80' : (absMs < 500 ? '#fb923c' : '#ef4444');

      // ---- One-shot post-start correction (v0.27.0, median-of-3 in v0.28.2) ----
      // Fires once, ~1s after .play() was called for the current track.
      // This is the moment of truth for multi-phone sync: the browser's
      // .play() startup latency has had time to settle, so the drift we
      // measure now reflects per-device startup error (the dominant
      // cause of phones being out of sync with each other and with the
      // show speakers). We snap-correct it in one move — no rolling
      // average, no throttle, tighter threshold than the long-tail loop.
      //
      // Median of 3 samples taken 25ms apart (v0.28.2): a single sample
      // can be biased by event-loop lag, momentary clock-sync glitches,
      // or jitter on the position-update channel — all amplified on
      // cellular. Median of 3 is robust to one outlier sample without
      // adding meaningful latency. The whole sampling window is ~50ms,
      // imperceptible.
      if (pendingPostStartCorrectionAtMs > 0 && Date.now() >= pendingPostStartCorrectionAtMs) {
        pendingPostStartCorrectionAtMs = 0;

        if (!useRelay) {
        const POST_START_THRESHOLD_MS = 80;
        // Capture the audio element handle so a stopAudio()/track-change
        // mid-sampling doesn't snap a stale element. If htmlAudio gets
        // reassigned during the 50ms window, we abort the snap.
        const audioForCorrection = htmlAudio;
        (async () => {
          const samples = [];
          for (let i = 0; i < 3; i++) {
            if (htmlAudio !== audioForCorrection) return; // track changed mid-sample, abort
            samples.push(audioForCorrection.currentTime - getExpectedPosition());
            if (i < 2) await new Promise(r => setTimeout(r, 25));
          }
          if (htmlAudio !== audioForCorrection) return; // track changed before snap, abort
          samples.sort((a, b) => a - b);
          const medianDrift = samples[1]; // middle of 3
          const medianMs = Math.round(medianDrift * 1000);
          if (Math.abs(medianMs) >= POST_START_THRESHOLD_MS) {
            const target = audioForCorrection.currentTime - medianDrift;
            if (target >= 0 && (!audioForCorrection.duration || target < audioForCorrection.duration - 0.1)) {
              try {
                audioForCorrection.currentTime = target;
                // Reset rolling history — the snap invalidated whatever
                // samples we had, and we want clean measurements going
                // forward for the long-tail loop.
                driftHistory.length = 0;
                // Update lastReseekAtMs so the long-tail loop respects its
                // own throttle relative to this snap (no double-correcting
                // a few seconds later).
                lastReseekAtMs = Date.now();
                if (typeof console !== 'undefined' && console.info) {
                  console.info('[ShowPilot] post-start correction:',
                    'startup error', medianMs, 'ms (median of 3),',
                    'samples', samples.map(s => Math.round(s * 1000) + 'ms').join(','),
                    'snapped to', target.toFixed(3), 's');
                }
              } catch (err) {
                console.warn('[ShowPilot] post-start correction failed:', err);
              }
            }
          }
        })();
        } // end !useRelay
      }

      // ---- Auto-correction via re-seek ----
      // HTML5 audio doesn't support smooth crossfade between sources
      // the way Web Audio did. The simplest correction is to set
      // currentTime directly when drift exceeds a generous threshold.
      // This produces a tiny audible blip (browser handles a brief
      // re-buffer) but it's preferable to letting drift accumulate.
      //
      // Skipped in relay mode — the relay delivers the same live bytes
      // to all listeners, seeking would break the stream.
      //
      // Tolerance is more generous than the Web Audio version because:
      // (1) every re-seek is audibly noticeable as a small pop, and
      // (2) HTML5 audio plays at native rate without rate jitter, so
      // small drift values tend to stay small instead of growing. We
      // expect this to fire rarely — mostly on track-start before live
      // position has been received, or after device sleep.
      driftHistory.push(drift);
      if (driftHistory.length > DRIFT_HISTORY_SIZE) driftHistory.shift();
      if (useRelay) return; // relay mode — no seeking, sync is automatic
      if (driftHistory.length < DRIFT_HISTORY_SIZE) return;

      const avgDrift = driftHistory.reduce((a, b) => a + b, 0) / driftHistory.length;
      const avgDriftMs = Math.abs(avgDrift) * 1000;
      const RESEEK_THRESHOLD_MS = 500;
      if (avgDriftMs < RESEEK_THRESHOLD_MS) return;

      // Throttle: don't re-seek more than once every 8 seconds.
      const RESEEK_THROTTLE_SEC = 8;
      const nowMs = Date.now();
      if (lastReseekAtMs > 0 && (nowMs - lastReseekAtMs) < RESEEK_THROTTLE_SEC * 1000) return;

      // Don't seek past end of track.
      if (htmlAudio.duration && expectedPosition >= htmlAudio.duration - 0.1) return;
      if (expectedPosition < 0) return;

      try {
        htmlAudio.currentTime = expectedPosition;
        lastReseekAtMs = nowMs;
        driftHistory.length = 0;
        if (typeof console !== 'undefined' && console.info) {
          console.info('[ShowPilot] sync correction (re-seek):',
            'drift was', Math.round(avgDriftMs), 'ms,',
            'snapped to', expectedPosition.toFixed(3), 's');
        }
      } catch (err) {
        console.warn('[ShowPilot] re-seek failed:', err);
      }
    }

    // ---- Player decoration ----
    let currentDecoration = null;
    let currentDecorationAnimated = null;
    let currentCustomColor = null;
    let decoLayer = null;

    function applyDecoration(theme, animated, customColor) {
      theme = theme || 'none';
      animated = (animated !== false);
      const customColorKey = customColor || '';
      if (theme === currentDecoration && animated === currentDecorationAnimated && customColorKey === currentCustomColor) return;
      currentDecoration = theme;
      currentDecorationAnimated = animated;
      currentCustomColor = customColorKey;

      // Update panel theme class — strip all existing of-theme-* and add new one
      panel.className = panel.className.split(/\s+/)
        .filter(c => !c.startsWith('of-theme-'))
        .join(' ').trim();
      // Clear any prior inline background overrides
      panel.style.removeProperty('background');
      panel.style.removeProperty('background-image');
      panel.style.removeProperty('background-color');
      if (theme !== 'none') {
        panel.classList.add('of-theme-' + theme);
      } else if (customColorKey) {
        // Custom color when no theme — must use !important to beat the CSS rule's !important.
        // Value is either a hex like "#1a1a2e" OR a CSS gradient like "linear-gradient(...)".
        // background-color only takes solid colors; gradients go in background-image.
        const isGradient = customColorKey.indexOf('gradient') >= 0;
        if (isGradient) {
          panel.style.setProperty('background-color', 'transparent', 'important');
          panel.style.setProperty('background-image', customColorKey, 'important');
        } else {
          panel.style.setProperty('background-image', 'none', 'important');
          panel.style.setProperty('background-color', customColorKey, 'important');
        }
      }
      // (else: leave defaults, base CSS rule applies)

      // Create overlay layer if missing.
      // Lives INSIDE the player bar (top:0, left:0, full width/height) so the
      // colored player background gives decorations contrast. overflow:visible
      // so animations like falling leaves can spill below the player edge.
      if (!decoLayer) {
        decoLayer = document.createElement('div');
        decoLayer.id = 'of-deco';
        decoLayer.style.cssText = `
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none; overflow: visible;
          z-index: 0;
        `;
        panel.style.position = panel.style.position || 'fixed';
        panel.style.overflow = 'visible';
        // Insert decoration as the FIRST child so player content sits on top
        panel.insertBefore(decoLayer, panel.firstChild);
      }

      // Honor user's prefers-reduced-motion at OS level
      const prefersReduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animate = animated && !prefersReduced;

      decoLayer.innerHTML = renderDecoration(theme, animate);
      // Reset panel padding-top in case previous decoration needed extra room
      panel.style.paddingTop = (theme === 'none') ? '12px' : '20px';

      // ---- Toast/banner theme inheritance (v0.24.4+) ----
      // Make the winner toast match the player's color palette by mapping
      // the player's CSS variables (--of-bg, --of-border, --of-glow) onto
      // the toast's variables (--showpilot-toast-*). Templates that set
      // their own --showpilot-toast-* vars in their CSS still win because
      // we only fill values that aren't already template-set.
      //
      // requestAnimationFrame waits one frame so the panel's computed
      // styles reflect the just-applied class change. Reading them
      // synchronously here would return the OLD theme's values.
      requestAnimationFrame(applyPlayerThemeToToast);
    }

    // Read the player panel's computed theme variables and propagate them
    // to the toast/banner CSS variables on :root. Idempotent — safe to call
    // multiple times. Only sets a toast variable if (a) the player has a
    // value for it AND (b) the toast variable isn't already set by the
    // template's own stylesheet (we check inline-style only, since
    // template-set values in stylesheets have lower specificity than
    // root.style and would get overridden silently if we always wrote).
    function applyPlayerThemeToToast() {
      try {
        const root = document.documentElement;
        const panelEl = document.getElementById('of-listen-panel');
        if (!panelEl) return;
        const cs = getComputedStyle(panelEl);

        // For custom solid/gradient colors (no theme class), the panel
        // has inline background-image/background-color rather than the
        // theme's --of-bg. Use whichever is actually rendering.
        const ofBg = (cs.getPropertyValue('--of-bg') || '').trim();
        const inlineImg = (panelEl.style.backgroundImage || '').trim();
        const inlineColor = (panelEl.style.backgroundColor || '').trim();
        const effectiveBg = inlineImg && inlineImg !== 'none'
          ? inlineImg
          : (inlineColor && inlineColor !== 'transparent' ? inlineColor : ofBg);

        const ofBorder = (cs.getPropertyValue('--of-border') || '').trim();
        const ofGlow = (cs.getPropertyValue('--of-glow') || '').trim();

        // Helper — set a toast var only if we have a player value AND
        // the user hasn't already explicitly set it (via inline root style).
        // Template-set CSS rules are NOT inline — they have lower
        // specificity and root.style overrides them, which is what we want
        // unless the template explicitly opted into theme-matching by
        // leaving the var unset. (Templates wanting custom colors should
        // use !important in their CSS to win against this.)
        const setIfPlayerHasValue = (varName, value) => {
          if (!value) return;
          root.style.setProperty(varName, value);
        };
        setIfPlayerHasValue('--showpilot-toast-bg', effectiveBg);
        setIfPlayerHasValue('--showpilot-toast-border', ofBorder);
        setIfPlayerHasValue('--showpilot-toast-accent', ofGlow);
      } catch (e) {
        // Non-fatal — toast just stays default-themed
      }
    }
    // Expose for the winner toast script (injected separately) so it can
    // re-apply on each toast render in case the theme changed since the
    // last appearance.
    window.ShowPilotApplyPlayerThemeToToast = applyPlayerThemeToToast;

    function renderDecoration(theme, animate) {
      const animClass = animate ? ' of-deco-animate' : '';
      switch (theme) {
        case 'christmas':       return christmasLights(animClass);
        case 'halloween':       return halloweenSpooky(animClass);
        case 'easter':          return easterEggs(animClass);
        case 'stpatricks':      return stPatricksClovers(animClass);
        case 'independence':    return independenceFireworks(animClass);
        case 'valentines':      return valentinesHearts(animClass);
        case 'hanukkah':        return hanukkahStars(animClass);
        case 'thanksgiving':    return thanksgivingLeaves(animClass);
        case 'snow':            return snowFall(animClass);
        default:                return '';
      }
    }

    // ---- Decoration renderers (each returns HTML string) ----

    function christmasLights(animClass) {
      // String of bulbs across the TOP edge of the player, hanging down slightly.
      // Wire sits at top:0 (player edge), bulbs hang from it into the player area.
      const colors = [
        { core: '#fff5f0', mid: '#ef4444', edge: '#7f1d1d' }, // red
        { core: '#fffbeb', mid: '#facc15', edge: '#854d0e' }, // gold
        { core: '#f0fdf4', mid: '#22c55e', edge: '#14532d' }, // green
        { core: '#eff6ff', mid: '#3b82f6', edge: '#1e3a8a' }, // blue
        { core: '#faf5ff', mid: '#a855f7', edge: '#581c87' }, // purple
      ];
      const count = 18;
      let bulbs = '';
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const c = colors[i % colors.length];
        const delay = ((i * 0.23) % 2.0).toFixed(2);
        const id = 'ofg' + i;
        bulbs += `
          <svg class="of-bulb${animClass}" viewBox="0 0 14 22" width="18" height="28"
               style="left:${left}%;animation-delay:${delay}s;--bulb-color:${c.mid};">
            <defs>
              <radialGradient id="${id}" cx="35%" cy="40%" r="60%">
                <stop offset="0%" stop-color="${c.core}"/>
                <stop offset="40%" stop-color="${c.mid}"/>
                <stop offset="100%" stop-color="${c.edge}"/>
              </radialGradient>
            </defs>
            <rect x="5" y="0" width="4" height="3" fill="#1f2937" rx="0.5"/>
            <rect x="4" y="2" width="6" height="2" fill="#374151"/>
            <ellipse cx="7" cy="13" rx="5" ry="7" fill="url(#${id})"/>
            <ellipse cx="5" cy="10" rx="1.5" ry="2.5" fill="rgba(255,255,255,0.6)"/>
          </svg>`;
      }
      return `
        <style>
          #of-deco .of-wire {
            position:absolute; top:6px; left:0; right:0; height:2px;
            background: linear-gradient(180deg, #1f2937 0%, #0f172a 100%);
            border-radius: 1px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.5);
          }
          #of-deco .of-bulb {
            position:absolute; top:0; transform:translateX(-50%);
            filter: drop-shadow(0 0 6px var(--bulb-color));
          }
          #of-deco .of-bulb.of-deco-animate {
            animation: ofTwinkle 1.6s ease-in-out infinite;
          }
          @keyframes ofTwinkle {
            0%, 100% { filter: drop-shadow(0 0 1px rgba(0,0,0,0)) brightness(0.55); }
            50%      { filter: drop-shadow(0 0 12px var(--bulb-color)) brightness(1.4); }
          }
        </style>
        <div class="of-wire"></div>
        ${bulbs}
      `;
    }

    function halloweenSpooky(animClass) {
      const batSvg = `
        <svg viewBox="0 0 40 24" width="42" height="25">
          <g fill="#0a0a0a">
            <ellipse cx="20" cy="14" rx="3.5" ry="4"/>
            <path class="of-wing-l" d="M 17,12 Q 8,6 0,8 Q 4,11 6,16 Q 2,18 4,22 Q 10,18 14,18 Q 17,18 17,16 Z"
                  style="transform-origin:17px 13px"/>
            <path class="of-wing-r" d="M 23,12 Q 32,6 40,8 Q 36,11 34,16 Q 38,18 36,22 Q 30,18 26,18 Q 23,18 23,16 Z"
                  style="transform-origin:23px 13px"/>
            <path d="M 18,10 L 17,7 L 19,9 Z M 22,10 L 23,7 L 21,9 Z"/>
            <circle cx="18.5" cy="13" r="0.6" fill="#dc2626"/>
            <circle cx="21.5" cy="13" r="0.6" fill="#dc2626"/>
          </g>
        </svg>`;
      const pumpkinSvg = `
        <svg viewBox="0 0 24 22" width="34" height="32">
          <defs>
            <radialGradient id="ofPump" cx="40%" cy="40%" r="60%">
              <stop offset="0%" stop-color="#fb923c"/>
              <stop offset="60%" stop-color="#ea580c"/>
              <stop offset="100%" stop-color="#7c2d12"/>
            </radialGradient>
          </defs>
          <path d="M 11,2 Q 11,5 12,5 Q 13,5 13,2 L 13,4 Q 14,3 15,4" stroke="#15803d" stroke-width="1.2" fill="none"/>
          <ellipse cx="6" cy="13" rx="4" ry="7" fill="url(#ofPump)" opacity="0.85"/>
          <ellipse cx="18" cy="13" rx="4" ry="7" fill="url(#ofPump)" opacity="0.85"/>
          <ellipse cx="12" cy="13" rx="6" ry="8" fill="url(#ofPump)"/>
          <path d="M 8,11 L 10,13 L 8,13 Z" fill="#fde047"/>
          <path d="M 16,11 L 14,13 L 16,13 Z" fill="#fde047"/>
          <path d="M 9,16 Q 12,18 15,16 L 14,17 L 13,16 L 12,17 L 11,16 L 10,17 Z" fill="#fde047"/>
        </svg>`;
      return `
        <style>
          #of-deco .of-bat {
            position:absolute; top:8px; left:-50px;
            filter: drop-shadow(0 0 5px rgba(168,85,247,0.7));
          }
          #of-deco .of-bat.of-deco-animate { animation: ofBatFly 9s linear infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-l { animation: ofWingL 0.25s ease-in-out infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-r { animation: ofWingR 0.25s ease-in-out infinite; }
          @keyframes ofBatFly {
            0%   { transform: translateX(0)    translateY(0)  scale(0.8); opacity:0; }
            5%   { opacity: 1; }
            25%  { transform: translateX(28vw) translateY(-6px) scale(0.95); }
            50%  { transform: translateX(55vw) translateY(8px)  scale(1.05); }
            75%  { transform: translateX(80vw) translateY(-4px) scale(0.95); }
            95%  { opacity: 1; }
            100% { transform: translateX(110vw) translateY(0)   scale(0.8); opacity:0; }
          }
          @keyframes ofWingL { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          @keyframes ofWingR { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          #of-deco .of-pumpkin {
            position:absolute; bottom:6px;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
          }
          #of-deco .of-pumpkin.left  { left: 8px;  }
          #of-deco .of-pumpkin.right { right: 8px; }
          #of-deco .of-pumpkin.of-deco-animate { animation: ofPumpBob 2.8s ease-in-out infinite; }
          @keyframes ofPumpBob {
            0%, 100% { transform: translateY(0) rotate(-5deg); }
            50%      { transform: translateY(-4px) rotate(5deg); }
          }
        </style>
        <span class="of-pumpkin left${animClass}">${pumpkinSvg}</span>
        <span class="of-pumpkin right${animClass}" style="animation-delay:1.4s;">${pumpkinSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:0s;">${batSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:3.2s;">${batSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:6.5s;">${batSvg}</span>
      `;
    }

    function easterEggs(animClass) {
      const eggColors = [
        { body: '#fbcfe8', stripe: '#ec4899' },
        { body: '#bae6fd', stripe: '#0284c7' },
        { body: '#bbf7d0', stripe: '#16a34a' },
        { body: '#fef08a', stripe: '#ca8a04' },
        { body: '#ddd6fe', stripe: '#7c3aed' },
      ];
      let html = `<style>
        #of-deco .of-egg {
          position:absolute; top:6px; transform:translateX(-50%);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        }
        #of-deco .of-egg.of-deco-animate { animation: ofEggWiggle 2.6s ease-in-out infinite; }
        @keyframes ofEggWiggle {
          0%,100% { transform: translateX(-50%) rotate(-12deg) translateY(0); }
          50%     { transform: translateX(-50%) rotate(12deg) translateY(-4px); }
        }
      </style>`;
      const count = 9;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const c = eggColors[i % eggColors.length];
        const delay = ((i * 0.32) % 2.6).toFixed(2);
        html += `
          <svg class="of-egg${animClass}" viewBox="0 0 12 16" width="22" height="28"
               style="left:${left}%;animation-delay:${delay}s;">
            <ellipse cx="6" cy="9" rx="5" ry="6.5" fill="${c.body}"/>
            <path d="M 1.5,8 Q 6,7 10.5,8" stroke="${c.stripe}" stroke-width="0.8" fill="none"/>
            <path d="M 1.5,11 Q 6,12 10.5,11" stroke="${c.stripe}" stroke-width="0.8" fill="none"/>
            <circle cx="4" cy="6" r="0.7" fill="${c.stripe}"/>
            <circle cx="8" cy="13" r="0.7" fill="${c.stripe}"/>
            <ellipse cx="4.5" cy="6" rx="1.5" ry="1.2" fill="rgba(255,255,255,0.5)"/>
          </svg>`;
      }
      return html;
    }

    function stPatricksClovers(animClass) {
      const cloverSvg = `
        <svg viewBox="0 0 16 16" width="22" height="22">
          <g fill="#16a34a" stroke="#14532d" stroke-width="0.4">
            <path d="M 8,8 Q 4,4 5,2 Q 7,1 8,4 Z"/>
            <path d="M 8,8 Q 12,4 11,2 Q 9,1 8,4 Z"/>
            <path d="M 8,8 Q 4,12 5,14 Q 7,15 8,12 Z"/>
            <path d="M 8,8 Q 12,12 11,14 Q 9,15 8,12 Z"/>
            <path d="M 8,12 L 9,16" stroke="#15803d" stroke-width="0.7"/>
          </g>
        </svg>`;
      let html = `<style>
        #of-deco .of-clover {
          position:absolute; top:8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 4px rgba(34,197,94,0.7));
        }
        #of-deco .of-clover.of-deco-animate { animation: ofCloverSpin 5s linear infinite; }
        @keyframes ofCloverSpin {
          0%   { transform: translateX(-50%) rotate(0deg)   scale(1); }
          50%  { transform: translateX(-50%) rotate(180deg) scale(1.15); }
          100% { transform: translateX(-50%) rotate(360deg) scale(1); }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 7 + (i * 86 / (count - 1));
        const delay = ((i * 0.5) % 5).toFixed(2);
        html += `<span class="of-clover${animClass}" style="left:${left}%;animation-delay:${delay}s;">${cloverSvg}</span>`;
      }
      return html;
    }

    function independenceFireworks(animClass) {
      const colors = ['#ef4444','#3b82f6','#ffffff','#facc15'];
      let html = `<style>
        #of-deco .of-burst {
          position:absolute; top:14px; width:50px; height:50px;
          transform:translateX(-50%);
        }
        #of-deco .of-burst .of-ray {
          position:absolute; top:50%; left:50%;
          width:24px; height:2px;
          transform-origin: 0 50%;
          border-radius: 1px;
        }
        #of-deco .of-burst.of-deco-animate { animation: ofBurst 2.6s ease-out infinite; }
        @keyframes ofBurst {
          0%   { transform: translateX(-50%) scale(0); opacity:1; }
          40%  { transform: translateX(-50%) scale(1); opacity:1; }
          100% { transform: translateX(-50%) scale(1.4); opacity:0; }
        }
      </style>`;
      const burstCount = 6;
      for (let b = 0; b < burstCount; b++) {
        const left = 8 + (b * 84 / (burstCount - 1));
        const color = colors[b % colors.length];
        const delay = ((b * 0.45) % 2.6).toFixed(2);
        let rays = '';
        for (let r = 0; r < 12; r++) {
          const angle = r * 30;
          rays += `<div class="of-ray" style="background:linear-gradient(90deg,${color},transparent);transform:translate(0,-50%) rotate(${angle}deg);box-shadow:0 0 6px ${color};"></div>`;
        }
        html += `<div class="of-burst${animClass}" style="left:${left}%;animation-delay:${delay}s;">${rays}</div>`;
      }
      return html;
    }

    function valentinesHearts(animClass) {
      const heartSvg = `
        <svg viewBox="0 0 16 14" width="22" height="20">
          <defs>
            <radialGradient id="ofHeart" cx="35%" cy="35%" r="65%">
              <stop offset="0%" stop-color="#fbcfe8"/>
              <stop offset="50%" stop-color="#ec4899"/>
              <stop offset="100%" stop-color="#9f1239"/>
            </radialGradient>
          </defs>
          <path d="M 8,13 C 8,13 1,8.5 1,4.5 C 1,2 2.8,1 4.5,1 C 6,1 7,2 8,3.5 C 9,2 10,1 11.5,1 C 13.2,1 15,2 15,4.5 C 15,8.5 8,13 8,13 Z"
                fill="url(#ofHeart)"/>
          <ellipse cx="5.5" cy="4" rx="1.5" ry="1" fill="rgba(255,255,255,0.5)"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-heart {
          position:absolute; top:8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 4px rgba(236,72,153,0.7));
        }
        #of-deco .of-heart.of-deco-animate { animation: ofHeartPulse 1.4s ease-in-out infinite; }
        @keyframes ofHeartPulse {
          0%, 100% { transform: translateX(-50%) scale(1); }
          50%      { transform: translateX(-50%) scale(1.3); }
        }
      </style>`;
      const count = 9;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.18) % 1.4).toFixed(2);
        html += `<span class="of-heart${animClass}" style="left:${left}%;animation-delay:${delay}s;">${heartSvg}</span>`;
      }
      return html;
    }

    function hanukkahStars(animClass) {
      const starSvg = `
        <svg viewBox="0 0 16 16" width="22" height="22">
          <defs>
            <linearGradient id="ofStar" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#dbeafe"/>
              <stop offset="50%" stop-color="#3b82f6"/>
              <stop offset="100%" stop-color="#1e3a8a"/>
            </linearGradient>
          </defs>
          <path d="M 8,1 L 14,12 L 2,12 Z" fill="url(#ofStar)" stroke="#1e3a8a" stroke-width="0.5"/>
          <path d="M 8,15 L 2,4 L 14,4 Z" fill="url(#ofStar)" stroke="#1e3a8a" stroke-width="0.5" opacity="0.85"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-hstar {
          position:absolute; top:8px; transform:translateX(-50%);
        }
        #of-deco .of-hstar.of-deco-animate { animation: ofStarShine 2.2s ease-in-out infinite; }
        @keyframes ofStarShine {
          0%, 100% { filter: drop-shadow(0 0 2px #60a5fa) brightness(0.9); }
          50%      { filter: drop-shadow(0 0 12px #60a5fa) brightness(1.3); }
        }
      </style>`;
      const count = 7;
      for (let i = 0; i < count; i++) {
        const left = 8 + (i * 84 / (count - 1));
        const delay = ((i * 0.35) % 2.2).toFixed(2);
        html += `<span class="of-hstar${animClass}" style="left:${left}%;animation-delay:${delay}s;">${starSvg}</span>`;
      }
      return html;
    }

    function thanksgivingLeaves(animClass) {
      const leafColors = ['#dc2626','#ea580c','#ca8a04','#78350f'];
      const leafSvg = (color) => `
        <svg viewBox="0 0 16 18" width="22" height="25">
          <path d="M 8,1 Q 5,3 5,5 Q 2,5 2,8 Q 4,9 4,11 Q 2,12 3,14 Q 5,14 6,15 L 8,17 L 10,15 Q 11,14 13,14 Q 14,12 12,11 Q 12,9 14,8 Q 14,5 11,5 Q 11,3 8,1 Z"
                fill="${color}" stroke="#451a03" stroke-width="0.4"/>
          <path d="M 8,17 L 8,5" stroke="#451a03" stroke-width="0.5"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-leaf {
          position:absolute; top:-6px; transform:translateX(-50%);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        }
        #of-deco .of-leaf.of-deco-animate { animation: ofLeafFall 6s ease-in-out infinite; }
        @keyframes ofLeafFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(-30deg); opacity:0; }
          15%  { opacity: 1; }
          50%  { transform: translateX(-30%) translateY(30px)  rotate(60deg);  opacity:0.9; }
          100% { transform: translateX(-70%) translateY(80px)  rotate(220deg); opacity:0; }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.7) % 6).toFixed(2);
        const color = leafColors[i % leafColors.length];
        html += `<span class="of-leaf${animClass}" style="left:${left}%;animation-delay:${delay}s;">${leafSvg(color)}</span>`;
      }
      return html;
    }

    function snowFall(animClass) {
      const flakeSvg = `
        <svg viewBox="0 0 14 14" width="18" height="18">
          <g stroke="#e0f2fe" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.95">
            <line x1="7" y1="1" x2="7" y2="13"/>
            <line x1="1" y1="7" x2="13" y2="7"/>
            <line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/>
            <line x1="2.5" y1="11.5" x2="11.5" y2="2.5"/>
            <path d="M 7,2 L 6,3 M 7,2 L 8,3"/>
            <path d="M 7,12 L 6,11 M 7,12 L 8,11"/>
            <path d="M 2,7 L 3,6 M 2,7 L 3,8"/>
            <path d="M 12,7 L 11,6 M 12,7 L 11,8"/>
          </g>
        </svg>`;
      let html = `<style>
        #of-deco .of-flake {
          position:absolute; top:-8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 3px rgba(255,255,255,0.7));
        }
        #of-deco .of-flake.of-deco-animate { animation: ofFlakeFall 7s linear infinite; }
        @keyframes ofFlakeFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(0); opacity:0; }
          15%  { opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translateX(-30%) translateY(85px) rotate(360deg); opacity:0; }
        }
      </style>`;
      const count = 14;
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const delay = ((i * 0.5) % 7).toFixed(2);
        const scale = (0.7 + ((i * 7) % 6) / 10).toFixed(2);
        html += `<span class="of-flake${animClass}" style="left:${left}%;animation-delay:${delay}s;transform:translateX(-50%) scale(${scale});">${flakeSvg}</span>`;
      }
      return html;
    }
  })();
})();
