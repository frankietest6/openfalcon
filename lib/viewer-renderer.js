// ============================================================
// OpenFalcon — Viewer Page Template Renderer
//
// Takes an HTML template (user-authored, possibly imported from
// Remote Falcon) and renders it into a live page by replacing
// placeholder tokens with current state.
//
// Supported content placeholders (case-sensitive):
//   {NOW_PLAYING}      — current sequence display name
//   {NEXT_PLAYLIST}    — next scheduled/requested sequence
//   {JUKEBOX_QUEUE}    — pending request list (UL)
//   {QUEUE_SIZE}       — count of pending requests
//   {QUEUE_DEPTH}      — configured max queue depth
//   {LOCATION_CODE}    — location-based access code (placeholder)
//   {PLAYLISTS}        — grid of sequences with vote/request buttons
//
// Attribute-style placeholders (swapped on a DIV's opening tag to
// toggle visibility — RF compat):
//   {jukebox-dynamic-container}
//   {playlist-voting-dynamic-container}
//   {location-code-dynamic-container}
//   {after-hours-message}
//
// Injects /rf-compat.js before </body> so RF-style templates'
// onclick handlers (vote, request) work against our API.
// ============================================================

const { db } = require('./db');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeJsString(s) {
  // Safe to put inside a single-quoted JS string embedded in an HTML attribute
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function renderPlaylistGrid(sequences, mode, voteCounts) {
  // Emits Remote Falcon-compatible markup so existing template CSS classes
  // (.jukebox_table children, .cell-vote-playlist, .cell-vote, .sequence-image)
  // style our output correctly.
  const rows = sequences.map(seq => {
    const safeNameJs = escapeJsString(seq.name);
    const safeNameAttr = escapeHtml(seq.name);
    const safeDisplay = escapeHtml(seq.display_name);
    const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
    const count = (voteCounts && voteCounts[seq.name]) || 0;
    const artImg = seq.image_url
      ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(seq.image_url)}" alt="" loading="lazy" />`
      : '';

    if (mode === 'VOTING') {
      // Voting mode: two-cell row — left cell is clickable (name + image + artist),
      // right cell is the vote count. .voting_table on the wrapper is a flex container,
      // and .cell-vote-playlist (85% width) + .cell-vote (15% width) are siblings.
      return `<div class="cell-vote-playlist" onclick="OpenFalconVote('${safeNameJs}')" data-seq="${safeNameAttr}">${artImg}${safeDisplay}<div class="cell-vote-playlist-artist">${safeArtist}</div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
    } else {
      // Jukebox mode: each card is one clickable item with album art + title + artist.
      // The template's .jukebox_table is a flex/grid container of these cards.
      return `<div class="jukebox-list" onclick="OpenFalconRequest('${safeNameJs}')" data-seq="${safeNameAttr}">${artImg}${safeDisplay}<div class="jukebox-list-artist">${safeArtist}</div></div>`;
    }
  }).join('');
  return rows;
}

function renderQueue(queue, sequences) {
  if (!queue.length) return 'Queue is empty.';
  const byName = Object.fromEntries(sequences.map(s => [s.name, s]));
  return queue.map(entry => {
    const seq = byName[entry.sequence_name];
    return escapeHtml(seq?.display_name || entry.sequence_name);
  }).join('<br />');
}

function renderTemplate(template, state) {
  if (!template) return '<!-- No template available -->';

  const cfg = state.config || {};
  const mode = cfg.viewer_control_mode || 'OFF';
  const isAfterHours = false; // TODO: wire to show hours config when that exists
  const locationCodeRequired = false; // TODO: when location-code mode is built
  const voteCountsMap = {};
  (state.voteCounts || []).forEach(v => { voteCountsMap[v.sequence_name] = v.count; });

  let html = template;

  // ---- Content placeholders ----
  const nowDisplay = state.nowPlaying
    ? (state.sequences.find(s => s.name === state.nowPlaying)?.display_name || state.nowPlaying)
    : '—';
  const nextDisplay = state.nextScheduled
    ? (state.sequences.find(s => s.name === state.nextScheduled)?.display_name || state.nextScheduled)
    : '—';

  // Wrap text placeholders in spans with data attributes so compat JS can update them live
  html = html.split('{NOW_PLAYING}').join(
    `<span class="now-playing-text" data-openfalcon-now>${escapeHtml(nowDisplay)}</span>`
  );
  html = html.split('{NEXT_PLAYLIST}').join(
    `<span data-openfalcon-next>${escapeHtml(nextDisplay)}</span>`
  );
  html = html.split('{QUEUE_SIZE}').join(
    `<span data-openfalcon-queue-size>${(state.queue || []).length}</span>`
  );
  html = html.split('{QUEUE_DEPTH}').join(String(cfg.jukebox_queue_depth || 0));
  html = html.split('{LOCATION_CODE}').join('');
  html = html.split('{JUKEBOX_QUEUE}').join(
    `<div data-openfalcon-queue-list>${renderQueue(state.queue || [], state.sequences || [])}</div>`
  );
  html = html.split('{PLAYLISTS}').join(
    renderPlaylistGrid(state.sequences || [], mode, voteCountsMap)
  );

  // ---- Attribute-style placeholders ----
  // Turn RF's placeholder into (1) an inline style and (2) a marker class + data attr
  // so the compat script can live-toggle visibility on mode change.
  html = html.split('{jukebox-dynamic-container}').join(
    `data-openfalcon-container="jukebox"${mode === 'JUKEBOX' ? '' : ' style="display:none"'}`
  );
  html = html.split('{playlist-voting-dynamic-container}').join(
    `data-openfalcon-container="voting"${mode === 'VOTING' ? '' : ' style="display:none"'}`
  );
  html = html.split('{location-code-dynamic-container}').join(
    locationCodeRequired ? '' : 'style="display:none"'
  );
  html = html.split('{after-hours-message}').join(
    isAfterHours ? '' : 'style="display:none"'
  );

  // ---- Inject compat script before </body> ----
  // State is exposed as a JSON blob the compat layer reads on load.
  const bootstrap = {
    mode,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
    showName: cfg.show_name,
  };
  const injection = `
  <script>window.__OPENFALCON__ = ${JSON.stringify(bootstrap)};</script>
  <script src="/rf-compat.js?v=8"></script>
  `;
  if (html.includes('</body>')) {
    html = html.replace('</body>', injection + '</body>');
  } else {
    html = html + injection;
  }

  return html;
}

function getActiveTemplate() {
  const row = db.prepare(`
    SELECT * FROM viewer_page_templates WHERE is_active = 1 LIMIT 1
  `).get();
  return row || null;
}

module.exports = { renderTemplate, getActiveTemplate, escapeHtml };
