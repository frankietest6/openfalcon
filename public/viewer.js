// ShowPilot viewer page client logic.

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const state = {
    mode: 'OFF',
    sequences: [],
    voteCounts: {},
    queue: [],
    hasVoted: false,
    // v0.32.6+: when allowVoteChange is true, the user can click another
    // song to switch their vote. votedFor tracks the current pick so we
    // can highlight it and no-op a click on the same song.
    allowVoteChange: false,
    votedFor: null,
    // Tracks the last round id we saw so we can clear hasVoted/votedFor
    // when the server advances past it. Without this, a user who voted
    // in round N would stay locked out for round N+1 until reload.
    lastKnownRoundId: null,
    serverRequirements: { requiresLocation: false },
  };

  async function fetchState() {
    try {
      const res = await fetch('/api/state', { credentials: 'include' });
      const data = await res.json();
      applyState(data);
    } catch (e) {
      console.error('Failed to fetch state:', e);
    }
  }

  function applyState(data) {
    el('showName').textContent = data.showName || 'Light Show';
    el('viewerCount').textContent = data.activeViewers || 0;
    el('nowPlayingName').textContent = data.nowPlaying
      ? (data.sequences.find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying)
      : '—';

    state.mode = data.viewerControlMode;
    state.sequences = data.sequences;
    state.voteCounts = Object.fromEntries((data.voteCounts || []).map(v => [v.sequence_name, v.count]));
    state.queue = data.queue || [];
    state.allowVoteChange = data.allowVoteChange === true;
    state.serverRequirements = { requiresLocation: data.requiresLocation === true };

    // Round-advance detection (v0.32.6+): when the server's currentVotingRound
    // changes, our local hasVoted/votedFor are stale. Clear them so the user
    // can vote in the new round without reloading. Mirrors the same logic in
    // rf-compat.js.
    if (typeof data.currentVotingRound === 'number') {
      if (state.lastKnownRoundId !== null && data.currentVotingRound !== state.lastKnownRoundId) {
        state.hasVoted = false;
        state.votedFor = null;
      }
      state.lastKnownRoundId = data.currentVotingRound;
    }

    el('modeVoting').classList.toggle('hidden', data.viewerControlMode !== 'VOTING');
    el('modeJukebox').classList.toggle('hidden', data.viewerControlMode !== 'JUKEBOX');
    el('modeOff').classList.toggle('hidden', data.viewerControlMode !== 'OFF');

    if (data.viewerControlMode === 'VOTING') renderVoteList();
    if (data.viewerControlMode === 'JUKEBOX') renderJukeboxList();
  }

  function renderVoteList() {
    const list = el('voteList');
    list.innerHTML = '';
    state.sequences.filter(s => s.votable).forEach(seq => {
      const count = state.voteCounts[seq.name] || 0;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      // Disable buttons only when the user has voted AND can't shift.
      // When shifting is allowed, leave them all enabled so the user can
      // click a different song. The current pick is highlighted so it's
      // obvious which one their vote is on.
      btn.disabled = state.hasVoted && !state.allowVoteChange;
      if (state.votedFor === seq.name) btn.classList.add('voted');
      btn.innerHTML = `
        <span>${escapeHtml(seq.display_name)}${seq.artist ? ' — ' + escapeHtml(seq.artist) : ''}</span>
        <span class="vote-count">${count}</span>
      `;
      btn.onclick = () => vote(seq.name);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function renderJukeboxList() {
    const list = el('jukeboxList');
    list.innerHTML = '';
    // Sequences in cooldown are filtered out server-side (in /state) so
    // we don't need to render them as disabled — they simply aren't here.
    state.sequences.filter(s => s.jukeboxable).forEach(seq => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.innerHTML = `<span>${escapeHtml(seq.display_name)}${seq.artist ? ' — ' + escapeHtml(seq.artist) : ''}</span><span>+</span>`;
      btn.onclick = () => addToQueue(seq.name);
      li.appendChild(btn);
      list.appendChild(li);
    });

    const q = el('queueList');
    q.innerHTML = '';
    state.queue.forEach(entry => {
      const seq = state.sequences.find(s => s.name === entry.sequence_name);
      const li = document.createElement('li');
      li.textContent = seq ? seq.display_name : entry.sequence_name;
      q.appendChild(li);
    });
  }

  // Cache GPS location once acquired (reused across votes/requests)
  let cachedLocation = null;

  // Get viewer location (if server requires it). Resolves with {lat, lng} or rejects.
  async function getViewerLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Your browser does not support location. You may not be able to vote or request.');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        (err) => {
          let msg = 'Could not get your location.';
          if (err.code === 1) msg = 'Location access was denied. Please enable location to vote/request.';
          if (err.code === 3) msg = 'Location request timed out.';
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  // Build request body, attaching viewerLat/Lng if server says location is required
  async function buildBody(baseBody, data) {
    const body = { ...baseBody };
    if (data && data.requiresLocation) {
      const loc = await getViewerLocation();
      body.viewerLat = loc.lat;
      body.viewerLng = loc.lng;
    }
    return body;
  }

  async function vote(sequenceName) {
    // No-op if the user clicked the same song they already voted for.
    // (Server would also no-op, but skipping the round-trip keeps the
    // UI quiet and avoids a misleading "Vote cast" toast.)
    if (state.hasVoted && state.votedFor === sequenceName) return;
    let body;
    try {
      body = await buildBody({ sequenceName }, state.serverRequirements);
    } catch (e) {
      toast(e.message);
      return;
    }
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      state.hasVoted = true;
      state.votedFor = sequenceName;
      toast(data.shifted ? 'Vote changed!' : 'Vote cast!');
      renderVoteList();
    } else {
      toast(data.error || 'Vote failed');
    }
  }

  async function addToQueue(sequenceName) {
    let body;
    try {
      body = await buildBody({ sequenceName }, state.serverRequirements);
    } catch (e) {
      toast(e.message);
      return;
    }
    const res = await fetch('/api/jukebox/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      toast('Added to queue!');
      fetchState();
    } else {
      toast(data.error || 'Failed to add');
    }
  }

  async function heartbeat() {
    try {
      await fetch('/api/heartbeat', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {}
  }

  function toast(msg) {
    const prev = document.querySelector('.toast');
    if (prev) prev.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Initial load
  heartbeat();
  fetchState();

  // Socket.io live updates
  try {
    const socket = io();
    socket.on('nowPlaying', (data) => {
      const seq = state.sequences.find(s => s.name === data.sequenceName);
      el('nowPlayingName').textContent = seq ? seq.display_name : data.sequenceName;
    });
    socket.on('voteUpdate', (data) => {
      state.voteCounts = Object.fromEntries(data.counts.map(v => [v.sequence_name, v.count]));
      if (state.mode === 'VOTING') renderVoteList();
    });
    socket.on('queueUpdated', () => { fetchState(); });
    socket.on('viewerCount', (data) => { el('viewerCount').textContent = data.count || 0; });
  } catch (e) {
    console.warn('Socket.io unavailable; falling back to polling.');
  }

  // Heartbeat + state polling fallback
  setInterval(heartbeat, 15000);
  setInterval(fetchState, 30000);
})();
