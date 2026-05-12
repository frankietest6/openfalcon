// ============================================================
// ShowPilot — Viewer Page Template Renderer
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
//   {playlist-standard-dynamic-container}  — alias for jukebox; used
//      by RF's lumos-light-show and on-air default templates
//   {playlist-voting-dynamic-container}
//   {location-code-dynamic-container}
//   {after-hours-message}
//
// {VOTES} is documented in RF's templates but never actually emitted
// in markup (it only appears inside doc-comments). We strip it
// anyway so a hand-written template using it doesn't leak literal
// braces to the page.
//
// Injects /rf-compat.js before </body> so RF-style templates'
// onclick handlers (vote, request) work against our API.
// ============================================================

const { db } = require('./db');
const { bustCoverUrl } = require('./cover-art');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeJsString(s) {
  // Safe to put inside a single-quoted JS string embedded in an HTML attribute
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Format a remaining-seconds value as m:ss for the {NOW_PLAYING_TIMER}
// placeholder. RF-compatible — they show m:ss too. Negative or NaN values
// render as 0:00 (timer hit zero or never had a duration). null renders as
// the placeholder text --:-- (no song playing, or duration unknown).
function formatTimer(remainingSec) {
  if (remainingSec === null || !isFinite(remainingSec)) return '--:--';
  const sec = Math.max(0, Math.floor(remainingSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// Compute the timer text we'll render server-side at first paint. The
// client takes over after page load and ticks it every second. We use
// server-time (Date.now() on the server) here; clock skew between
// server and client doesn't matter for the FIRST paint because the
// browser sees this as static text. Once rf-compat reads /api/state
// and starts ticking, it uses ITS Date.now() against startedAtMs from
// the response — so any skew is consistent and the countdown stays
// monotonic. Returns '--:--' for missing inputs.
function computeInitialTimerText(startedAtIso, durationSeconds) {
  if (!startedAtIso || !durationSeconds) return '--:--';
  const startedMs = Date.parse(startedAtIso);
  if (!isFinite(startedMs)) return '--:--';
  const elapsedSec = (Date.now() - startedMs) / 1000;
  return formatTimer(durationSeconds - elapsedSec);
}

// ---- Race mode grid (v0.33.155+) ----
// Emits a tap-button + progress-bar row for each sequence.
// The server renders initial tap counts; rf-compat.js updates them live
// via raceTapUpdate socket events without a full page reload.
// `tapCounts` is a plain object: sequenceName → count.
function renderRaceGrid(sequences, tapCounts) {
  if (!sequences.length) return '<div class="race-empty">No songs in the race yet.</div>';
  const instructions = `<div class="race-instructions">
  <p>Tap your favourite song as many times as you want — most taps wins!</p>
</div>`;
  const rows = sequences.map(seq => {
    const safeNameJs   = escapeJsString(seq.name);
    const safeNameAttr = escapeHtml(seq.name);
    const safeDisplay  = escapeHtml(seq.display_name);
    const safeArtist   = seq.artist ? escapeHtml(seq.artist) : '';
    const taps         = (tapCounts && tapCounts[seq.name]) || 0;
    const bustedUrl    = bustCoverUrl(seq.image_url);
    const artImg       = bustedUrl
      ? `<img class="sequence-image race-cover" src="${escapeHtml(bustedUrl)}" alt="" loading="lazy" />`
      : '';
    return `<div class="race-row" data-race-seq="${safeNameAttr}">
  <div class="race-row-info">
    ${artImg}
    <div class="race-row-text">
      <span class="race-song-name">${safeDisplay}</span>
      ${safeArtist ? `<span class="race-song-artist">${safeArtist}</span>` : ''}
    </div>
    <span class="race-tap-count" data-race-count="${safeNameAttr}">${taps}</span>
  </div>
  <div class="race-bar-track">
    <div class="race-bar-fill" data-race-bar="${safeNameAttr}" style="width:0%"></div>
  </div>
  <button class="race-tap-btn" onclick="ShowPilotRaceTap('${safeNameJs}')" aria-label="Tap for ${safeDisplay}">TAP!</button>
</div>`;
  }).join('\n');
  return instructions + rows;
}

function renderPlaylistGrid(sequences, mode, voteCounts, raceTapCounts) {
  // raceTapCounts is only populated in RACE mode — a map of sequenceName → tapCount
  if (mode === 'RACE') {
    return renderRaceGrid(sequences, raceTapCounts || {});
  }
  // Emits markup that satisfies BOTH the canonical Remote Falcon class
  // spec AND the third-party RF Page Builder runtime conventions
  // (v0.32.13+). The rules:
  //
  //   Canonical RF expects:
  //     .jukebox-list / .jukebox-list-artist / .sequence-image
  //     .cell-vote-playlist / .cell-vote-playlist-artist / .cell-vote / .sequence-image
  //
  //   RF Page Builder (rfpagebuilder.com, third-party) expects:
  //     .sequence-item containing  > div  containing  .sequence-image
  //                                                   .sequence-name
  //                                                   .sequence-artist
  //                                                   .sequence-requests | .sequence-votes
  //
  // We satisfy both by:
  //   - Adding 'sequence-item' alongside 'jukebox-list' / 'cell-vote-playlist'
  //     on the outer clickable element.
  //   - Adding ONE inner <div> that acts as both the natural flex wrapper AND
  //     the '.sequence-item > div' selector target.
  //   - Wrapping the display name in <span class="sequence-name">. A span is
  //     inline-level so it doesn't change layout for RF templates that
  //     expected the name as a direct text node; CSS color/font properties
  //     inherit from the parent, so RF typography still works.
  //   - Adding 'sequence-artist' as an extra class on the existing artist div
  //     (preserves '.jukebox-list-artist' / '.cell-vote-playlist-artist' for
  //     RF templates).
  //   - Emitting an empty '.sequence-requests' / '.sequence-votes' element
  //     keyed by sequence name — so RF Page Builder templates that style
  //     these selectors get the right structure even though we don't
  //     currently track per-sequence request counts. The text content stays
  //     empty by default; future feature could populate it.
  //
  // None of this breaks existing canonical RF templates. The added classes
  // are extra, the inner wrapper div doesn't change CSS that targets
  // descendants of '.jukebox-list' (descendant selectors still match through
  // the wrapper), and the data attributes for live updates
  // (data-seq, data-seq-count) are unchanged.
  const rows = sequences.map(seq => {
    const safeNameJs = escapeJsString(seq.name);
    const safeNameAttr = escapeHtml(seq.name);
    const safeDisplay = escapeHtml(seq.display_name);
    const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
    const count = (voteCounts && voteCounts[seq.name]) || 0;
    const bustedUrl = bustCoverUrl(seq.image_url);
    // width="40" is a presentational hint with the LOWEST CSS cascade
    // precedence, so author CSS targeting `.sequence-image`, `.jukebox-list img`,
    // etc. always wins. It's there so RF templates that DON'T declare image
    // rules (4 of RF's 6 default templates style at most via descendants) still
    // render images at a sensible thumbnail size instead of the album art's
    // native ~300×300, which dominates the row and breaks the page's rhythm.
    // 40 matches `.sequence-image { height: 40px }` in the-og and
    // lumos-light-show, the canonical RF defaults; browsers infer height from
    // the source's natural aspect ratio (square covers → 40px tall).
    //
    // We deliberately do NOT set a `height` attribute. height="40" was here
    // historically but it conflicts with author CSS like `aspect-ratio: 1/1`
    // (the HTML `height` attribute fights aspect-ratio in some browsers,
    // producing a 40px-tall horizontal slice of the source image — broken
    // covers, especially visible on dark album art). Letting the browser
    // infer height from natural aspect ratio works for both worlds:
    // CSS-less templates get a square 40px thumbnail; modern templates with
    // `aspect-ratio`/`width: 100%` rules get the layout they intended.
    const artImg = bustedUrl
      ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(bustedUrl)}" alt="" width="40" loading="lazy" />`
      : '';

    if (mode === 'VOTING') {
      // Voting mode: two-cell row — left cell is clickable (name + image + artist),
      // right cell is the vote count. .voting_table on the wrapper is a flex container,
      // and .cell-vote-playlist (85% width) + .cell-vote (15% width) are siblings.
      // The inner <div> exists for '.sequence-item > div' selectors.
      return `<div class="cell-vote-playlist sequence-item" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="cell-vote-playlist-artist sequence-artist">${safeArtist}</div><span class="sequence-votes" data-seq-votes="${safeNameAttr}">${count}</span></div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
    } else {
      // Jukebox mode: each card is one clickable item with album art + title + artist.
      // The template's .jukebox_table is a flex/grid container of these cards.
      return `<div class="jukebox-list sequence-item" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="jukebox-list-artist sequence-artist">${safeArtist}</div><span class="sequence-requests" data-seq-requests="${safeNameAttr}"></span></div></div>`;
    }
  }).join('');
  return rows;
}

function renderQueue(queue, sequences) {
  if (!queue.length) return '<div class="queue-empty">Queue is empty.</div>';
  const byName = Object.fromEntries(sequences.map(s => [s.name, s]));
  // Wrap each entry in a div (v0.32.13+). RF Page Builder's queue CSS
  // targets `.queue-list > div`; canonical RF templates don't care
  // whether the items are <br/>-separated or <div>-wrapped because they
  // mostly just style the parent .queue-list container.
  return queue.map(entry => {
    const seq = byName[entry.sequence_name];
    return `<div class="queue-item" data-seq="${escapeHtml(entry.sequence_name)}">${escapeHtml(seq?.display_name || entry.sequence_name)}</div>`;
  }).join('');
}

// Substitute every {PLAYLISTS} occurrence with markup matching its
// enclosing mode container (v0.33.8+). Called AFTER the dynamic-
// container substitutions so the per-mode markers are in the text.
//
// Why per-slot context: a dual-mode template has two {PLAYLISTS} —
// one inside <div data-showpilot-container="jukebox">, one inside
// <div data-showpilot-container="voting">. If both are filled with
// the active mode's markup, the inactive (hidden) container has
// wrong-shape rows — and the moment admin flips modes and the
// inactive container becomes visible, viewers see jukebox-shaped
// rows in a voting layout (or vice versa) for a beat before the
// client-side rebuild catches up. Filling each slot with its OWN
// container's mode at server-render eliminates that flash entirely.
//
// Algorithm: find each {PLAYLISTS} occurrence in order. For each,
// determine the slot's mode by scanning backwards in the already-
// substituted text for the most recent unclosed
// `<div ... data-showpilot-container="X">`. Emit the matching
// markup. If no enclosing container is found, fall back to the
// active mode (single-mode templates work this way).
function substitutePlaylistsContextAware(html, sequences, activeMode, voteCountsMap, raceTapCountsMap) {
  const placeholder = '{PLAYLISTS}';
  const parts = [];
  let cursor = 0;

  while (cursor < html.length) {
    const idx = html.indexOf(placeholder, cursor);
    if (idx < 0) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, idx));

    // Determine slot mode. Look at the text we've accumulated so far
    // (parts.join('') is what's been emitted up to this point) and
    // count opening / closing <div> tags after the most recent
    // data-showpilot-container marker. If the marker is "open" (its
    // div hasn't been closed yet by a balancing </div>), the slot
    // is inside that container.
    const accum = parts.join('');
    // In RACE mode, always render race markup regardless of which container
    // the {PLAYLISTS} slot is inside. A standard dual-mode template has its
    // {PLAYLISTS} inside jukebox/voting containers — detectEnclosingContainerMode
    // would return 'JUKEBOX' or 'VOTING', and the jukebox/voting rows would
    // render (hidden by their containers, but wrong shape). Force RACE so the
    // tap-button grid is what's actually emitted into all slots.
    const slotMode = activeMode === 'RACE' ? 'RACE' : (detectEnclosingContainerMode(accum) || activeMode);

    parts.push(renderPlaylistGrid(sequences, slotMode, voteCountsMap, raceTapCountsMap));
    cursor = idx + placeholder.length;
  }

  return parts.join('');
}

// Given the HTML emitted so far, return 'JUKEBOX' or 'VOTING' if the
// current cursor position is inside an open mode-container, else
// null. We don't need a real HTML parser — the markers are
// well-known, the templates are simple, and ambiguous cases (a
// <div data-showpilot-container=...> inside another such container)
// don't occur in practice. We do a tag-balance walk from the most
// recent marker.
function detectEnclosingContainerMode(emittedSoFar) {
  // Find the LAST occurrence of any mode marker (jukebox, voting, or race).
  const jukeIdx = emittedSoFar.lastIndexOf('data-showpilot-container="jukebox"');
  const voteIdx = emittedSoFar.lastIndexOf('data-showpilot-container="voting"');
  const raceIdx = emittedSoFar.lastIndexOf('data-showpilot-container="race"');
  const lastIdx = Math.max(jukeIdx, voteIdx, raceIdx);
  if (lastIdx < 0) return null;
  let slotMode;
  if (lastIdx === raceIdx) slotMode = 'RACE';
  else slotMode = jukeIdx > voteIdx ? 'JUKEBOX' : 'VOTING';

  // Walk forward from the marker, balancing <div...> opens against
  // </div> closes. The marker is INSIDE an opening <div ...> tag, so
  // we start at depth 1. If we ever return to depth 0 before hitting
  // the cursor (end of emittedSoFar), the container is closed and we
  // are NOT inside it.
  let depth = 1;
  // Scan from the end of the opening tag containing the marker. The
  // opening tag ends at the first '>' after lastIdx.
  const tagEnd = emittedSoFar.indexOf('>', lastIdx);
  if (tagEnd < 0) return null;
  let i = tagEnd + 1;

  const openRe = /<div\b[^>]*>/gi;
  const closeStr = '</div>';

  while (i < emittedSoFar.length) {
    openRe.lastIndex = i;
    const openMatch = openRe.exec(emittedSoFar);
    const closeMatch = emittedSoFar.indexOf(closeStr, i);

    const openAt = openMatch ? openMatch.index : -1;
    const closeAt = closeMatch;

    if (openAt < 0 && closeAt < 0) break;

    if (closeAt >= 0 && (openAt < 0 || closeAt < openAt)) {
      depth--;
      if (depth === 0) return null; // exited the container
      i = closeAt + closeStr.length;
    } else {
      depth++;
      i = openAt + openMatch[0].length;
    }
  }

  return slotMode;
}

function renderTemplate(template, state) {
  if (!template) return '<!-- No template available -->';

  // Backward compatibility: callers historically passed `template.html` as a
  // string. Now we'd rather have the whole row so we can use other fields
  // (like favicon_url). Detect both shapes.
  const templateHtml = typeof template === 'string' ? template : template.html;
  const templateRow = typeof template === 'string' ? {} : template;
  if (!templateHtml) return '<!-- Template has no HTML -->';

  const cfg = state.config || {};
  const mode = cfg.viewer_control_mode || 'OFF';
  // After-hours == "viewer control is off". When admin flips the mode to OFF,
  // {after-hours-message} blocks become visible and the jukebox/voting blocks
  // hide (they're already gated separately on mode === 'JUKEBOX' / 'VOTING').
  // A future "show hours" config could OR additional conditions in here.
  const isAfterHours = mode === 'OFF';
  const locationCodeRequired = cfg.location_code_enabled === 1;
  const voteCountsMap = {};
  (state.voteCounts || []).forEach(v => { voteCountsMap[v.sequence_name] = v.count; });
  // Race tap counts map: sequenceName → count (only populated in RACE mode)
  const raceTapCountsMap = {};
  (state.raceTapCounts || []).forEach(r => { raceTapCountsMap[r.sequence_name] = r.count; });

  let html = templateHtml;

  // ---- Normalize document structure (v0.33.12) ----
  // RF community templates are wildly inconsistent about top-level structure:
  // some have a full `<!doctype html><html><head></head><body></body></html>`,
  // some have `<!doctype html><html>` but no head/body, some are just naked
  // body content with neither. Our subsequent injections (compat reset, title,
  // favicon, demo banner, etc.) all assumed they could blindly prepend strings
  // to the top of the template — which works fine when the template is naked,
  // but produces a mess when the template HAS its own DOCTYPE. The result:
  //   <style>demo banner css</style>
  //   <div>demo banner</div>
  //   <head>...injected stuff...</head>
  //   <!doctype html>          <-- IGNORED because not first
  //   <html>...
  // The browser sees content before the DOCTYPE and falls back to QUIRKS MODE,
  // which has a different box model, font sizing, and viewport behavior. On
  // mobile especially, this produces hard-to-debug "everything looks small"
  // and "things don't fit right" symptoms even when each individual fix is
  // correct in isolation.
  //
  // Fix: normalize the template to always start with a well-formed DOCTYPE +
  // <html> + <head></head> structure BEFORE running any other injection. Then
  // every subsequent injection can target `<head>` and trust it exists.
  //
  // Steps:
  //   1. Strip any existing DOCTYPE from anywhere in the template.
  //   2. Strip the outermost <html ...> opening tag (if present) and matching
  //      </html> close. We re-add ours.
  //   3. Detect existing <head>...</head>. If present, keep its contents.
  //      If absent, insert an empty <head></head>.
  //   4. Re-emit as: <!DOCTYPE html>\n<html>\n<head>...</head>\n<body-content>
  //      (We don't add <body> tags — most RF templates don't have one and
  //      browsers auto-create body anyway. Adding one risks double-wrapping.)
  {
    // Strip DOCTYPE wherever it appears.
    html = html.replace(/<!doctype\s+html\s*>/gi, '');

    // Capture and remove the outermost <html ...> opening tag.
    html = html.replace(/<html\b[^>]*>/i, '');
    // Close tag last, since templates that lack <html> open also lack </html>
    // close — if it's there we drop it; if not, no-op.
    html = html.replace(/<\/html\s*>\s*$/i, '');

    // Extract existing <head>...</head> if any. Use a non-greedy match and
    // tolerate attributes on the head opening tag (rare but possible).
    let headInner = '';
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
    if (headMatch) {
      headInner = headMatch[1];
      html = html.replace(headMatch[0], '');
    }

    // Detect existing <body>. If a template has its own <body>, we leave it
    // alone — its existing structure works. If absent (the common RF case,
    // since RF templates were designed to be embedded inside RF's page
    // shell), wrap the remaining content in <body>...</body> so subsequent
    // injections that target <body> (demo banner, PWA, admin pill, winner
    // toast) have an anchor and don't fall back to "prepend to document"
    // — which would land BEFORE the DOCTYPE and re-trigger quirks mode.
    const hasBody = /<body\b/i.test(html);
    const bodyContent = html.replace(/^\s+/, '');
    const bodyWrapped = hasBody ? bodyContent : `<body>\n${bodyContent}\n</body>`;

    // Reassemble. Leading whitespace stripped so DOCTYPE is genuinely first.
    html = `<!DOCTYPE html>\n<html>\n<head>${headInner}</head>\n${bodyWrapped}`;
  }

  // ---- Content placeholders ----
  const nowDisplay = state.nowPlaying
    ? (state.sequences.find(s => s.name === state.nowPlaying)?.display_name || state.nowPlaying)
    : '—';
  const nextDisplay = state.nextScheduled
    ? (state.sequences.find(s => s.name === state.nextScheduled)?.display_name || state.nextScheduled)
    : '—';

  // Wrap text placeholders in spans with data attributes so compat JS can update them live
  html = html.split('{NOW_PLAYING}').join(
    `<span class="now-playing-text" data-showpilot-now>${escapeHtml(nowDisplay)}</span>`
  );
  html = html.split('{NEXT_PLAYLIST}').join(
    `<span data-showpilot-next>${escapeHtml(nextDisplay)}</span>`
  );

  // {NOW_PLAYING_TIMER} (v0.32.9+) — countdown of time remaining in the
  // current sequence. RF compat: same placeholder name, same general
  // behavior. Server-side we compute the initial mm:ss based on
  // started_at and duration; client-side rf-compat ticks it every
  // second. Renders --:-- when no song is playing or the duration is
  // unknown (sequence row missing duration_seconds), 0:00 once time
  // expires. Format is always m:ss (no leading zero on minutes — matches
  // typical media-player display).
  const initialTimerText = computeInitialTimerText(
    state.nowPlayingStartedAtIso,
    state.nowPlayingDurationSeconds
  );
  html = html.split('{NOW_PLAYING_TIMER}').join(
    `<span data-showpilot-timer>${initialTimerText}</span>`
  );

  // {NOW_PLAYING_IMAGE} (v0.32.13+) — emits an <img> of the currently-
  // playing sequence's cover art. ShowPilot extension to the RF placeholder
  // vocabulary, added because some third-party page-building tools generate
  // templates that put '{NOW_PLAYING}' inside an image wrapper, expecting an
  // image — but RF's spec is that {NOW_PLAYING} is the song NAME (text).
  // Rather than guess from context, we offer this explicit placeholder for
  // template authors who want the image. Renders as nothing if no song is
  // playing or the sequence has no cover art (so layout doesn't break).
  // The src is updated client-side by rf-compat on song change.
  // The width/height attributes are presentational hints with the lowest CSS
  // cascade precedence — author CSS targeting `.sequence-image` or
  // `.now-playing-image` overrides them. They exist so RF templates that
  // don't style these classes don't render the now-playing cover at native
  // resolution. 80 is a touch larger than the playlist-row 40 since this
  // is the "hero" image; templates that want bigger will override.
  const nowPlayingSeq = state.nowPlaying
    ? state.sequences.find(s => s.name === state.nowPlaying)
    : null;
  const nowPlayingImageUrl = nowPlayingSeq && nowPlayingSeq.image_url
    ? bustCoverUrl(nowPlayingSeq.image_url)
    : '';
  html = html.split('{NOW_PLAYING_IMAGE}').join(
    nowPlayingImageUrl
      ? `<img class="sequence-image now-playing-image" data-showpilot-now-img src="${escapeHtml(nowPlayingImageUrl)}" alt="" width="80" height="80" />`
      : `<img class="sequence-image now-playing-image" data-showpilot-now-img src="" alt="" width="80" height="80" style="display:none" />`
  );

  html = html.split('{QUEUE_SIZE}').join(
    `<span data-showpilot-queue-size>${(state.queue || []).length}</span>`
  );
  html = html.split('{QUEUE_DEPTH}').join(String(cfg.jukebox_queue_depth || 0));
  // {LOCATION_CODE} emits an input field when location-code mode is enabled,
  // or an empty string when it's off (so templates that always include the
  // placeholder don't leave a stray input visible).
  html = html.split('{LOCATION_CODE}').join(
    locationCodeRequired
      ? `<input id="locationCodeInput" type="text" inputmode="numeric" autocomplete="off" placeholder="Enter access code" style="text-align:center;font-size:1.1rem;padding:0.5em 0.75em;border-radius:6px;border:1px solid #888;max-width:200px;display:block;margin:0.5rem auto;" />`
      : ''
  );
  html = html.split('{JUKEBOX_QUEUE}').join(
    `<div data-showpilot-queue-list>${renderQueue(state.queue || [], state.sequences || [])}</div>`
  );

  // ---- Attribute-style placeholders ----
  // Each placeholder substitutes to attributes inserted directly into
  // an opening tag. We emit two things:
  //   1. data-showpilot-container="<mode>" — a marker rf-compat uses
  //      to live-toggle visibility on mode change without a reload.
  //   2. The HTML5 `hidden` boolean attribute when the container
  //      should be hidden at server-render time. We use `hidden`
  //      rather than `style="display:none"` because:
  //        - A template author may already have a `style="..."` on
  //          the same opening tag; emitting a second `style` attr
  //          is invalid HTML and browsers honor only the first one
  //          (so our display:none would be silently dropped). This
  //          was a real bug observed in the wild — see v0.33.8 notes.
  //        - `hidden` is one boolean attribute, can't conflict, and
  //          rf-compat toggles via removeAttribute('hidden') /
  //          setAttribute('hidden', '') for symmetry.
  //        - Inline `style.display = 'none'` set by JS still works
  //          for backwards-compat with templates that built their
  //          own visibility logic.
  //
  // NOTE: We MUST do these container substitutions BEFORE {PLAYLISTS}
  // so the per-slot context-aware logic below can see the markers
  // and pick the right per-mode markup for each {PLAYLISTS}.
  html = html.split('{jukebox-dynamic-container}').join(
    `data-showpilot-container="jukebox"${(mode === 'JUKEBOX') ? '' : ' hidden'}`
  );
  // Alias: 2 of RF's 6 default templates (lumos-light-show, on-air) use
  // {playlist-standard-dynamic-container} instead of {jukebox-dynamic-container}
  // to mark the jukebox-mode block. Substituting to the same marker means
  // the per-slot context-aware {PLAYLISTS} detector below treats both
  // alias forms identically without any detector change.
  html = html.split('{playlist-standard-dynamic-container}').join(
    `data-showpilot-container="jukebox"${(mode === 'JUKEBOX') ? '' : ' hidden'}`
  );
  html = html.split('{playlist-voting-dynamic-container}').join(
    `data-showpilot-container="voting"${(mode === 'VOTING') ? '' : ' hidden'}`
  );
  html = html.split('{location-code-dynamic-container}').join(
    `data-showpilot-container="locationcode"${locationCodeRequired ? '' : ' hidden'}`
  );
  html = html.split('{after-hours-message}').join(
    `data-showpilot-container="afterhours"${isAfterHours ? '' : ' hidden'}`
  );
  // Race mode container (v0.33.155+). Templates that include this container
  // can use it to show race-specific UI. But race mode also works on templates
  // that DON'T have it — rf-compat.js hides the jukebox/voting containers
  // and injects the race UI directly into the {PLAYLISTS} placeholder output.
  html = html.split('{race-dynamic-container}').join(
    `data-showpilot-container="race"${mode === 'RACE' ? '' : ' hidden'}`
  );
  // {VOTES} is documented in RF's placeholder list but never actually
  // emitted in markup (only appears inside <!-- doc comments -->). We
  // strip it so a hand-written template using it doesn't leak literal
  // braces. Per-row vote counts are already part of {PLAYLISTS} output.
  html = html.split('{VOTES}').join('');

  // ---- {PLAYLISTS} substitution ----
  // RACE mode: {PLAYLISTS} slots live inside jukebox/voting containers which
  // are hidden in RACE mode — rendering race rows into them would produce
  // invisible content. Instead, blank out all {PLAYLISTS} occurrences and
  // inject a single race grid div directly before </body> so it's always
  // visible regardless of what container structure the template uses.
  //
  // Non-race modes: use the existing context-aware substitutor so each
  // {PLAYLISTS} slot gets markup matching its enclosing container type.
  if (mode === 'RACE') {
    html = html.split('{PLAYLISTS}').join('');
    const raceGridHtml =
      `<div id="showpilot-race-grid" style="max-width:720px;margin:0 auto;padding:8px 16px;position:relative;z-index:10;">` +
      renderRaceGrid(state.sequences || [], raceTapCountsMap) +
      `</div>`;
    // Prefer injecting inside .wrapper so the race UI sits in the natural
    // content flow of the template (above the footer, inside any background
    // layers). Fall back to before </body> if no wrapper div is found.
    if (html.includes('class="wrapper"') || html.includes("class='wrapper'")) {
      // Insert before the closing </div> of the first .wrapper
      // We find the wrapper opening tag then walk to its closing </div>
      const wrapperRe = /(<div[^>]*class=["'][^"']*\bwrapper\b[^"']*["'][^>]*>)/;
      const wm = wrapperRe.exec(html);
      if (wm) {
        // Find the matching closing </div> by tracking depth
        let depth = 1, i = wm.index + wm[0].length;
        while (i < html.length && depth > 0) {
          const nextOpen  = html.indexOf('<div', i);
          const nextClose = html.indexOf('</div>', i);
          if (nextClose < 0) break;
          if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
          else { depth--; if (depth === 0) { html = html.slice(0, nextClose) + raceGridHtml + html.slice(nextClose); break; } i = nextClose + 6; }
        }
      } else {
        html = html.includes('</body>') ? html.replace('</body>', raceGridHtml + '</body>') : html + raceGridHtml;
      }
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', raceGridHtml + '</body>');
    } else {
      html += raceGridHtml;
    }
  } else {
    html = substitutePlaylistsContextAware(
      html,
      state.sequences || [],
      mode,
      voteCountsMap,
      raceTapCountsMap
    );
  }

  // ---- Inject <title> from cfg.show_name if the template doesn't define its own ----
  // We only inject when the template's <head> has no <title> at all. If the user
  // wrote their own <title> in the template HTML, we respect it. This keeps the
  // global Show Name as a sensible default while leaving advanced users in
  // control if they want template-specific titles.
  const hasTitle = /<title[^>]*>/i.test(html);
  if (!hasTitle && cfg.show_name) {
    const safeTitle = String(cfg.show_name).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const titleTag = `<title>${safeTitle}</title>\n`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', titleTag + '</head>');
    } else if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + titleTag);
    } else {
      // Template has no <head> at all — prepend a minimal head so the title
      // exists in the served HTML for the browser tab. Browsers tolerate
      // <title> outside <head> in quirks mode anyway, but proper structure
      // is friendlier to clients that parse strictly.
      html = `<head>${titleTag}</head>\n` + html;
    }
  }

  // ---- Inject viewport meta if the template doesn't have one (v0.33.13) ----
  // Without `<meta name="viewport">`, mobile browsers fall back to a virtual
  // 980px viewport and scale the rendered page DOWN to fit the actual screen
  // width. On a 360px-wide phone, that's a 0.37x scale — every 24px font
  // becomes ~9px. The desktop preview iframe doesn't apply this scaling, so
  // the same template looks fine in preview but tiny on phone.
  //
  // Of RF's 6 default templates, only dynamic-menu declares a viewport meta —
  // its author was the only one who tested on mobile. The other 5 (and most
  // community templates derived from them, including the popular Rick Harris
  // red-and-white that Will's Christmas template descends from) lack one.
  // RF's hosted page shell injects a viewport meta for free; we have to do
  // it ourselves.
  //
  // Conservative: only inject when the template HAS NOT declared one. If the
  // author wrote `<meta name="viewport" content="width=1200">` (rare, but
  // some kiosk templates do this), we respect their choice.
  const hasViewport = /<meta[^>]*name\s*=\s*["']?viewport["']?/i.test(html);
  if (!hasViewport) {
    const viewportTag = `<meta name="viewport" content="width=device-width, initial-scale=1.0">\n`;
    if (html.includes('<head>')) {
      // Insert right after <head> so it's near the top of the head — viewport
      // meta should appear before any layout-affecting CSS so the browser can
      // size the layout viewport correctly during initial parse.
      html = html.replace('<head>', '<head>' + viewportTag);
    } else if (html.includes('</head>')) {
      html = html.replace('</head>', viewportTag + '</head>');
    }
    // If neither tag exists at this point, the template normalization step
    // earlier in this function should have created an empty <head></head>.
    // Falling through silently here is fine.
  }

  // ---- Inject RF-compat CSS reset (v0.33.11) ----
  // RF community templates frequently rely on platform-level CSS resets that
  // ShowPilot doesn't provide for free. Two specific issues in the wild:
  //
  //   1. Many RF templates (e.g. the popular "red-and-white" by Rick Harris)
  //      use img widths >100% (e.g. `style="width: 105%"`) for a deliberate
  //      bleed effect. RF's platform shell sets `overflow-x: hidden` on the
  //      page, so the overflow is clipped silently. We don't, so the page
  //      gets a horizontal scrollbar on phones.
  //
  //   2. Many RF templates declare a global `div { font-size: 11px }` as a
  //      page-wide base rule, then override it on specific classes
  //      (.jukebox-list { font-size: 24px }, etc.) and rely on those
  //      overrides reaching the visible text. Our v0.32.13 inner-wrapper
  //      <div> (added for RF Page Builder's `.sequence-item > div` selector)
  //      has no class, so the 11px base hits IT directly — and any text
  //      inside (the .sequence-name span, the .sequence-artist sub-div)
  //      inherits 11px instead of the outer .jukebox-list 24px.
  //
  // Both are fixed by a tiny low-specificity reset injected at the top of
  // <head>:
  //   - `html { overflow-x: hidden }` clips horizontal overflow without
  //      conflicting with author body styles.
  //   - `.jukebox-list > div, .cell-vote-playlist > div { font-size: inherit }`
  //      forces our injected wrapper to inherit from the outer
  //      .jukebox-list / .cell-vote-playlist (which the template DOES style),
  //      bypassing the global `div` rule. Class+child specificity (0,1,1)
  //      beats the element-only `div` rule (0,0,1), and any author CSS that
  //      explicitly targets `.sequence-name` / `.sequence-artist` (also
  //      class specificity) appears LATER in the cascade so author rules
  //      still win.
  // Runs AFTER title injection so a template with no <head> already has one
  // we can splice into, keeping the head structure tidy.
  const compatResetCss = `<style id="showpilot-rf-compat-reset">
html { overflow-x: hidden; }
.jukebox-list > div, .cell-vote-playlist > div { font-size: inherit; }
</style>
`;
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + compatResetCss);
  } else if (html.includes('</head>')) {
    html = html.replace('</head>', compatResetCss + '</head>');
  } else {
    // No <head> at all (and title wasn't needed either) — prepend so the rule
    // exists before any visible content. Browsers tolerate <style> outside head.
    html = compatResetCss + html;
  }

  // ---- Inject custom favicon link into <head> if the template has one set ----
  // We don't try to detect or replace existing <link rel="icon"> tags the user
  // may have hand-written into their template — instead we append our tag. The
  // last <link rel="icon"> in the head wins per browser spec, so a custom
  // template that hardcoded its own favicon would still get overridden by an
  // explicit favicon set in the admin UI. That's the right precedence: UI
  // setting is the authoritative source.
  if (templateRow.favicon_url) {
    const safeUrl = String(templateRow.favicon_url).replace(/"/g, '&quot;');
    // Mime type hint helps browsers handle SVG vs PNG vs ICO correctly when
    // the URL doesn't have an extension (e.g. data: URLs). We can't reliably
    // sniff the type from a URL string, so we omit `type=` and let the browser
    // figure it out from the response/data — works fine for common formats.
    const faviconTag = `<link rel="icon" href="${safeUrl}">\n`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', faviconTag + '</head>');
    } else {
      // Template has no <head> at all — prepend the tag at the very top so it
      // at least exists in the served HTML (browsers will treat it as if it
      // were in head as long as it appears before any rendering begins).
      html = faviconTag + html;
    }
  }

  // ---- Inject compat script before </body> ----
  // State is exposed as a JSON blob the compat layer reads on load.
  const bootstrap = {
    mode,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
    // Location code (v0.33.24+): when true, rf-compat reads #locationCodeInput
    // and includes the value in every vote/request body for server-side check.
    requiresLocationCode: cfg.location_code_enabled === 1,
    showName: cfg.show_name,
    // Vote shifting (v0.32.6+): when on, the client lets the user click a
    // different song to change their vote instead of being told they
    // already voted.
    allowVoteChange: cfg.allow_vote_change === 1,
    // Now-playing timer (v0.32.9+) — when set, the client uses these to
    // start ticking the {NOW_PLAYING_TIMER} placeholder before the first
    // /api/state poll arrives. Both null when no song or duration unknown.
    nowPlayingStartedAtIso: state.nowPlayingStartedAtIso || null,
    nowPlayingDurationSeconds: state.nowPlayingDurationSeconds || null,
    pageSnowEnabled: cfg.page_snow_enabled === 1 || cfg.page_effect === 'snow',
    // Page effects (v0.32.0+) — supersedes pageSnowEnabled. The boolean
    // above is now a derived alias kept so existing user templates that
    // hard-coded __SHOWPILOT__.pageSnowEnabled keep behaving sensibly.
    pageEffect: cfg.page_effect || (cfg.page_snow_enabled === 1 ? 'snow' : 'none'),
    pageEffectColor: cfg.page_effect_color || '',
    pageEffectIntensity: cfg.page_effect_intensity || 'medium',
    // Audio gate: tell the client whether the gate is enabled at all. We
    // can't compute "blocked" without the viewer's coords (server-rendered),
    // so we just signal the gate is on; client fetches /api/visual-config
    // with its location to get the actual blocked state.
    audioGateEnabled: cfg.audio_gate_enabled === 1,
    // When the audio gate is on AND coordinates are configured, expose the
    // show coords + radius so the client-side player can do continuous
    // proximity checks via watchPosition() and react in seconds instead of
    // waiting for the next periodic server re-check. The server is still
    // authoritative — it does its own geofence check on every audio-stream
    // request — but having the coords client-side means we cut audio off
    // the moment a listener walks/drives away rather than up to 5 minutes
    // later.
    //
    // We only emit coords when both lat AND lng are truthy (non-zero). This
    // mirrors the server's skip logic at routes/viewer.js — if an admin
    // enabled the gate but never configured coordinates, the gate quietly
    // passes everything (better than blocking everyone). The client-side
    // watcher then doesn't start either (no coords to compare against),
    // and we degrade to the periodic server check alone.
    //
    // No privacy concern: the show's address is public (it's literally a
    // light show people drive to), so the coordinates aren't sensitive.
    audioGateLatitude:
      cfg.audio_gate_enabled === 1 && cfg.show_latitude && cfg.show_longitude
        ? cfg.show_latitude
        : null,
    audioGateLongitude:
      cfg.audio_gate_enabled === 1 && cfg.show_latitude && cfg.show_longitude
        ? cfg.show_longitude
        : null,
    audioGateRadiusMiles:
      cfg.audio_gate_enabled === 1 && cfg.show_latitude && cfg.show_longitude
        ? (cfg.audio_gate_radius_miles || 0.5)
        : null,
    // Master audio kill-switch (v0.28.0+). When false, the viewer hides
    // the launcher button entirely and skips audio polling. Used when
    // admin delivers audio externally (PulseMesh, FM, Icecast) and
    // doesn't want ShowPilot involved at all. The launcher is still
    // built but stays display:none so we don't have to restructure
    // initListenOnPhone() — it just never becomes visible.
    audioEnabled: cfg.audio_enabled !== 0,
    // Listen-on-phone launcher button customization (v0.26.0+).
    // Defaults preserve the original red 🎧 button for installs that
    // never touch these settings. The viewer-side code reads these on
    // initial render to construct the launcher; live changes require a
    // viewer page reload (acceptable — it's a one-time cosmetic).
    launcherIconSource: cfg.launcher_icon_source || 'default',
    launcherIconData: cfg.launcher_icon_data || '',
    launcherShowChrome: cfg.launcher_show_chrome !== 0,  // default true
    launcherSize: cfg.launcher_size || 'medium',
    // Race mode (v0.33.155+)
    raceActive: cfg.race_active === 1,
    raceEndsAt: cfg.race_ends_at || null,       // ISO timestamp or null
    raceWinner: cfg.race_winner || null,         // sequence_name of winner or null
    raceTargetTaps: cfg.race_target_taps || 0,  // 0 = time-limit only
    raceDurationSeconds: cfg.race_duration_seconds || 60,
  };

  // ---- Inject race CSS when mode is RACE (v0.33.155+) ----
  // Self-contained stylesheet for the race UI. Injected server-side so it
  // works on any template without the author needing to write race-specific
  // CSS. Uses CSS custom properties so authors CAN override if they want.
  if (mode === 'RACE') {
    const raceCss = `<style id="showpilot-race-ui">
:root {
  --race-bg: rgba(0,0,0,0.55);
  --race-border: rgba(255,255,255,0.12);
  --race-bar-bg: rgba(255,255,255,0.1);
  --race-bar-fill: #ff6b35;
  --race-bar-leader: #ffd700;
  --race-btn-bg: #ff6b35;
  --race-btn-active: #ff8c5a;
  --race-btn-text: #fff;
  --race-text: #fff;
  --race-artist: rgba(255,255,255,0.6);
  --race-radius: 12px;
  --race-tap-scale: 0.93;
}
.race-row {
  background: var(--race-bg);
  border: 1px solid var(--race-border);
  border-radius: var(--race-radius);
  padding: 12px 14px;
  margin-bottom: 10px;
  transition: box-shadow 0.2s;
}
.race-row.race-leading {
  border-color: var(--race-bar-leader);
  box-shadow: 0 0 12px rgba(255,215,0,0.3);
}
.race-row-info {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.race-cover {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
}
.race-row-text {
  flex: 1;
  min-width: 0;
}
.race-song-name {
  display: block;
  font-weight: 600;
  color: var(--race-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.race-song-artist {
  display: block;
  font-size: 0.8em;
  color: var(--race-artist);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.race-tap-count {
  font-size: 1.4em;
  font-weight: 700;
  color: var(--race-text);
  min-width: 2.5ch;
  text-align: right;
  flex-shrink: 0;
  transition: transform 0.1s;
}
.race-tap-count.race-bump {
  transform: scale(1.35);
  color: var(--race-bar-leader);
}
.race-bar-track {
  height: 8px;
  background: var(--race-bar-bg);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 10px;
}
.race-bar-fill {
  height: 100%;
  background: var(--race-bar-fill);
  border-radius: 4px;
  transition: width 0.25s ease-out;
}
.race-row.race-leading .race-bar-fill {
  background: var(--race-bar-leader);
}
.race-tap-btn {
  width: 100%;
  padding: 14px;
  background: var(--race-btn-bg);
  color: var(--race-btn-text);
  border: none;
  border-radius: 8px;
  font-size: 1.1em;
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: transform 0.1s, background 0.1s;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
}
.race-tap-btn:active {
  transform: scale(var(--race-tap-scale));
  background: var(--race-btn-active);
}
.race-tap-btn:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}
/* Race timer bar (countdown strip at top of race area) */
#showpilot-race-timer-bar {
  height: 5px;
  background: var(--race-bar-fill);
  border-radius: 3px;
  margin-bottom: 14px;
  transition: width 1s linear;
}
/* Race countdown text */
#showpilot-race-countdown {
  text-align: center;
  font-size: 0.85em;
  color: var(--race-artist);
  margin-bottom: 12px;
}
/* Winner overlay */
#showpilot-race-winner-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0,0,0,0.85);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  animation: raceWinnerIn 0.4s cubic-bezier(0.34,1.56,0.64,1);
}
#showpilot-race-winner-overlay.active { display: flex; }
@keyframes raceWinnerIn {
  from { opacity: 0; transform: scale(0.7); }
  to   { opacity: 1; transform: scale(1); }
}
.race-winner-flag {
  font-size: 4em;
  margin-bottom: 12px;
  animation: raceFlagWave 0.6s ease-in-out infinite alternate;
}
@keyframes raceFlagWave {
  from { transform: rotate(-8deg) scale(1); }
  to   { transform: rotate(8deg) scale(1.1); }
}
.race-winner-label {
  font-size: 1em;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--race-bar-leader);
  margin-bottom: 8px;
}
.race-winner-song {
  font-size: 2em;
  font-weight: 800;
  color: #fff;
  margin-bottom: 6px;
  text-shadow: 0 0 20px rgba(255,215,0,0.6);
}
.race-winner-artist {
  font-size: 1em;
  color: var(--race-artist);
  margin-bottom: 28px;
}
.race-winner-taps {
  font-size: 0.9em;
  color: var(--race-bar-leader);
  margin-bottom: 24px;
}
/* Confetti pieces */
.race-confetti-piece {
  position: fixed;
  width: 10px;
  height: 10px;
  opacity: 0;
  animation: raceConfettiFall linear forwards;
  border-radius: 2px;
  pointer-events: none;
}
@keyframes raceConfettiFall {
  0%   { opacity: 1; transform: translateY(0) rotate(0deg); }
  100% { opacity: 0; transform: translateY(100vh) rotate(720deg); }
}
.race-instructions {
  text-align: center;
  color: var(--race-artist);
  font-size: 0.9em;
  margin-bottom: 14px;
  padding: 0 4px;
}
.race-instructions p { margin: 0; }
</style>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', raceCss + '</head>');
    } else {
      html = raceCss + html;
    }
  }
  // Socket.io client is needed for live position updates from the
  // plugin (v0.20.0+). Without it, viewer falls back to extrapolating
  // from track-start, which has the FPP buffer-delay bias problem
  // (phone audio plays ahead of speakers). We load it before
  // rf-compat.js so window.io is defined when the audio code initializes.
  //
  // Loaded from same origin (/socket.io/socket.io.js) — the path is
  // served automatically by the socket.io middleware on the server.
  // No CDN dependency. Cheap to include even if the client doesn't
  // need it; ~80KB minified, browser-cached after first load.
  const injection = `
  <div id="showpilot-race-winner-overlay" role="dialog" aria-modal="true" aria-label="Race winner"></div>
  <script>window.__SHOWPILOT__ = ${JSON.stringify(bootstrap)};</script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="/rf-compat.js?v=72"></script>
  `;
  if (html.includes('</body>')) {
    html = html.replace('</body>', injection + '</body>');
  } else {
    html = html + injection;
  }

  // ---- Demo banner (v0.31.0+) ----
  // The viewer template is operator-editable, so we don't bake the
  // banner into a specific spot. Instead we inject a small CSS+HTML+JS
  // bundle right after <body> that:
  //   - renders a pinned banner above all page content
  //   - polls /api/public/demo-status (cheap, unauthenticated)
  //   - hides itself if demoMode is off (the common case)
  //
  // Falls back to appending at the end if the user removed <body> from
  // their template — which would break a lot more than this banner, but
  // we don't want to fail loudly here.
  const demoBannerInjection = `
  <style>
    #showpilot-demo-banner {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 10px 16px;
      background: linear-gradient(90deg, #ff7a3c, #ffb155);
      color: #1a0e00;
      font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: center;
      flex-wrap: wrap;
      position: relative;
      z-index: 10000;
      box-shadow: 0 1px 0 rgba(0,0,0,.15);
    }
    #showpilot-demo-banner strong {
      font-size: 11px; font-weight: 700;
      letter-spacing: .06em; text-transform: uppercase;
      padding: 2px 7px; border-radius: 3px;
      background: rgba(0,0,0,.18); color: #fff;
    }
    #showpilot-demo-banner code {
      background: rgba(0,0,0,.22); color: #fff;
      padding: 2px 7px; border-radius: 3px;
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #showpilot-demo-banner .sep { opacity: .35; }
    #showpilot-demo-banner .cd { font-variant-numeric: tabular-nums; font-weight: 600; }
  </style>
  <div id="showpilot-demo-banner" role="status" aria-live="polite">
    <strong>Demo</strong>
    <span>Live demo &mdash; feel free to break things</span>
    <span class="sep" data-creds hidden>&middot;</span>
    <span data-creds hidden>Login: <code class="creds-text"></code></span>
    <span class="sep">&middot;</span>
    <span>Resets in <span class="cd">&mdash;</span></span>
  </div>
  <script>
  (function(){
    var b = document.getElementById('showpilot-demo-banner');
    if (!b) return;
    var cd = b.querySelector('.cd');
    var credsEls = b.querySelectorAll('[data-creds]');
    var credsText = b.querySelector('.creds-text');
    var nextAt = null;
    function fmt(ms){
      if (ms <= 0) return 'now';
      var t = Math.floor(ms/1000);
      var m = Math.floor(t/60), s = t%60;
      return m + ':' + (s<10?'0':'') + s;
    }
    function tick(){ if (nextAt) cd.textContent = fmt(nextAt - Date.now()); }
    function refresh(){
      fetch('/api/public/demo-status', { credentials: 'omit' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          if (!d || !d.demoMode) { b.style.display = 'none'; return; }
          b.style.display = 'flex';
          if (d.credentialsHint && credsText){
            credsText.textContent = d.credentialsHint;
            credsEls.forEach(function(el){ el.hidden = false; });
          }
          if (d.nextResetAt){
            var t = Date.parse(d.nextResetAt);
            if (isFinite(t)) nextAt = t;
          }
          tick();
        }).catch(function(){});
    }
    refresh();
    setInterval(tick, 1000);
    setInterval(refresh, 60000);
  })();
  </script>
  `;
  if (html.includes('<body')) {
    // Insert immediately AFTER the body opening tag — find the closing
    // ">" of <body ...> and inject after it. We can't use a naive
    // <body> match because templates often have attributes/classes.
    html = html.replace(/(<body[^>]*>)/i, '$1' + demoBannerInjection);
  } else {
    // No body tag — prepend. Less ideal but the banner still renders.
    html = demoBannerInjection + html;
  }

  // ---- PWA manifest + service worker (v0.23.0+) ----
  // When admin has enabled "Install as App" for the viewer, inject the
  // manifest link and service-worker registration. Browsers require
  // BOTH a manifest reference in <head> AND a registered service worker
  // for PWA install eligibility. The manifest itself is served by
  // /viewer-manifest.json (gated server-side by the same flag — so
  // injecting the link without enabling the flag would just produce
  // a 404 on the manifest, harmless).
  if (cfg.pwa_viewer_enabled === 1) {
    const pwaHead = `
  <link rel="manifest" href="/viewer-manifest.json" />
  <meta name="theme-color" content="#000000" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/viewer-icon" />
`;
    // Inject a small floating "Install" button that appears when the
    // browser fires beforeinstallprompt. Bottom-left so it doesn't
    // interfere with the audio player (typically bottom-right). Uses
    // the configured icon. Auto-hides after install or dismiss.
    //
    // Style is intentionally subtle — a small pill, not a full bar —
    // because the viewer template is the main visual experience and
    // we don't want to obscure it. Listeners who care will see the
    // button; everyone else can ignore it.
    const pwaScript = `
  <script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js').catch(function(err) {
        console.warn('[ShowPilot PWA] service worker registration failed:', err);
      });
    });
  }
  // Capture beforeinstallprompt and surface a button. The button is
  // hidden by default (no point showing it before the browser is
  // ready), shown when the event fires, and removed after the user
  // either installs or dismisses. localStorage flag prevents re-showing
  // after dismissal — pressing dismiss many times in a row is annoying.
  (function() {
    var DISMISSED_KEY = 'showpilot_pwa_install_dismissed';
    if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    var btn = null;
    function makeBtn() {
      btn = document.createElement('div');
      btn.id = 'showpilot-pwa-install';
      btn.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.85);color:#fff;padding:8px 14px;border-radius:24px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.4);backdrop-filter:blur(8px);cursor:pointer;border:1px solid rgba(255,255,255,0.15);';
      var img = document.createElement('img');
      img.src = '/viewer-icon';
      img.alt = '';
      img.style.cssText = 'width:24px;height:24px;border-radius:6px;';
      var label = document.createElement('span');
      label.textContent = 'Install app';
      label.style.cssText = 'font-weight:500;';
      var dismiss = document.createElement('span');
      dismiss.textContent = '×';
      dismiss.style.cssText = 'opacity:0.6;font-size:18px;line-height:1;padding:0 4px;margin-left:4px;';
      dismiss.onclick = function(e) {
        e.stopPropagation();
        localStorage.setItem(DISMISSED_KEY, '1');
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      };
      btn.appendChild(img);
      btn.appendChild(label);
      btn.appendChild(dismiss);
      btn.onclick = function() {
        if (window.__deferredInstallPrompt) {
          window.__deferredInstallPrompt.prompt();
          window.__deferredInstallPrompt.userChoice.finally(function() {
            window.__deferredInstallPrompt = null;
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          });
        }
      };
      document.body.appendChild(btn);
    }
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      window.__deferredInstallPrompt = e;
      // Defer slightly so we don't show during the initial paint. Lets
      // the user see the page first, then notice the button.
      setTimeout(function() { if (!btn) makeBtn(); }, 1500);
    });
    // Hide button if the app gets installed via another path.
    window.addEventListener('appinstalled', function() {
      localStorage.setItem(DISMISSED_KEY, '1');
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    });
  })();
  </script>
`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', pwaHead + '</head>');
    } else {
      // Fallback: prepend at the start. Less ideal but functional.
      html = pwaHead + html;
    }
    if (html.includes('</body>')) {
      html = html.replace('</body>', pwaScript + '</body>');
    } else {
      html = html + pwaScript;
    }
  }

  // ---- Admin shortcut pill (v0.23.6+) ----
  // When the request comes from someone with a valid admin session,
  // render a small floating button that takes them to the admin
  // dashboard. Anonymous viewers don't see this — it's invisible to
  // anyone not already logged in as admin. Saves the round-trip of
  // "view show, want to tweak something, type out admin URL."
  //
  // Server-side detection (state.isAdmin) is preferred over client-side
  // because the admin session cookie is httpOnly and can't be read by JS.
  // The button is positioned in the top-right (out of the way of the
  // bottom-left install pill from the PWA injection above).
  if (state.isAdmin) {
    const adminPill = `
  <a href="/admin/" id="showpilot-admin-pill" title="Open admin dashboard"
     style="position:fixed;top:14px;right:14px;z-index:9999;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(0,0,0,0.75);color:#fff;text-decoration:none;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:500;border-radius:18px;border:1px solid rgba(255,255,255,0.2);box-shadow:0 2px 8px rgba(0,0,0,0.3);backdrop-filter:blur(6px);">
    <span aria-hidden="true" style="font-size:14px;line-height:1;">⚙</span>
    <span>Admin</span>
  </a>
`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', adminPill + '</body>');
    } else {
      html = html + adminPill;
    }
  }

  // ---- Voting winner toast (v0.23.7+) ----
  // Always injected (not gated by mode) — the listener is cheap and a
  // mode change shouldn't require a page refresh to receive winner
  // notifications. The toast only renders when the server emits
  // 'votingRoundEnded', which only happens during voting mode.
  //
  // Designed to celebrate the winner without obscuring the player or
  // covering the song list. Centered at the top with auto-dismiss.
  // socket.io is already loaded by the rf-compat injection above, so
  // we don't need to re-include it here — just hook the existing
  // window.io connection or open a new one if not yet established.
  const winnerToast = `
  <style>
    #showpilot-winner-toast {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(-120%);
      z-index: 9998;
      max-width: calc(100vw - 32px);
      min-width: 240px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      /* Themable colors — templates can override --showpilot-toast-* CSS
         variables to match their palette. The defaults are a neutral
         dark gradient that works across most themes (Halloween orange,
         Christmas blue, Independence Day red/blue/white, etc.) without
         clashing. Templates that want a stronger color can set just
         --showpilot-toast-bg and --showpilot-toast-text. */
      background: var(--showpilot-toast-bg, linear-gradient(135deg, rgba(30, 30, 40, 0.96), rgba(15, 15, 25, 0.96)));
      color: var(--showpilot-toast-text, #fff);
      border: 1px solid var(--showpilot-toast-border, rgba(255, 255, 255, 0.18));
      font-family: var(--showpilot-toast-font, system-ui, -apple-system, sans-serif);
      font-size: 14px;
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      transition: transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.3s;
      pointer-events: none;
      opacity: 0;
    }
    #showpilot-winner-toast.shown {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
    #showpilot-winner-toast .swt-img {
      width: 44px; height: 44px;
      border-radius: 8px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(0,0,0,0.2);
    }
    #showpilot-winner-toast .swt-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    #showpilot-winner-toast .swt-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.85;
      color: var(--showpilot-toast-accent, inherit);
    }
    #showpilot-winner-toast .swt-name {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70vw;
    }
    #showpilot-winner-toast .swt-artist {
      font-size: 12px;
      opacity: 0.85;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70vw;
    }
  </style>
  <script>
  (function() {
    function showWinnerToast(data) {
      if (!data || !data.displayName) return;
      // Match toast colors to current player theme. The helper is set up
      // by rf-compat.js when applyDecoration runs; if it's not yet
      // available (race during page load), we just skip and use defaults.
      try { if (typeof window.ShowPilotApplyPlayerThemeToToast === 'function') {
        window.ShowPilotApplyPlayerThemeToToast();
      }} catch (_) {}
      // Build (or reuse) the toast element. Single shared element so
      // rapid successive winners don't pile up multiple toasts on screen.
      var toast = document.getElementById('showpilot-winner-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'showpilot-winner-toast';
        document.body.appendChild(toast);
      }
      var imgHtml = data.imageUrl
        ? '<img class="swt-img" src="' + data.imageUrl.replace(/"/g,'&quot;') + '" alt="" />'
        : '<div class="swt-img"></div>';
      var artistHtml = data.artist
        ? '<span class="swt-artist">' + String(data.artist).replace(/</g,'&lt;') + '</span>'
        : '';
      toast.innerHTML = imgHtml +
        '<div class="swt-body">' +
        '<span class="swt-label">🎉 Winner!</span>' +
        '<span class="swt-name">' + String(data.displayName).replace(/</g,'&lt;') + '</span>' +
        artistHtml +
        '</div>';
      // Show via class so the CSS transition handles slide-in.
      // requestAnimationFrame ensures the browser has applied the
      // initial styles before the .shown class triggers the transition;
      // without it, fresh-created elements skip the animation.
      requestAnimationFrame(function() {
        toast.classList.add('shown');
      });
      // Auto-dismiss after 6 seconds. The transition handles slide-out.
      // Clear any prior dismiss timer so successive wins don't fight.
      if (toast.__dismissTimer) clearTimeout(toast.__dismissTimer);
      toast.__dismissTimer = setTimeout(function() {
        toast.classList.remove('shown');
      }, 6000);
    }

    // Hook up to the socket.io connection. rf-compat.js already opens
    // one for live position updates; we either reuse it (if exposed)
    // or open our own. Either way is cheap and idempotent.
    function connectSocket() {
      if (typeof io === 'undefined') {
        // socket.io.js hasn't loaded yet — try again shortly. The rf-compat
        // injection loads it; this just covers the race window before
        // that script runs.
        setTimeout(connectSocket, 250);
        return;
      }
      try {
        var sock = io();
        sock.on('votingRoundEnded', showWinnerToast);
      } catch (e) {
        console.warn('[ShowPilot] Could not subscribe to voting events:', e);
      }
    }
    connectSocket();
  })();
  </script>
`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', winnerToast + '</body>');
  } else {
    html = html + winnerToast;
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
