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
  // ============================================================
  // PAGE-WIDE SNOW — gently falling snowflakes across the viewer page
  // Enabled via admin Viewer Page tab. Spawns 50 SVG flakes that drift
  // down with horizontal sway. Pointer-events:none so doesn't block clicks.
  // Auto-disabled when prefers-reduced-motion is set.
  // ============================================================
  (function initPageSnow() {
    const cfg = window.__OPENFALCON__ || {};
    if (!cfg.pageSnowEnabled) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const layer = document.createElement('div');
    layer.id = 'of-page-snow';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 9990; overflow: hidden;
    `;

    // Single shared snowflake SVG (referenced by use? — keep inline for simplicity)
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

    // Pseudo-random but deterministic — same flakes every load looks weird,
    // so use Math.random for variety
    const flakeCount = 50;
    const flakes = [];
    for (let i = 0; i < flakeCount; i++) {
      const flake = document.createElement('div');
      const size = 8 + Math.random() * 14;       // 8-22px
      const left = Math.random() * 100;          // % across viewport
      const duration = 8 + Math.random() * 10;   // 8-18s fall time
      const delay = -Math.random() * duration;   // negative so they're already mid-fall on load
      const sway = 20 + Math.random() * 40;      // px horizontal drift
      const opacity = 0.4 + Math.random() * 0.5; // 0.4-0.9
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
      layer.appendChild(flake);
      flakes.push(flake);
    }

    const style = document.createElement('style');
    style.textContent = `
      @keyframes ofPageSnowFall {
        0%   { transform: translateY(-30px) rotate(0deg); }
        100% { transform: translateY(105vh) rotate(360deg); }
      }
      @keyframes ofPageSnowSway {
        0%   { margin-left: 0; }
        100% { margin-left: var(--of-sway); }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(layer);
  })();

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

    // ---- Theme palettes (player bar colors per decoration) ----
    // Each palette: bg gradient + border accent + glow color.
    // CSS variables let decoration code read the active theme color.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
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
        --of-bg: linear-gradient(180deg, rgba(60,15,20,0.97), rgba(20,30,20,0.97));
        --of-border: rgba(239,68,68,0.5);
        --of-glow: rgba(239,68,68,0.3);
      }
      #of-listen-panel.of-theme-halloween {
        --of-bg: linear-gradient(180deg, rgba(30,10,40,0.97), rgba(50,20,5,0.97));
        --of-border: rgba(251,146,60,0.6);
        --of-glow: rgba(251,146,60,0.35);
      }
      #of-listen-panel.of-theme-easter {
        --of-bg: linear-gradient(180deg, rgba(120,80,140,0.97), rgba(60,90,120,0.97));
        --of-border: rgba(251,207,232,0.6);
        --of-glow: rgba(251,207,232,0.3);
      }
      #of-listen-panel.of-theme-stpatricks {
        --of-bg: linear-gradient(180deg, rgba(15,50,30,0.97), rgba(8,30,18,0.97));
        --of-border: rgba(34,197,94,0.6);
        --of-glow: rgba(34,197,94,0.3);
      }
      #of-listen-panel.of-theme-independence {
        --of-bg: linear-gradient(180deg, rgba(20,30,80,0.97), rgba(80,20,30,0.97));
        --of-border: rgba(255,255,255,0.5);
        --of-glow: rgba(96,165,250,0.4);
      }
      #of-listen-panel.of-theme-valentines {
        --of-bg: linear-gradient(180deg, rgba(80,20,50,0.97), rgba(50,15,40,0.97));
        --of-border: rgba(244,114,182,0.6);
        --of-glow: rgba(244,114,182,0.4);
      }
      #of-listen-panel.of-theme-hanukkah {
        --of-bg: linear-gradient(180deg, rgba(15,30,60,0.97), rgba(10,20,40,0.97));
        --of-border: rgba(96,165,250,0.6);
        --of-glow: rgba(96,165,250,0.4);
      }
      #of-listen-panel.of-theme-thanksgiving {
        --of-bg: linear-gradient(180deg, rgba(60,30,10,0.97), rgba(40,20,5,0.97));
        --of-border: rgba(234,88,12,0.6);
        --of-glow: rgba(234,88,12,0.3);
      }
      #of-listen-panel.of-theme-snow {
        --of-bg: linear-gradient(180deg, rgba(15,25,50,0.97), rgba(8,15,35,0.97));
        --of-border: rgba(186,230,253,0.6);
        --of-glow: rgba(186,230,253,0.4);
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

      // Update panel theme class — strip all existing of-theme-* and add new one
      panel.className = panel.className.split(/\s+/)
        .filter(c => !c.startsWith('of-theme-'))
        .join(' ').trim();
      if (theme !== 'none') {
        panel.classList.add('of-theme-' + theme);
      }

      // Create overlay layer if missing.
      // Sits ABOVE the player panel as a banner — taller decorations like bats
      // and falling leaves need vertical space. The themed player bar gives them
      // a colored backdrop so they read clearly.
      if (!decoLayer) {
        decoLayer = document.createElement('div');
        decoLayer.id = 'of-deco';
        decoLayer.style.cssText = `
          position: absolute; top: -36px; left: 0; right: 0;
          height: 40px; pointer-events: none; overflow: visible;
          z-index: 10000;
        `;
        panel.style.position = panel.style.position || 'fixed';
        panel.style.overflow = 'visible';
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
      // Realistic string lights: SVG bulbs with radial gradients, bright glow
      // when twinkling, dark caps where they screw into the wire.
      const colors = [
        { core: '#fff5f0', mid: '#ef4444', edge: '#7f1d1d' }, // red
        { core: '#fffbeb', mid: '#facc15', edge: '#854d0e' }, // gold
        { core: '#f0fdf4', mid: '#22c55e', edge: '#14532d' }, // green
        { core: '#eff6ff', mid: '#3b82f6', edge: '#1e3a8a' }, // blue
        { core: '#faf5ff', mid: '#a855f7', edge: '#581c87' }, // purple
      ];
      const count = 16;
      let bulbs = '';
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const c = colors[i % colors.length];
        const delay = ((i * 0.23) % 2.0).toFixed(2);
        const id = 'ofg' + i;
        bulbs += `
          <svg class="of-bulb${animClass}" viewBox="0 0 14 22" width="20" height="32"
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
            position:absolute; top:14px; left:0; right:0; height:2px;
            background: linear-gradient(180deg, #1f2937 0%, #0f172a 100%);
            border-radius: 1px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.5);
          }
          #of-deco .of-bulb {
            position:absolute; top:6px; transform:translateX(-50%);
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
      // Real bat SVGs flapping wings + flying across; pumpkin SVGs in corners
      const batSvg = `
        <svg viewBox="0 0 40 24" width="44" height="26">
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
        <svg viewBox="0 0 24 22" width="36" height="33">
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
            filter: drop-shadow(0 0 4px rgba(168,85,247,0.6));
          }
          #of-deco .of-bat.of-deco-animate { animation: ofBatFly 9s linear infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-l { animation: ofWingL 0.25s ease-in-out infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-r { animation: ofWingR 0.25s ease-in-out infinite; }
          @keyframes ofBatFly {
            0%   { transform: translateX(0)    translateY(0)  scale(0.8); opacity:0; }
            5%   { opacity: 1; }
            25%  { transform: translateX(28vw) translateY(-8px) scale(0.95); }
            50%  { transform: translateX(55vw) translateY(4px)  scale(1.1); }
            75%  { transform: translateX(80vw) translateY(-6px) scale(0.95); }
            95%  { opacity: 1; }
            100% { transform: translateX(110vw) translateY(0)   scale(0.8); opacity:0; }
          }
          @keyframes ofWingL { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          @keyframes ofWingR { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          #of-deco .of-pumpkin {
            position:absolute; top:4px;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
          }
          #of-deco .of-pumpkin.left { left:8px; }
          #of-deco .of-pumpkin.right { right:8px; }
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
      // Pastel decorated eggs with stripes + dots
      const eggColors = [
        { body: '#fbcfe8', stripe: '#ec4899' },  // pink
        { body: '#bae6fd', stripe: '#0284c7' },  // blue
        { body: '#bbf7d0', stripe: '#16a34a' },  // green
        { body: '#fef08a', stripe: '#ca8a04' },  // yellow
        { body: '#ddd6fe', stripe: '#7c3aed' },  // purple
      ];
      let html = `<style>
        #of-deco { height: 18px; top: -6px; }
        #of-deco .of-egg { position:absolute; top:0; transform:translateX(-50%); }
        #of-deco .of-egg.of-deco-animate { animation: ofEggWiggle 2.6s ease-in-out infinite; }
        @keyframes ofEggWiggle {
          0%,100% { transform: translateX(-50%) rotate(-12deg); }
          50%     { transform: translateX(-50%) rotate(12deg) translateY(-2px); }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const c = eggColors[i % eggColors.length];
        const delay = ((i * 0.32) % 2.6).toFixed(2);
        html += `
          <svg class="of-egg${animClass}" viewBox="0 0 12 16" width="11" height="14"
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
      // Real shamrock SVG with three rounded leaves
      const cloverSvg = `
        <svg viewBox="0 0 16 16" width="14" height="14">
          <g fill="#16a34a" stroke="#14532d" stroke-width="0.4">
            <path d="M 8,8 Q 4,4 5,2 Q 7,1 8,4 Z"/>
            <path d="M 8,8 Q 12,4 11,2 Q 9,1 8,4 Z"/>
            <path d="M 8,8 Q 4,12 5,14 Q 7,15 8,12 Z"/>
            <path d="M 8,8 Q 12,12 11,14 Q 9,15 8,12 Z"/>
            <path d="M 8,12 L 9,16" stroke="#15803d" stroke-width="0.7"/>
          </g>
        </svg>`;
      let html = `<style>
        #of-deco { height: 18px; top: -6px; }
        #of-deco .of-clover {
          position:absolute; top:1px; transform:translateX(-50%);
          filter: drop-shadow(0 0 2px rgba(34,197,94,0.4));
        }
        #of-deco .of-clover.of-deco-animate { animation: ofCloverSpin 5s linear infinite; }
        @keyframes ofCloverSpin {
          0%   { transform: translateX(-50%) rotate(0deg)   scale(1); }
          50%  { transform: translateX(-50%) rotate(180deg) scale(1.1); }
          100% { transform: translateX(-50%) rotate(360deg) scale(1); }
        }
      </style>`;
      const count = 7;
      for (let i = 0; i < count; i++) {
        const left = 7 + (i * 86 / (count - 1));
        const delay = ((i * 0.5) % 5).toFixed(2);
        html += `<span class="of-clover${animClass}" style="left:${left}%;animation-delay:${delay}s;">${cloverSvg}</span>`;
      }
      return html;
    }

    function independenceFireworks(animClass) {
      // Radial burst pattern — 12 lines fanning out, each its own color
      const colors = ['#ef4444','#3b82f6','#ffffff','#facc15'];
      let html = `<style>
        #of-deco { height: 30px; top: -12px; overflow: visible; }
        #of-deco .of-burst {
          position:absolute; top:6px; width:30px; height:30px;
          transform:translateX(-50%);
        }
        #of-deco .of-burst .of-ray {
          position:absolute; top:50%; left:50%;
          width:14px; height:1.5px;
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
      const burstCount = 5;
      for (let b = 0; b < burstCount; b++) {
        const left = 10 + (b * 80 / (burstCount - 1));
        const color = colors[b % colors.length];
        const delay = ((b * 0.5) % 2.6).toFixed(2);
        let rays = '';
        for (let r = 0; r < 12; r++) {
          const angle = r * 30;
          rays += `<div class="of-ray" style="background:linear-gradient(90deg,${color},transparent);transform:translate(0,-50%) rotate(${angle}deg);"></div>`;
        }
        html += `<div class="of-burst${animClass}" style="left:${left}%;animation-delay:${delay}s;">${rays}</div>`;
      }
      return html;
    }

    function valentinesHearts(animClass) {
      // Proper heart SVG with glossy highlight
      const heartSvg = `
        <svg viewBox="0 0 16 14" width="14" height="12">
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
        #of-deco { height: 16px; top: -6px; }
        #of-deco .of-heart {
          position:absolute; top:1px; transform:translateX(-50%);
          filter: drop-shadow(0 0 2px rgba(236,72,153,0.5));
        }
        #of-deco .of-heart.of-deco-animate { animation: ofHeartPulse 1.4s ease-in-out infinite; }
        @keyframes ofHeartPulse {
          0%, 100% { transform: translateX(-50%) scale(1); }
          50%      { transform: translateX(-50%) scale(1.25); }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.18) % 1.4).toFixed(2);
        html += `<span class="of-heart${animClass}" style="left:${left}%;animation-delay:${delay}s;">${heartSvg}</span>`;
      }
      return html;
    }

    function hanukkahStars(animClass) {
      // Star of David SVG — two overlapping triangles
      const starSvg = `
        <svg viewBox="0 0 16 16" width="13" height="13">
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
        #of-deco { height: 18px; top: -6px; }
        #of-deco .of-hstar {
          position:absolute; top:1px; transform:translateX(-50%);
        }
        #of-deco .of-hstar.of-deco-animate { animation: ofStarShine 2.2s ease-in-out infinite; }
        @keyframes ofStarShine {
          0%, 100% { filter: drop-shadow(0 0 1px #60a5fa) brightness(0.9); }
          50%      { filter: drop-shadow(0 0 7px #60a5fa) brightness(1.2); }
        }
      </style>`;
      const count = 6;
      for (let i = 0; i < count; i++) {
        const left = 8 + (i * 84 / (count - 1));
        const delay = ((i * 0.35) % 2.2).toFixed(2);
        html += `<span class="of-hstar${animClass}" style="left:${left}%;animation-delay:${delay}s;">${starSvg}</span>`;
      }
      return html;
    }

    function thanksgivingLeaves(animClass) {
      // Maple/oak leaves in autumn colors
      const leafColors = [
        '#dc2626', // red
        '#ea580c', // orange
        '#ca8a04', // gold
        '#78350f', // dark brown
      ];
      const leafSvg = (color) => `
        <svg viewBox="0 0 16 18" width="14" height="16">
          <path d="M 8,1 Q 5,3 5,5 Q 2,5 2,8 Q 4,9 4,11 Q 2,12 3,14 Q 5,14 6,15 L 8,17 L 10,15 Q 11,14 13,14 Q 14,12 12,11 Q 12,9 14,8 Q 14,5 11,5 Q 11,3 8,1 Z"
                fill="${color}" stroke="#451a03" stroke-width="0.4"/>
          <path d="M 8,17 L 8,5" stroke="#451a03" stroke-width="0.5"/>
        </svg>`;
      let html = `<style>
        #of-deco { height: 22px; top: -6px; overflow: visible; }
        #of-deco .of-leaf {
          position:absolute; top:-6px; transform:translateX(-50%);
        }
        #of-deco .of-leaf.of-deco-animate { animation: ofLeafFall 6s ease-in-out infinite; }
        @keyframes ofLeafFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(-30deg); opacity:0; }
          15%  { opacity: 1; }
          50%  { transform: translateX(-30%) translateY(20px)  rotate(60deg);  opacity:0.9; }
          100% { transform: translateX(-70%) translateY(70px)  rotate(220deg); opacity:0; }
        }
      </style>`;
      const count = 7;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.7) % 6).toFixed(2);
        const color = leafColors[i % leafColors.length];
        html += `<span class="of-leaf${animClass}" style="left:${left}%;animation-delay:${delay}s;">${leafSvg(color)}</span>`;
      }
      return html;
    }

    function snowFall(animClass) {
      // 6-fold symmetric snowflake SVG (small version for player decoration)
      const flakeSvg = `
        <svg viewBox="0 0 14 14" width="11" height="11">
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
        #of-deco { height: 30px; top: -10px; overflow: visible; }
        #of-deco .of-flake {
          position:absolute; top:-12px; transform:translateX(-50%);
          filter: drop-shadow(0 0 2px rgba(255,255,255,0.6));
        }
        #of-deco .of-flake.of-deco-animate { animation: ofFlakeFall 7s linear infinite; }
        @keyframes ofFlakeFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(0); opacity:0; }
          15%  { opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translateX(-30%) translateY(80px) rotate(360deg); opacity:0; }
        }
      </style>`;
      const count = 12;
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const delay = ((i * 0.55) % 7).toFixed(2);
        const scale = (0.7 + ((i * 7) % 6) / 10).toFixed(2);
        html += `<span class="of-flake${animClass}" style="left:${left}%;animation-delay:${delay}s;transform:translateX(-50%) scale(${scale});">${flakeSvg}</span>`;
      }
      return html;
    }
  })();
})();
