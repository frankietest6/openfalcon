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

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  const MSG_IDS = {
    success: 'requestSuccessful',
    invalidLocation: 'invalidLocation',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
  };

  function showMessage(id, durationMs) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn('ShowPilot compat: no element with id', id);
      return;
    }
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, durationMs || 3000);
  }

  function mapErrorToId(error) {
    const msg = (error || '').toLowerCase();
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    return MSG_IDS.failed;
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
    if (hasVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      showMessage(MSG_IDS.success);
    } else {
      showMessage(mapErrorToId(result.data?.error));
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
      showMessage(mapErrorToId(result.data?.error));
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
      // First clear all existing counts to 0 so a removed vote drops visibly
      document.querySelectorAll('[data-seq-count]').forEach(el => {
        el.textContent = '0';
      });
      data.voteCounts.forEach(v => {
        const el = document.querySelector(`[data-seq-count="${v.sequence_name}"]`);
        if (el) el.textContent = v.count;
      });
    }

    // --- Reset "already voted" gate when a new round begins ---
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
    }

    // --- NOW_PLAYING text ---
    const nowEl = document.querySelector('.now-playing-text');
    if (nowEl) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      if (nowEl.textContent !== nowDisplay) nowEl.textContent = nowDisplay;
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
        queueListEl.textContent = 'Queue is empty.';
      } else {
        queueListEl.innerHTML = data.queue.map(e => {
          const seq = byName[e.sequence_name];
          const name = seq ? seq.display_name : e.sequence_name;
          return escapeHtml(name);
        }).join('<br />');
      }
    }

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated.
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
    // so templates from earlier versions keep working.
    document.querySelectorAll('[data-showpilot-container="jukebox"], [data-openfalcon-container="jukebox"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'JUKEBOX' ? '' : 'none';
    });
    document.querySelectorAll('[data-showpilot-container="voting"], [data-openfalcon-container="voting"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'VOTING' ? '' : 'none';
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
      socket.on('voteReset', () => { hasVoted = false; refreshState(); });
      socket.on('sequencesReordered', () => refreshState()); // covers updated, sequences edited, etc.
      socket.on('sequencesSynced', () => refreshState());
    }
  } catch {}

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
  // PAGE-WIDE SNOW — gently falling snowflakes across the viewer page
  // Toggleable live via admin Viewer Page tab — polls /api/visual-config
  // every 5 seconds and creates/destroys the snow layer accordingly.
  // pointer-events:none so it doesn't block clicks. Auto-disabled when
  // prefers-reduced-motion is set at the OS level.
  // ============================================================
  (function initPageSnow() {
    const prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return; // nothing we can do — respect the setting always

    let snowLayer = null;
    let snowStyleEl = null;

    // CSS keyframes go in once and stay (no harm leaving them present)
    function ensureSnowStyle() {
      if (snowStyleEl) return;
      snowStyleEl = document.createElement('style');
      snowStyleEl.textContent = `
        @keyframes ofPageSnowFall {
          0%   { transform: translateY(-30px) rotate(0deg); }
          100% { transform: translateY(105vh) rotate(360deg); }
        }
        @keyframes ofPageSnowSway {
          0%   { margin-left: 0; }
          100% { margin-left: var(--of-sway); }
        }
      `;
      document.head.appendChild(snowStyleEl);
    }

    function startSnow() {
      if (snowLayer) return; // already running
      ensureSnowStyle();
      snowLayer = document.createElement('div');
      snowLayer.id = 'of-page-snow';
      snowLayer.setAttribute('aria-hidden', 'true');
      snowLayer.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        pointer-events: none; z-index: 9990; overflow: hidden;
      `;
      const flakeSvg = `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#ffffff" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.9">
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
      const flakeCount = 50;
      for (let i = 0; i < flakeCount; i++) {
        const flake = document.createElement('div');
        const size = 8 + Math.random() * 14;
        const left = Math.random() * 100;
        const duration = 8 + Math.random() * 10;
        const delay = -Math.random() * duration;
        const sway = 20 + Math.random() * 40;
        const opacity = 0.4 + Math.random() * 0.5;
        flake.style.cssText = `
          position: absolute;
          left: ${left}vw;
          top: -30px;
          width: ${size}px;
          height: ${size}px;
          opacity: ${opacity};
          filter: drop-shadow(0 0 2px rgba(255,255,255,0.4));
          animation: ofPageSnowFall ${duration}s linear infinite,
                     ofPageSnowSway ${duration / 2}s ease-in-out infinite alternate;
          animation-delay: ${delay}s, ${delay}s;
          --of-sway: ${sway}px;
        `;
        flake.innerHTML = flakeSvg;
        snowLayer.appendChild(flake);
      }
      document.body.appendChild(snowLayer);
    }

    function stopSnow() {
      if (!snowLayer) return;
      snowLayer.remove();
      snowLayer = null;
    }

    // Apply server-provided state
    function applySnowState(enabled) {
      if (enabled) startSnow();
      else stopSnow();
    }

    // Apply initial state from bootstrap (no flicker on first load if enabled)
    const bootstrap = window.__SHOWPILOT__ || {};
    applySnowState(bootstrap.pageSnowEnabled);

    // Expose so the unified visual-config poll (below) can drive snow updates
    window._ofApplySnowState = applySnowState;
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
          if (typeof window._ofApplySnowState === 'function') {
            window._ofApplySnowState(!!data.pageSnowEnabled);
          }
          applyAudioGateState(!!data.audioGateBlocked, data.audioGateReason || '');
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
    const btn = document.createElement('button');
    btn.id = 'of-listen-btn';
    btn.setAttribute('aria-label', 'Listen on phone');
    btn.title = 'Listen on phone';
    btn.innerHTML = '🎧';
    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(220,38,38,0.95); color: white;
      border: 2px solid rgba(255,255,255,0.4);
      font-size: 24px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: transform 0.15s, background 0.15s, opacity 0.2s;
      padding: 0; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    `;
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
      if (currentSource) {
        // Stop and re-sync from current position
        stopAudio();
        statusEl.textContent = 'Resuming…';
        setPlayIcon(false);
        // Re-sync will start it back up
        syncOnce();
      } else if (currentBuffer) {
        // Was paused — restart with current sync
        scheduleStart();
      }
    };
    muteBtn.onclick = () => {
      isMuted = !isMuted;
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
        if (!audioCtx) startup();
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
        await syncOnce();
        // Re-sync periodically — once per second is enough since track-start
        // anchoring means we don't need continuous position updates.
        pollTimer = setInterval(syncOnce, 1000);
        // Drift correction loop (cheap — just compares client clock to expected)
        driftTimer = setInterval(updateDriftDisplay, 250);

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

    // ---- Sync poll ----
    async function syncOnce() {
      try {
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

        // Clock offset: account for half the round-trip as one-way latency
        const oneWayLatency = (reqEnd - reqStart) / 2;
        clockOffset = data.serverNowMs - reqEnd + oneWayLatency;

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

      titleEl.textContent = data.displayName || data.sequenceName;
      artistEl.textContent = data.artist || '';
      setupMarquee(titleEl, titleWrap);
      setupMarquee(artistEl, artistWrap);
      coverEl.src = data.imageUrl || '';
      coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
      statusEl.textContent = 'Loading audio…';
      setPlayIcon(false);

      stopAudio();

      // ---- Pick stream URL ----
      // Audio is served exclusively by the ShowPilot proxy, which fetches
      // bytes from FPP's built-in /api/file/Music/<n> endpoint. There's no
      // separate "direct" path anymore — we previously had a Node.js audio
      // daemon running on FPP that this client raced against the proxy, but
      // it added complexity for a benefit that turned out to be imperceptible
      // (the proxy adds a few ms over LAN, undetectable in practice).
      //
      // We try the same-origin proxy URL first, fall back to the public URL
      // (absolute, via configured public domain). This handles cases where
      // the page was loaded from a cached HTML and the origin is briefly
      // unreachable but the public domain is still up.
      const urlsToTry = [];
      if (data.streamUrl) urlsToTry.push(window.location.origin + data.streamUrl);
      if (data.publicStreamUrl) urlsToTry.push(data.publicStreamUrl);

      if (urlsToTry.length === 0) {
        statusEl.textContent = 'No audio source';
        return;
      }

      try {
        statusEl.textContent = 'Downloading…';
        const arrayBuf = await tryFetchAudio(urlsToTry);
        if (!arrayBuf) throw new Error('All audio sources failed');

        statusEl.textContent = 'Decoding…';
        currentBuffer = await audioCtx.decodeAudioData(arrayBuf);
        statusEl.textContent = 'Syncing…';
        scheduleStart();
      } catch (err) {
        statusEl.textContent = 'Load failed: ' + err.message;
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

    // ---- Schedule playback at sample-precise position ----
    function scheduleStart() {
      if (!currentBuffer || !audioCtx) return;
      stopAudio();

      // Where should we be in the track right now (server time)?
      // We also subtract the configured audio-sync offset:
      //   positive offset = "play audio LATER" (because audio was arriving
      //                      ahead of the lights — typical case after the
      //                      cache change, since cache is faster than the
      //                      old FPP-proxy path)
      //   negative offset = "play audio EARLIER"
      // Subtracting offset/1000 from positionSec means we believe we're
      // less far through the track than wall-clock suggests, so the
      // playback start_offset is smaller, and the audio plays from an
      // earlier point in the file — which the listener experiences as
      // "audio arrived later" relative to wherever it would have been.
      const serverNow = Date.now() + clockOffset;
      const positionSec = (serverNow - trackStartedAtMs) / 1000 - (audioSyncOffsetMs / 1000);

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
      if (currentSource) {
        try { currentSource.stop(); } catch {}
        try { currentSource.disconnect(); } catch {}
        currentSource = null;
      }
      if (currentSourceGain) {
        try { currentSourceGain.disconnect(); } catch {}
        currentSourceGain = null;
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
      if (!currentSource || !audioCtx || !trackStartedAtMs || !trackScheduledAtAudioCtx) {
        if (driftEl) driftEl.textContent = '';
        return;
      }
      // Integrate playback position. Since the last drift tick, real time
      // has advanced by (now - lastIntegrationTime) seconds. During that
      // span, the audio file's playback position advanced by that amount
      // multiplied by the rate we WERE applying (lastAppliedRate). This
      // is the only correct way to compute file position when rate varies.
      const now = audioCtx.currentTime;
      const realDt = now - lastIntegrationTime;
      if (realDt > 0) {
        integratedPlayedSec += realDt * lastAppliedRate;
        lastIntegrationTime = now;
      }
      // actualPosition is the file position currently emitting from the
      // speaker. Subtract output latency: "the sample HEARD now was
      // scheduled outputLatency seconds ago, so the file position emitted
      // now corresponds to a slightly earlier point."
      const actualPosition = integratedPlayedSec - trackScheduledOutputLatency;

      // Where SHOULD it be per server time?
      // The audioSyncOffsetMs adjusts the target — positive means we
      // want audio to lag the wall clock by that much, so the "expected"
      // position on the audio clock is correspondingly earlier.
      const serverNow = Date.now() + clockOffset;
      const expectedPosition = (serverNow - trackStartedAtMs) / 1000 - (audioSyncOffsetMs / 1000);

      // Drift in seconds. Positive = audio AHEAD of where it should be.
      const drift = actualPosition - expectedPosition;
      const ms = Math.round(drift * 1000);
      driftEl.textContent = '· ' + (ms >= 0 ? '+' : '') + ms + 'ms';
      // Color thresholds: green <100ms, orange <500ms, red beyond.
      const absMs = Math.abs(ms);
      driftEl.style.color = absMs < 100 ? '#4ade80' : (absMs < 500 ? '#fb923c' : '#ef4444');

      // ---- Auto-sync via crossfade jump-cut ----
      //
      // Replaces continuous playback rate adjustment, which had two
      // problems: (1) accumulating math errors when rate * time
      // integration was even slightly off, causing slow runaway drift,
      // and (2) audible pitch shifts during corrections.
      //
      // The new approach: when smoothed drift exceeds the threshold,
      // we kill the current source with a fast fade-out and start a
      // brand-new source at the corrected position with a fade-in.
      // The crossfade is short enough (~40ms) that listeners don't
      // perceive it as a discontinuity, but the position snaps to
      // truth instantly. Same pattern Sonos / multi-room audio uses.
      //
      // Throttling: we won't run another correction for several seconds
      // after one fires. Without throttle, jitter near the threshold
      // would chain crossfades back-to-back, sounding awful and never
      // actually converging.
      driftHistory.push(drift);
      if (driftHistory.length > DRIFT_HISTORY_SIZE) driftHistory.shift();
      if (driftHistory.length < DRIFT_HISTORY_SIZE) return;

      const avgDrift = driftHistory.reduce((a, b) => a + b, 0) / driftHistory.length;
      const avgDriftMs = Math.abs(avgDrift) * 1000;

      // Threshold tuning notes:
      //   - 200ms is well above per-tick jitter (~50-100ms) so we don't
      //     trigger on noise.
      //   - 200ms is close to the perception threshold for music sync
      //     vs. a separate audio source (i.e. listeners start to notice).
      //   - PulseMesh logs we observed showed corrections happening at
      //     ~700ms, suggesting their threshold may be even higher. We're
      //     more aggressive — better tight sync, accepting more frequent
      //     correction events.
      const CORRECTION_THRESHOLD_MS = 200;
      if (avgDriftMs < CORRECTION_THRESHOLD_MS) return;

      // Throttle: don't crossfade more than once every N seconds. Gives
      // the audio engine time to stabilize after the previous correction
      // and prevents thrashing if jitter spans the threshold.
      const CROSSFADE_THROTTLE_SEC = 5;
      const nowCtx = audioCtx.currentTime;
      if (lastCrossfadeAtCtx > 0 && (nowCtx - lastCrossfadeAtCtx) < CROSSFADE_THROTTLE_SEC) return;

      // Compute the corrected file position — where we SHOULD be right
      // now according to the server. The new source will start playing
      // from this offset, with a small lead-in to allow scheduling.
      const correctionLeadInSec = 0.04;  // ~40ms ahead of "now"
      const newSourceStartWhen = nowCtx + correctionLeadInSec;
      // expectedPosition is "where we should be now"; add the lead-in
      // so when the new source actually starts playing, it's at the
      // right spot for THAT moment.
      const newSourceStartOffset = Math.max(0, expectedPosition + correctionLeadInSec);

      // If the corrected position is past the end of the buffer, the
      // track is essentially over. Don't crossfade — let the natural
      // track-change flow handle it.
      if (!currentBuffer || newSourceStartOffset >= currentBuffer.duration - 0.1) return;

      try {
        // Build the new source + gain (start at 0, ramp up).
        const newGain = audioCtx.createGain();
        newGain.gain.value = 0;
        newGain.connect(gainNode);
        const newSrc = audioCtx.createBufferSource();
        newSrc.buffer = currentBuffer;
        newSrc.connect(newGain);
        // Schedule new source's gain ramp: 0 → 1 over the crossfade window
        const fadeMs = 40;
        const fadeSec = fadeMs / 1000;
        newGain.gain.setValueAtTime(0, newSourceStartWhen);
        newGain.gain.linearRampToValueAtTime(1, newSourceStartWhen + fadeSec);
        // Start playback at corrected position
        newSrc.start(newSourceStartWhen, newSourceStartOffset);
        newSrc.onended = () => {
          if (currentSource === newSrc) { currentSource = null; setPlayIcon(false); }
        };

        // Schedule the OLD source's gain ramp: 1 → 0 over the same window
        const oldSrc = currentSource;
        const oldGain = currentSourceGain;
        if (oldGain) {
          // Cancel any pending gain automation so our new ramp wins.
          oldGain.gain.cancelScheduledValues(nowCtx);
          oldGain.gain.setValueAtTime(oldGain.gain.value, newSourceStartWhen);
          oldGain.gain.linearRampToValueAtTime(0, newSourceStartWhen + fadeSec);
        }
        // Stop+disconnect the old source AFTER the fade completes.
        // Using setTimeout against wall time + a tiny safety margin
        // since AudioContext doesn't expose a direct "run callback at
        // audio time T" API. We accept ~5-10ms of slop here; the gain
        // is 0 by then so listener can't hear anything anyway.
        const cleanupDelayMs = (correctionLeadInSec + fadeSec) * 1000 + 20;
        setTimeout(() => {
          if (oldSrc) {
            try { oldSrc.stop(); } catch {}
            try { oldSrc.disconnect(); } catch {}
          }
          if (oldGain) {
            try { oldGain.disconnect(); } catch {}
          }
        }, cleanupDelayMs);

        // Update tracking pointers to the NEW source. Drift integration
        // restarts from the corrected position. This is the "snap" — by
        // the time the next drift tick fires, integratedPlayedSec is
        // freshly anchored at expectedPosition (modulo lead-in), and
        // drift will read near zero.
        currentSource = newSrc;
        currentSourceGain = newGain;
        trackScheduledAtAudioCtx = newSourceStartWhen;
        trackScheduledAtPositionSec = newSourceStartOffset;
        integratedPlayedSec = newSourceStartOffset;
        lastIntegrationTime = newSourceStartWhen;
        lastCrossfadeAtCtx = nowCtx;
        // Clear the drift history so the next averaging window is built
        // fresh from post-correction samples (mixing pre- and post-
        // correction drift values would average toward zero artificially
        // and could suppress a follow-up correction that's actually needed).
        driftHistory.length = 0;

        // Diagnostic log — kept low-volume so it's not noisy in normal
        // operation. Useful for verifying corrections are happening.
        if (typeof console !== 'undefined' && console.info) {
          console.info('[ShowPilot] sync correction:',
            'drift was', Math.round(avgDriftMs), 'ms,',
            'snapped to position', newSourceStartOffset.toFixed(3), 's');
        }
      } catch (err) {
        console.warn('[ShowPilot] crossfade correction failed:', err);
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
    }

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
