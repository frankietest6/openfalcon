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
  <script src="/rf-compat.js?v=49"></script>
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
