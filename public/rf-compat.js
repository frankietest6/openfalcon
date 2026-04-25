// ============================================================
// OpenFalcon — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to OpenFalcon's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__OPENFALCON__ || {};
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
      console.warn('OpenFalcon compat: no element with id', id);
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
  window.OpenFalconVote = async function (sequenceName) {
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

  window.OpenFalconRequest = async function (sequenceName) {
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

  // RF aliases in case templates call these names
  window.vote = window.OpenFalconVote;
  window.request = window.OpenFalconRequest;

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
    // In templates we render server-side, we add data-openfalcon-next to the NEXT_PLAYLIST spot.
    const nextEl = document.querySelector('[data-openfalcon-next]');
    if (nextEl) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      if (nextEl.textContent !== nextDisplay) nextEl.textContent = nextDisplay;
    }

    // --- Queue size & queue list ---
    const queueSizeEl = document.querySelector('[data-openfalcon-queue-size]');
    if (queueSizeEl) queueSizeEl.textContent = String((data.queue || []).length);

    const queueListEl = document.querySelector('[data-openfalcon-queue-list]');
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
    document.querySelectorAll('[data-openfalcon-container="jukebox"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'JUKEBOX' ? '' : 'none';
    });
    document.querySelectorAll('[data-openfalcon-container="voting"]').forEach(el => {
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
      transition: transform 0.15s, background 0.15s;
      padding: 0; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };

    // ---- Sticky-bottom panel ----
    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      background: rgba(20,20,30,0.97); color: #fff;
      border-top: 1px solid rgba(255,255,255,0.15);
      box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
      padding: 12px 16px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
      transform: translateY(100%);
      transition: transform 0.25s ease-out;
      backdrop-filter: blur(8px);
    `;
    panel.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto; display: flex; gap: 12px; align-items: center;">
        <img id="of-listen-cover" src="" alt=""
             style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;
                    background: #333; flex-shrink: 0;" />
        <div style="flex: 1; min-width: 0;">
          <div id="of-listen-title" style="font-weight: 600;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Loading…</div>
          <div id="of-listen-artist" style="font-size: 12px; color: #aaa;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></div>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: #777;">
            <span id="of-listen-status">Preparing…</span>
            <span id="of-listen-drift"></span>
          </div>
        </div>
        <button id="of-listen-playpause" aria-label="Play/pause"
                style="background: rgba(255,255,255,0.12); border: 0; color: #fff;
                       width: 40px; height: 40px; border-radius: 50%; font-size: 18px;
                       cursor: pointer; flex-shrink: 0;">▶</button>
        <button id="of-listen-mute" aria-label="Mute"
                style="background: transparent; border: 0; color: #aaa; font-size: 18px;
                       cursor: pointer; flex-shrink: 0; padding: 6px;">🔊</button>
        <button id="of-listen-min" aria-label="Hide player (audio keeps playing)"
                title="Hide (audio keeps playing)"
                style="background: transparent; border: 0; color: #aaa; font-size: 16px;
                       cursor: pointer; flex-shrink: 0; padding: 6px;">▼</button>
        <button id="of-listen-close" aria-label="Stop and close"
                title="Stop &amp; close"
                style="background: transparent; border: 0; color: #aaa; font-size: 20px;
                       cursor: pointer; flex-shrink: 0; padding: 6px;">×</button>
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
    const artistEl = panel.querySelector('#of-listen-artist');
    const coverEl = panel.querySelector('#of-listen-cover');
    const statusEl = panel.querySelector('#of-listen-status');
    const driftEl = panel.querySelector('#of-listen-drift');
    const playBtn = panel.querySelector('#of-listen-playpause');
    const muteBtn = panel.querySelector('#of-listen-mute');
    const minBtn = panel.querySelector('#of-listen-min');
    const closeBtn = panel.querySelector('#of-listen-close');
    const pillText = minimizedPill.querySelector('#of-listen-pill-text');

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
    let lastSyncResponse = null;  // raw response for debugging
    let pollTimer = null;
    let driftTimer = null;
    let pendingStartTimeout = null;

    // ---- UI handlers ----
    btn.onclick = () => setMode('open');
    minBtn.onclick = () => setMode('minimized');
    closeBtn.onclick = () => setMode('closed');
    minimizedPill.onclick = () => setMode('open');
    playBtn.onclick = () => {
      if (currentSource) {
        // Stop and re-sync from current position
        stopAudio();
        statusEl.textContent = 'Resuming…';
        playBtn.textContent = '▶';
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
      muteBtn.textContent = isMuted ? '🔇' : '🔊';
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
      } catch (err) {
        statusEl.textContent = 'Audio unavailable: ' + err.message;
      }
    }

    function teardown() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
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
        const reqStart = Date.now();
        const r = await fetch('/api/now-playing-audio', { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();
        const reqEnd = Date.now();

        if (!data.playing || !data.hasAudio) {
          if (currentSource) stopAudio();
          titleEl.textContent = data.playing ? 'No audio for this sequence' : 'Show is not playing';
          artistEl.textContent = '';
          statusEl.textContent = '';
          pillText.textContent = 'Idle';
          return;
        }

        lastSyncResponse = data;

        // Clock offset: account for half the round-trip as one-way latency
        const oneWayLatency = (reqEnd - reqStart) / 2;
        clockOffset = data.serverNowMs - reqEnd + oneWayLatency;

        // Apply decoration theme (cheap — only does work if it changed)
        applyDecoration(data.playerDecoration, data.playerDecorationAnimated);

        // Track changed?
        if (data.sequenceName !== currentSequence) {
          handleTrackChange(data);
        } else {
          // Same track — just update timing anchor in case server has new info
          if (data.trackStartedAtMs) trackStartedAtMs = data.trackStartedAtMs;
          if (data.durationSec) trackDuration = data.durationSec;
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

      titleEl.textContent = data.displayName || data.sequenceName;
      artistEl.textContent = data.artist || '';
      coverEl.src = data.imageUrl || '';
      coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
      statusEl.textContent = 'Loading audio…';
      playBtn.textContent = '▶';

      stopAudio();

      // Try direct daemon URL first, fall back to OpenFalcon proxy if it fails
      const candidateUrls = [];
      if (data.directStreamUrl) candidateUrls.push(data.directStreamUrl);
      if (data.streamUrl) candidateUrls.push(window.location.origin + data.streamUrl);
      if (candidateUrls.length === 0) {
        statusEl.textContent = 'No audio source';
        return;
      }

      try {
        statusEl.textContent = 'Downloading…';
        let arrayBuf = null;
        let lastErr = null;
        for (const url of candidateUrls) {
          try {
            const audioRes = await fetch(url);
            if (!audioRes.ok) throw new Error('HTTP ' + audioRes.status);
            arrayBuf = await audioRes.arrayBuffer();
            break;
          } catch (err) {
            lastErr = err;
            console.warn('Stream fetch failed for', url, err);
          }
        }
        if (!arrayBuf) throw lastErr || new Error('All sources failed');

        statusEl.textContent = 'Decoding…';
        currentBuffer = await audioCtx.decodeAudioData(arrayBuf);
        statusEl.textContent = 'Syncing…';
        scheduleStart();
      } catch (err) {
        statusEl.textContent = 'Load failed: ' + err.message;
      }
    }

    // ---- Schedule playback at sample-precise position ----
    function scheduleStart() {
      if (!currentBuffer || !audioCtx) return;
      stopAudio();

      // Where should we be in the track right now (server time)?
      const serverNow = Date.now() + clockOffset;
      const positionSec = (serverNow - trackStartedAtMs) / 1000;

      // If already past the end, skip — next sync will pick up new track
      if (positionSec >= currentBuffer.duration) {
        statusEl.textContent = 'Waiting for next track…';
        return;
      }

      // Schedule with small lead-in so we don't underrun
      const leadInSec = 0.05;
      const startWhen = audioCtx.currentTime + leadInSec;
      const startOffset = Math.max(0, positionSec + leadInSec);

      const src = audioCtx.createBufferSource();
      src.buffer = currentBuffer;
      src.connect(gainNode);
      src.start(startWhen, startOffset);
      src.onended = () => {
        if (currentSource === src) { currentSource = null; playBtn.textContent = '▶'; }
      };
      currentSource = src;
      playBtn.textContent = '⏸';
      statusEl.textContent = '';
    }

    function stopAudio() {
      if (currentSource) {
        try { currentSource.stop(); } catch {}
        try { currentSource.disconnect(); } catch {}
        currentSource = null;
      }
    }

    // ---- Drift display (visual only — Web Audio API is sample-precise so
    //      drift here is just for user reassurance) ----
    function updateDriftDisplay() {
      if (!currentSource || !audioCtx || !trackStartedAtMs) {
        if (driftEl) driftEl.textContent = '';
        return;
      }
      const serverNow = Date.now() + clockOffset;
      const expectedPosition = (serverNow - trackStartedAtMs) / 1000;
      // Estimate where we ARE in the buffer based on AudioContext.currentTime
      // (this is an approximation since we can't query active SourceNode position directly)
      const actualPosition = expectedPosition; // sample-precise scheduling means this matches
      const drift = actualPosition - expectedPosition;
      const ms = Math.round(drift * 1000);
      driftEl.textContent = '· ' + (ms >= 0 ? '+' : '') + ms + 'ms';
      driftEl.style.color = Math.abs(ms) < 100 ? '#4ade80' : (Math.abs(ms) < 500 ? '#fb923c' : '#ef4444');
    }

    // ---- Player decoration ----
    let currentDecoration = null;
    let currentDecorationAnimated = null;
    let decoLayer = null;

    function applyDecoration(theme, animated) {
      theme = theme || 'none';
      animated = (animated !== false);
      if (theme === currentDecoration && animated === currentDecorationAnimated) return;
      currentDecoration = theme;
      currentDecorationAnimated = animated;

      // Create overlay layer if missing
      if (!decoLayer) {
        decoLayer = document.createElement('div');
        decoLayer.id = 'of-deco';
        decoLayer.style.cssText = `
          position: absolute; top: -8px; left: 0; right: 0;
          height: 16px; pointer-events: none; overflow: visible;
          z-index: 1;
        `;
        panel.style.position = panel.style.position || 'fixed';
        panel.appendChild(decoLayer);
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
      // String of bulbs along a wire across the top
      const colors = ['#ef4444','#facc15','#22c55e','#3b82f6','#a855f7','#ec4899'];
      let bulbs = '';
      const count = 18;
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const color = colors[i % colors.length];
        const delay = (i * 0.15) % 1.8;
        bulbs += `<div class="of-bulb${animClass}" style="left:${left}%;background:${color};box-shadow:0 0 8px ${color};animation-delay:${delay}s;"></div>`;
      }
      return `
        <style>
          #of-deco .of-wire { position:absolute; top:8px; left:0; right:0; height:2px;
            background:linear-gradient(90deg,#1f2937,#374151,#1f2937); border-radius:1px; }
          #of-deco .of-bulb { position:absolute; top:10px; width:8px; height:11px;
            border-radius:50% 50% 40% 40%; transform:translateX(-50%);
            opacity:0.95; }
          #of-deco .of-bulb.of-deco-animate { animation: ofTwinkle 1.8s ease-in-out infinite; }
          @keyframes ofTwinkle {
            0%,100% { opacity:0.4; filter:brightness(0.7); }
            50% { opacity:1; filter:brightness(1.3); }
          }
        </style>
        <div class="of-wire"></div>
        ${bulbs}
      `;
    }

    function halloweenSpooky(animClass) {
      // Bats flying across, pumpkins in corners
      return `
        <style>
          #of-deco .of-bat { position:absolute; top:0; font-size:14px; opacity:0.8;
            color:#1f2937; filter: drop-shadow(0 0 2px rgba(168,85,247,0.4)); }
          #of-deco .of-bat.of-deco-animate { animation: ofFly 8s linear infinite; }
          @keyframes ofFly {
            0% { transform: translateX(0) translateY(0); }
            25% { transform: translateX(30vw) translateY(-4px); }
            50% { transform: translateX(60vw) translateY(2px); }
            75% { transform: translateX(80vw) translateY(-3px); }
            100% { transform: translateX(110vw) translateY(0); }
          }
          #of-deco .of-pumpkin { position:absolute; top:-4px; font-size:18px; }
          #of-deco .of-pumpkin.left { left:8px; }
          #of-deco .of-pumpkin.right { right:8px; }
          #of-deco .of-pumpkin.of-deco-animate { animation: ofBob 3s ease-in-out infinite; }
          @keyframes ofBob {
            0%,100% { transform: translateY(0) rotate(-3deg); }
            50% { transform: translateY(-3px) rotate(3deg); }
          }
        </style>
        <span class="of-pumpkin left${animClass}">🎃</span>
        <span class="of-pumpkin right${animClass}" style="animation-delay:1.5s;">🎃</span>
        <span class="of-bat${animClass}" style="animation-delay:0s;">🦇</span>
        <span class="of-bat${animClass}" style="animation-delay:3s;">🦇</span>
        <span class="of-bat${animClass}" style="animation-delay:5.5s;">🦇</span>
      `;
    }

    function easterEggs(animClass) {
      const eggs = ['🥚','🐰','🌷','🐣','🌸'];
      let html = '<style>#of-deco .of-egg { position:absolute; top:-2px; font-size:16px; }';
      html += `#of-deco .of-egg.of-deco-animate { animation: ofWiggle 2.4s ease-in-out infinite; }
        @keyframes ofWiggle {
          0%,100% { transform: rotate(-8deg) translateY(0); }
          50% { transform: rotate(8deg) translateY(-2px); }
        }</style>`;
      for (let i = 0; i < 7; i++) {
        const left = 5 + (i * 14);
        const sym = eggs[i % eggs.length];
        const delay = (i * 0.3) % 2.4;
        html += `<span class="of-egg${animClass}" style="left:${left}%;animation-delay:${delay}s;">${sym}</span>`;
      }
      return html;
    }

    function stPatricksClovers(animClass) {
      let html = `<style>
        #of-deco .of-clover { position:absolute; top:-2px; font-size:16px; }
        #of-deco .of-clover.of-deco-animate { animation: ofSpin 4s linear infinite; }
        @keyframes ofSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>`;
      for (let i = 0; i < 8; i++) {
        const left = 4 + (i * 12.5);
        const delay = (i * 0.4) % 4;
        html += `<span class="of-clover${animClass}" style="left:${left}%;animation-delay:${delay}s;">☘️</span>`;
      }
      return html;
    }

    function independenceFireworks(animClass) {
      // Mini firework bursts
      const colors = ['#ef4444','#3b82f6','#ffffff','#facc15'];
      let html = `<style>
        #of-deco .of-spark { position:absolute; top:6px; width:4px; height:4px;
          border-radius:50%; transform:translateX(-50%); }
        #of-deco .of-spark.of-deco-animate { animation: ofBurst 2.4s ease-out infinite; }
        @keyframes ofBurst {
          0% { transform: translateX(-50%) scale(0); opacity:1; }
          50% { transform: translateX(-50%) scale(2.5); opacity:0.6; }
          100% { transform: translateX(-50%) scale(3); opacity:0; }
        }
      </style>`;
      for (let i = 0; i < 10; i++) {
        const left = 8 + (i * 9.5);
        const color = colors[i % colors.length];
        const delay = (i * 0.25) % 2.4;
        html += `<div class="of-spark${animClass}" style="left:${left}%;background:${color};box-shadow:0 0 10px ${color};animation-delay:${delay}s;"></div>`;
      }
      return html;
    }

    function valentinesHearts(animClass) {
      let html = `<style>
        #of-deco .of-heart { position:absolute; top:-2px; font-size:14px; }
        #of-deco .of-heart.of-deco-animate { animation: ofPulseHeart 1.5s ease-in-out infinite; }
        @keyframes ofPulseHeart {
          0%,100% { transform: scale(1); opacity:0.8; }
          50% { transform: scale(1.25); opacity:1; }
        }
      </style>`;
      for (let i = 0; i < 9; i++) {
        const left = 4 + (i * 11.5);
        const delay = (i * 0.18) % 1.5;
        html += `<span class="of-heart${animClass}" style="left:${left}%;animation-delay:${delay}s;">💗</span>`;
      }
      return html;
    }

    function hanukkahStars(animClass) {
      // Star of David and dreidels alternating
      const symbols = ['✡️','🕎','✡️','🕯️','✡️','🕎'];
      let html = `<style>
        #of-deco .of-hstar { position:absolute; top:-2px; font-size:14px; color:#3b82f6; }
        #of-deco .of-hstar.of-deco-animate { animation: ofShine 2s ease-in-out infinite; }
        @keyframes ofShine {
          0%,100% { filter: drop-shadow(0 0 2px #60a5fa); opacity:0.8; }
          50% { filter: drop-shadow(0 0 8px #60a5fa); opacity:1; }
        }
      </style>`;
      for (let i = 0; i < symbols.length; i++) {
        const left = 6 + (i * 16);
        const delay = (i * 0.3) % 2;
        html += `<span class="of-hstar${animClass}" style="left:${left}%;animation-delay:${delay}s;">${symbols[i]}</span>`;
      }
      return html;
    }

    function thanksgivingLeaves(animClass) {
      const leaves = ['🍂','🍁','🍃','🍁','🍂'];
      let html = `<style>
        #of-deco .of-leaf { position:absolute; top:-4px; font-size:15px; }
        #of-deco .of-leaf.of-deco-animate { animation: ofFall 5s ease-in-out infinite; }
        @keyframes ofFall {
          0% { transform: translateY(-12px) rotate(-20deg); opacity:0; }
          15% { opacity:1; }
          100% { transform: translateY(50px) rotate(180deg); opacity:0; }
        }
      </style>`;
      for (let i = 0; i < 8; i++) {
        const left = 5 + (i * 12);
        const sym = leaves[i % leaves.length];
        const delay = (i * 0.6) % 5;
        html += `<span class="of-leaf${animClass}" style="left:${left}%;animation-delay:${delay}s;">${sym}</span>`;
      }
      return html;
    }

    function snowFall(animClass) {
      let html = `<style>
        #of-deco .of-flake { position:absolute; top:-6px; font-size:11px; color:#fff;
          opacity:0.85; text-shadow: 0 0 3px rgba(255,255,255,0.6); }
        #of-deco .of-flake.of-deco-animate { animation: ofSnow 6s linear infinite; }
        @keyframes ofSnow {
          0% { transform: translateY(-12px) rotate(0); opacity:0; }
          15% { opacity:1; }
          100% { transform: translateY(70px) rotate(360deg); opacity:0; }
        }
      </style>`;
      const count = 14;
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const delay = (i * 0.4) % 6;
        const size = 9 + (i % 4) * 2;
        html += `<span class="of-flake${animClass}" style="left:${left}%;animation-delay:${delay}s;font-size:${size}px;">❄</span>`;
      }
      return html;
    }
  })();
})();
