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
//   {playlist-voting-dynamic-container}
//   {location-code-dynamic-container}
//   {after-hours-message}
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
    const bustedUrl = bustCoverUrl(seq.image_url);
    const artImg = bustedUrl
      ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(bustedUrl)}" alt="" loading="lazy" />`
      : '';

    if (mode === 'VOTING') {
      // Voting mode: two-cell row — left cell is clickable (name + image + artist),
      // right cell is the vote count. .voting_table on the wrapper is a flex container,
      // and .cell-vote-playlist (85% width) + .cell-vote (15% width) are siblings.
      return `<div class="cell-vote-playlist" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}">${artImg}${safeDisplay}<div class="cell-vote-playlist-artist">${safeArtist}</div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
    } else {
      // Jukebox mode: each card is one clickable item with album art + title + artist.
      // The template's .jukebox_table is a flex/grid container of these cards.
      return `<div class="jukebox-list" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}">${artImg}${safeDisplay}<div class="jukebox-list-artist">${safeArtist}</div></div>`;
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

  // Backward compatibility: callers historically passed `template.html` as a
  // string. Now we'd rather have the whole row so we can use other fields
  // (like favicon_url). Detect both shapes.
  const templateHtml = typeof template === 'string' ? template : template.html;
  const templateRow = typeof template === 'string' ? {} : template;
  if (!templateHtml) return '<!-- Template has no HTML -->';

  const cfg = state.config || {};
  const mode = cfg.viewer_control_mode || 'OFF';
  const isAfterHours = false; // TODO: wire to show hours config when that exists
  const locationCodeRequired = false; // TODO: when location-code mode is built
  const voteCountsMap = {};
  (state.voteCounts || []).forEach(v => { voteCountsMap[v.sequence_name] = v.count; });

  let html = templateHtml;

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
  html = html.split('{QUEUE_SIZE}').join(
    `<span data-showpilot-queue-size>${(state.queue || []).length}</span>`
  );
  html = html.split('{QUEUE_DEPTH}').join(String(cfg.jukebox_queue_depth || 0));
  html = html.split('{LOCATION_CODE}').join('');
  html = html.split('{JUKEBOX_QUEUE}').join(
    `<div data-showpilot-queue-list>${renderQueue(state.queue || [], state.sequences || [])}</div>`
  );
  html = html.split('{PLAYLISTS}').join(
    renderPlaylistGrid(state.sequences || [], mode, voteCountsMap)
  );

  // ---- Attribute-style placeholders ----
  // Turn RF's placeholder into (1) an inline style and (2) a marker class + data attr
  // so the compat script can live-toggle visibility on mode change.
  html = html.split('{jukebox-dynamic-container}').join(
    `data-showpilot-container="jukebox"${mode === 'JUKEBOX' ? '' : ' style="display:none"'}`
  );
  html = html.split('{playlist-voting-dynamic-container}').join(
    `data-showpilot-container="voting"${mode === 'VOTING' ? '' : ' style="display:none"'}`
  );
  html = html.split('{location-code-dynamic-container}').join(
    locationCodeRequired ? '' : 'style="display:none"'
  );
  html = html.split('{after-hours-message}').join(
    isAfterHours ? '' : 'style="display:none"'
  );

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
    showName: cfg.show_name,
    pageSnowEnabled: cfg.page_snow_enabled === 1,
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
  };
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
  <script>window.__SHOWPILOT__ = ${JSON.stringify(bootstrap)};</script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="/rf-compat.js?v=40"></script>
  `;
  if (html.includes('</body>')) {
    html = html.replace('</body>', injection + '</body>');
  } else {
    html = html + injection;
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

  return html;
}

function getActiveTemplate() {
  const row = db.prepare(`
    SELECT * FROM viewer_page_templates WHERE is_active = 1 LIMIT 1
  `).get();
  return row || null;
}

module.exports = { renderTemplate, getActiveTemplate, escapeHtml };
