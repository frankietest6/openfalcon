// ============================================================
// Visual Designer Renderer
//
// Two source-of-truth modes feed HTML output:
//   - Settings mode: a form-filled object (showName, colors, fonts, etc.)
//                    is poured into a managed template.
//   - Blocks mode:   an ordered array of {type, props} blocks; each block
//                    type knows how to render itself.
//
// Both produce HTML that contains a marker comment so the designer can
// detect whether a template was generated (and therefore safe to round-trip
// back into the form) or hand-coded.
// ============================================================

const MANAGED_MARKER_SETTINGS = '<!-- OF_MANAGED:settings -->';
const MANAGED_MARKER_BLOCKS = '<!-- OF_MANAGED:blocks -->';

// ============================================================
// SETTINGS MODE — form-based template
// ============================================================

// Default values for the settings form. The form fills these in and the
// resulting object goes through renderSettingsTemplate().
const DEFAULT_SETTINGS = {
  showName: 'My Christmas Show',
  subtitle: 'Welcome to our 2025 Light Show',
  introText: 'Tune your radio to 98.9 FM to listen along, or use the Listen on Phone button at the bottom.',
  fmFrequency: '98.9 FM',
  showHoursLine1: 'Daily 7:00 PM – 9:00 PM',
  showHoursLine2: 'Christmas Eve & Day: 5:00 PM – 11:00 PM',

  // Colors
  bgGradientStart: '#0a0e27',
  bgGradientEnd: '#1a1f3a',
  primaryColor: '#dc2626',     // accent / hero / primary CTA
  textColor: '#ffffff',
  mutedColor: '#cbd5e1',

  // Fonts
  fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
  titleFontFamily: 'inherit',

  // Background image (optional — if set, overlays gradient)
  bgImageUrl: '',

  // Social links (optional — empty strings hide the link)
  socialFacebook: '',
  socialInstagram: '',
  socialYouTube: '',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

function renderSettingsTemplate(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const showName = escapeHtml(s.showName);
  const subtitle = escapeHtml(s.subtitle);
  const introText = escapeHtml(s.introText);
  const fmFreq = escapeHtml(s.fmFrequency);
  const hours1 = escapeHtml(s.showHoursLine1);
  const hours2 = escapeHtml(s.showHoursLine2);

  const socialBits = [];
  if (s.socialFacebook) socialBits.push(`<a href="${escapeAttr(s.socialFacebook)}" target="_blank" rel="noopener">Facebook</a>`);
  if (s.socialInstagram) socialBits.push(`<a href="${escapeAttr(s.socialInstagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (s.socialYouTube) socialBits.push(`<a href="${escapeAttr(s.socialYouTube)}" target="_blank" rel="noopener">YouTube</a>`);

  const bgLayer = s.bgImageUrl
    ? `background-image: url('${escapeAttr(s.bgImageUrl)}'), linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)});
       background-size: cover; background-position: center; background-attachment: fixed;`
    : `background: linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)}); background-attachment: fixed;`;

  return `${MANAGED_MARKER_SETTINGS}
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    ${bgLayer}
    color: ${escapeAttr(s.textColor)};
    font-family: ${s.fontFamily};
    min-height: 100vh;
    padding-bottom: 110px;
    overflow-x: hidden;
  }
  .of-page-wrap { max-width: 720px; margin: 0 auto; padding: 1.25rem; }
  .of-hero { text-align: center; padding: 2rem 1rem 1rem; }
  .of-hero-title {
    font-family: ${s.titleFontFamily === 'inherit' ? s.fontFamily : s.titleFontFamily};
    font-size: clamp(36px, 9vw, 56px);
    font-weight: 800;
    color: ${escapeAttr(s.primaryColor)};
    margin: 0;
    line-height: 1.1;
    text-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
  .of-hero-subtitle {
    font-size: clamp(18px, 4vw, 24px);
    margin: 0.5rem 0 0;
    opacity: 0.92;
  }
  .of-intro {
    font-size: clamp(15px, 4vw, 18px);
    line-height: 1.5;
    margin: 1rem auto;
    max-width: 560px;
    color: ${escapeAttr(s.mutedColor)};
  }
  .of-section-title {
    font-family: ${s.titleFontFamily === 'inherit' ? s.fontFamily : s.titleFontFamily};
    color: ${escapeAttr(s.primaryColor)};
    text-align: center;
    font-size: clamp(24px, 6vw, 32px);
    margin: 1.5rem 0 0.5rem;
  }
  .of-card {
    background: rgba(0,0,0,0.35);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    padding: 1rem;
    margin: 0.75rem 0;
  }
  .of-now-playing {
    text-align: center;
    font-size: clamp(20px, 5vw, 26px);
    font-weight: 700;
    text-shadow: 0 0 8px rgba(255,255,255,0.2);
    margin: 0.5rem 0;
  }
  .of-divider {
    height: 3px;
    background: linear-gradient(90deg, transparent, ${escapeAttr(s.primaryColor)} 20%, ${escapeAttr(s.primaryColor)} 80%, transparent);
    border-radius: 2px;
    margin: 1.25rem auto;
    width: 90%;
  }
  /* Song list cards */
  #playlists_container, .rtable {
    display: flex; flex-direction: column; gap: 8px;
    margin: 1rem auto; width: 100%;
  }
  .rtable { flex-direction: row; flex-wrap: wrap; gap: 8px 0; align-items: stretch; }
  .cell-vote-playlist, .jukebox-list {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; min-height: 64px;
    background: rgba(0,0,0,0.4);
    border: 2px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    color: ${escapeAttr(s.textColor)};
    font-size: clamp(15px, 4vw, 18px);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
    line-height: 1.25;
  }
  .cell-vote-playlist { width: calc(100% - 80px); border-radius: 10px 0 0 10px; }
  .cell-vote-playlist:hover, .cell-vote-playlist:active,
  .jukebox-list:hover, .jukebox-list:active {
    background: ${escapeAttr(s.primaryColor)}40;
    border-color: ${escapeAttr(s.primaryColor)};
  }
  .cell-vote-playlist:active, .jukebox-list:active { transform: scale(0.98); }
  .cell-vote {
    display: flex; align-items: center; justify-content: center;
    width: 80px; min-height: 64px;
    background: ${escapeAttr(s.primaryColor)};
    border-radius: 0 10px 10px 0;
    color: ${escapeAttr(s.textColor)};
    font-weight: 700;
    font-size: clamp(18px, 5vw, 22px);
  }
  .sequence-image {
    width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
    background: rgba(0,0,0,0.3);
  }
  .cell-vote-playlist-artist, .jukebox-list-artist {
    display: block; width: 100%;
    color: ${escapeAttr(s.mutedColor)}; opacity: 0.85;
    font-size: 0.82em; margin-top: 2px;
  }
  /* Status messages */
  .innerRequestSuccessful, .failed_Info_Box {
    margin: 1rem auto; max-width: 600px; padding: 0.85rem 1rem;
    border-radius: 8px; text-align: center; font-weight: 600;
  }
  .innerRequestSuccessful { background: #16a34a; color: #fff; }
  .failed_Info_Box { background: #ea580c; color: #fff; }
  /* Social */
  .of-social { text-align: center; margin: 1.5rem 0; }
  .of-social a {
    color: ${escapeAttr(s.primaryColor)}; text-decoration: none;
    margin: 0 0.5rem; font-weight: 600;
  }
  .of-social a:hover { text-decoration: underline; }
  @media (max-width: 480px) {
    .of-page-wrap { padding: 0.75rem; }
    body { padding-bottom: 120px; }
    .cell-vote-playlist { width: calc(100% - 60px); padding: 8px 10px; min-height: 56px; gap: 8px; }
    .cell-vote { width: 60px; min-height: 56px; }
    .sequence-image { width: 40px; height: 40px; }
  }
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<div class="of-page-wrap">
  <div class="of-hero">
    <h1 class="of-hero-title">${showName}</h1>
    <p class="of-hero-subtitle">${subtitle}</p>
  </div>

  <p class="of-intro">${introText}</p>

  <div class="of-divider"></div>

  <!-- After-hours block — shown only when outside scheduled hours -->
  <div {after-hours-message}>
    <div class="of-section-title">Show Hours</div>
    <div class="of-card" style="text-align: center; font-size: clamp(16px, 4.5vw, 20px); line-height: 1.6;">
      ${hours1}<br />
      ${hours2}
    </div>
  </div>

  <!-- Now Playing — always visible (v0.32.8+).
       Used to be inside {jukebox-dynamic-container}; moved out so voting
       mode shows it too. Up Next moves with it. The Queue list stays
       jukebox-only since there's no "queue" concept in voting. -->
  <div>
    <div class="of-section-title">Now Playing</div>
    <div class="of-now-playing">{NOW_PLAYING}</div>
    <div class="of-divider"></div>
    <div class="of-section-title">Up Next</div>
    <div class="of-now-playing" style="font-weight: 500; font-size: clamp(16px, 4.5vw, 20px);">{NEXT_PLAYLIST}</div>
  </div>

  <!-- Jukebox queue list — jukebox-only (voting mode has no queue) -->
  <div {jukebox-dynamic-container}>
    <div class="of-section-title">Queue ({QUEUE_SIZE})</div>
    <div class="of-card">{JUKEBOX_QUEUE}</div>
    <div class="of-divider"></div>
  </div>

  <!-- Voting instructions -->
  <div {playlist-voting-dynamic-container}>
    <div class="of-section-title">Vote For Your Favorite</div>
    <p class="of-intro">Tap any song to vote — the winner plays next!</p>
  </div>

  <!-- Jukebox instructions -->
  <div {jukebox-dynamic-container}>
    <div class="of-section-title">Pick Your Favorite</div>
    <p class="of-intro">Up to {QUEUE_DEPTH} songs in the queue. Tap to add yours.</p>
  </div>

  <!-- Location code (only if enabled) -->
  <div {location-code-dynamic-container}>
    <p class="of-intro" style="color: ${escapeAttr(s.primaryColor)};">Enter the code below to submit a request:</p>
    <div style="text-align: center;">{LOCATION_CODE}</div>
  </div>

  <!-- Voting list -->
  <div {playlist-voting-dynamic-container}>
    <div class="rtable">{PLAYLISTS}</div>
  </div>

  <!-- Jukebox list -->
  <div {jukebox-dynamic-container}>
    <div id="playlists_container">{PLAYLISTS}</div>
  </div>

  ${socialBits.length ? `<div class="of-social">${socialBits.join(' · ')}</div>` : ''}

  <!-- Status messages — DON'T DELETE -->
  <div id="requestSuccessful" style="display:none"><div class="innerRequestSuccessful">Successfully Added!</div></div>
  <div id="requestFailed" style="display:none"><div class="failed_Info_Box">An unexpected error has occurred.</div></div>
  <div id="requestPlaying" style="display:none"><div class="failed_Info_Box">SONG ALREADY REQUESTED</div></div>
  <div id="queueFull" style="display:none"><div class="failed_Info_Box">QUEUE FULL — max {QUEUE_DEPTH}</div></div>
  <div id="invalidLocation" style="display:none"><div class="failed_Info_Box">INVALID LOCATION</div></div>
  <div id="alreadyVoted" style="display:none"><div class="failed_Info_Box">ALREADY VOTED — wait for the next round.</div></div>
  <div id="invalidLocationCode" style="display:none"><div class="failed_Info_Box">INVALID CODE</div></div>
</div>
`;
}

// ============================================================
// BLOCKS MODE — drag-and-drop section assembly
// ============================================================

// Each block type has:
//   - label: human name shown in the picker
//   - description: short blurb
//   - defaultProps: object of editable values
//   - render(props): returns HTML string
//
// Block HTML can include placeholders like {NOW_PLAYING}, etc. — those are
// resolved by the regular template renderer downstream.

const BLOCK_TYPES = {
  hero: {
    label: 'Hero',
    description: 'Big page title with optional subtitle',
    defaultProps: {
      title: 'My Christmas Show',
      subtitle: 'Welcome!',
      titleColor: '#dc2626',
    },
    render(p) {
      return `
<div style="text-align:center; padding: 2rem 1rem 1rem;">
  <h1 style="font-size: clamp(36px, 9vw, 56px); font-weight: 800;
             color: ${escapeAttr(p.titleColor)}; margin: 0; line-height: 1.1;
             text-shadow: 0 2px 12px rgba(0,0,0,0.4);">${escapeHtml(p.title)}</h1>
  ${p.subtitle ? `<p style="font-size: clamp(18px, 4vw, 24px); margin: 0.5rem 0 0; opacity: 0.92;">${escapeHtml(p.subtitle)}</p>` : ''}
</div>`;
    },
  },

  text: {
    label: 'Text Block',
    description: 'A paragraph of text — instructions, FM frequency, etc.',
    defaultProps: { content: 'Tune your radio to 98.9 FM!', color: '#ffffff', size: 'medium' },
    // Prop type hints (v0.32.10+). Used by the admin block editor to render
    // the right control for each prop. The render() function below only
    // knows how to handle three size values, so a free-text input was the
    // wrong control — users could type anything and silently get the
    // medium fallback. A dropdown matches the actual valid set.
    // Other props don't need explicit types; the editor's auto-inference
    // (color string → color picker, boolean → checkbox, long string →
    // textarea, else → text input) handles them correctly.
    propTypes: {
      size: {
        type: 'enum',
        options: [
          { value: 'small',  label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large',  label: 'Large' },
        ],
      },
    },
    render(p) {
      const sizes = { small: '14px', medium: 'clamp(15px, 4vw, 18px)', large: 'clamp(18px, 5vw, 22px)' };
      return `<p style="text-align:center; max-width: 560px; margin: 1rem auto;
                       font-size: ${sizes[p.size] || sizes.medium};
                       color: ${escapeAttr(p.color)}; line-height: 1.5;">${escapeHtml(p.content)}</p>`;
    },
  },

  divider: {
    label: 'Divider',
    description: 'Horizontal accent line',
    defaultProps: { color: '#dc2626' },
    render(p) {
      return `<div style="height: 3px; background: linear-gradient(90deg, transparent, ${escapeAttr(p.color)} 20%, ${escapeAttr(p.color)} 80%, transparent); border-radius: 2px; margin: 1.25rem auto; width: 90%;"></div>`;
    },
  },

  showHours: {
    label: 'Show Hours',
    description: 'Hours of operation — only shown when show is offline',
    defaultProps: {
      title: 'Show Hours',
      line1: 'Daily 7:00 PM – 9:00 PM',
      line2: 'Halloween Night: 6:00 PM – 10:00 PM',
      titleColor: '#dc2626',
    },
    render(p) {
      return `
<div {after-hours-message}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">${escapeHtml(p.title)}</h2>
  <div style="background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1);
              border-radius: 10px; padding: 1rem; max-width: 560px; margin: 0.75rem auto;
              text-align: center; font-size: clamp(16px, 4.5vw, 20px); line-height: 1.6;">
    ${escapeHtml(p.line1)}<br />
    ${escapeHtml(p.line2)}
  </div>
</div>`;
    },
  },

  nowPlaying: {
    label: 'Now Playing',
    description: 'Currently playing song (visible in all modes)',
    defaultProps: { titleColor: '#dc2626' },
    render(p) {
      // v0.32.8+: this block is no longer wrapped in {jukebox-dynamic-container}.
      // It's always visible — the server returns the current song regardless
      // of mode, so showing it in voting/off mode is correct.
      return `
<div>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Now Playing</h2>
  <div style="text-align:center; font-size: clamp(20px, 5vw, 26px); font-weight: 700; margin: 0.5rem 0;">{NOW_PLAYING}</div>
</div>`;
    },
  },

  nextUp: {
    label: 'Up Next',
    description: 'Next song (queue head in jukebox, vote leader in voting)',
    defaultProps: { titleColor: '#dc2626' },
    render(p) {
      // v0.32.8+: standalone block for the upcoming song. Always visible.
      // The server computes nextScheduled the right way per mode (queue
      // head in JUKEBOX, current vote leader in VOTING, schedule otherwise),
      // so a single placeholder works for everything. The existing 'queue'
      // block still has a showNext flag that does the same thing inside the
      // jukebox-only queue — that's left alone for backward compatibility,
      // but new templates should prefer this standalone block.
      return `
<div>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Up Next</h2>
  <div style="text-align:center; font-size: clamp(16px, 4.5vw, 20px); margin: 0.5rem 0;">{NEXT_PLAYLIST}</div>
</div>`;
    },
  },

  queue: {
    label: 'Queue',
    description: 'Current jukebox queue (jukebox mode only)',
    defaultProps: { titleColor: '#dc2626', showCount: true, showNext: true },
    render(p) {
      return `
<div {jukebox-dynamic-container}>
  ${p.showNext ? `
    <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Up Next</h2>
    <div style="text-align:center; font-size: clamp(16px, 4.5vw, 20px); margin: 0.5rem 0;">{NEXT_PLAYLIST}</div>` : ''}
  ${p.showCount ? `
    <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Queue ({QUEUE_SIZE})</h2>` : ''}
  <div style="background: rgba(0,0,0,0.35); border-radius: 10px; padding: 1rem; max-width: 560px; margin: 0.5rem auto; text-align: center;">{JUKEBOX_QUEUE}</div>
</div>`;
    },
  },

  votingInstructions: {
    label: 'Voting Instructions',
    description: 'Voting mode header + brief how-to',
    defaultProps: { titleColor: '#dc2626', text: 'Tap any song to vote — the winner plays next!' },
    render(p) {
      return `
<div {playlist-voting-dynamic-container}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Vote For Your Favorite</h2>
  <p style="text-align:center; max-width: 560px; margin: 0.5rem auto 1rem; font-size: clamp(15px, 4vw, 18px);">${escapeHtml(p.text)}</p>
</div>`;
    },
  },

  jukeboxInstructions: {
    label: 'Jukebox Instructions',
    description: 'Jukebox mode header + brief how-to',
    defaultProps: { titleColor: '#dc2626', text: 'Up to {QUEUE_DEPTH} songs in the queue. Tap to add yours.' },
    render(p) {
      return `
<div {jukebox-dynamic-container}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Pick Your Favorite</h2>
  <p style="text-align:center; max-width: 560px; margin: 0.5rem auto 1rem; font-size: clamp(15px, 4vw, 18px);">${escapeHtml(p.text)}</p>
</div>`;
    },
  },

  songList: {
    label: 'Song List',
    description: 'The list of sequences (auto-renders for current mode)',
    defaultProps: {},
    render() {
      return `
<div {playlist-voting-dynamic-container}><div class="rtable">{PLAYLISTS}</div></div>
<div {jukebox-dynamic-container}><div id="playlists_container">{PLAYLISTS}</div></div>`;
    },
  },

  locationCode: {
    label: 'Location Code',
    description: 'Code-entry field (only shown if location code is enabled)',
    defaultProps: { promptText: 'Enter the code on our sign:', promptColor: '#dc2626' },
    render(p) {
      return `
<div {location-code-dynamic-container}>
  <p style="text-align:center; max-width: 560px; margin: 1rem auto;
            font-size: clamp(15px, 4vw, 18px); color: ${escapeAttr(p.promptColor)};">${escapeHtml(p.promptText)}</p>
  <div style="text-align:center;">{LOCATION_CODE}</div>
</div>`;
    },
  },

  socialLinks: {
    label: 'Social Links',
    description: 'Links to your social pages',
    defaultProps: { facebook: '', instagram: '', youtube: '', linkColor: '#dc2626' },
    render(p) {
      const links = [];
      if (p.facebook) links.push(`<a href="${escapeAttr(p.facebook)}" target="_blank" rel="noopener" style="color: ${escapeAttr(p.linkColor)}; text-decoration: none; margin: 0 0.5rem; font-weight: 600;">Facebook</a>`);
      if (p.instagram) links.push(`<a href="${escapeAttr(p.instagram)}" target="_blank" rel="noopener" style="color: ${escapeAttr(p.linkColor)}; text-decoration: none; margin: 0 0.5rem; font-weight: 600;">Instagram</a>`);
      if (p.youtube) links.push(`<a href="${escapeAttr(p.youtube)}" target="_blank" rel="noopener" style="color: ${escapeAttr(p.linkColor)}; text-decoration: none; margin: 0 0.5rem; font-weight: 600;">YouTube</a>`);
      if (!links.length) return '<!-- (no social links configured) -->';
      return `<div style="text-align:center; margin: 1.5rem 0;">${links.join(' · ')}</div>`;
    },
  },

  customHtml: {
    label: 'Custom HTML',
    description: 'Raw HTML you want to include',
    defaultProps: { html: '<!-- your HTML here -->' },
    render(p) {
      // NOT escaped — this is the whole point of a custom block.
      // User is responsible for valid HTML.
      return p.html || '';
    },
  },
};

function listBlockTypes() {
  return Object.entries(BLOCK_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    defaultProps: def.defaultProps,
    // propTypes (v0.32.10+) — optional per-prop control hints used by
    // the admin block editor. When absent, the editor falls back to
    // auto-inference based on the prop's value (color/bool/long-text/text).
    // Send null when there are no hints so the JSON shape is consistent.
    propTypes: def.propTypes || null,
  }));
}

function renderBlocksTemplate(blocks, settings) {
  // settings provides the page-wrapping body styles (bg color, font, etc.)
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const bgLayer = s.bgImageUrl
    ? `background-image: url('${escapeAttr(s.bgImageUrl)}'), linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)});
       background-size: cover; background-position: center; background-attachment: fixed;`
    : `background: linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)}); background-attachment: fixed;`;

  const blockHtml = (blocks || []).map(b => {
    const def = BLOCK_TYPES[b.type];
    if (!def) return `<!-- unknown block type: ${escapeHtml(b.type)} -->`;
    const props = { ...def.defaultProps, ...(b.props || {}) };
    try { return def.render(props); }
    catch (e) { return `<!-- error rendering ${escapeHtml(b.type)}: ${escapeHtml(e.message)} -->`; }
  }).join('\n');

  // Common shell shared across blocks layouts (CSS for song list, status messages, etc.)
  return `${MANAGED_MARKER_BLOCKS}
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    ${bgLayer}
    color: ${escapeAttr(s.textColor)};
    font-family: ${s.fontFamily};
    min-height: 100vh;
    padding-bottom: 110px;
    overflow-x: hidden;
  }
  /* Song list cards (used by Song List block) */
  #playlists_container, .rtable {
    display: flex; flex-direction: column; gap: 8px;
    margin: 1rem auto; max-width: 720px; padding: 0 1rem;
  }
  .rtable { flex-direction: row; flex-wrap: wrap; gap: 8px 0; align-items: stretch; }
  .cell-vote-playlist, .jukebox-list {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; min-height: 64px;
    background: rgba(0,0,0,0.4); border: 2px solid rgba(255,255,255,0.1);
    border-radius: 10px; color: ${escapeAttr(s.textColor)};
    font-size: clamp(15px, 4vw, 18px); cursor: pointer; line-height: 1.25;
  }
  .cell-vote-playlist { width: calc(100% - 80px); border-radius: 10px 0 0 10px; }
  .cell-vote-playlist:hover, .jukebox-list:hover {
    background: ${escapeAttr(s.primaryColor)}40; border-color: ${escapeAttr(s.primaryColor)};
  }
  .cell-vote {
    display: flex; align-items: center; justify-content: center;
    width: 80px; min-height: 64px; background: ${escapeAttr(s.primaryColor)};
    border-radius: 0 10px 10px 0; color: #fff; font-weight: 700;
    font-size: clamp(18px, 5vw, 22px);
  }
  .sequence-image { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
  .cell-vote-playlist-artist, .jukebox-list-artist {
    display: block; width: 100%; opacity: 0.7; font-size: 0.82em; margin-top: 2px;
  }
  .innerRequestSuccessful, .failed_Info_Box {
    margin: 1rem auto; max-width: 600px; padding: 0.85rem 1rem;
    border-radius: 8px; text-align: center; font-weight: 600;
  }
  .innerRequestSuccessful { background: #16a34a; color: #fff; }
  .failed_Info_Box { background: #ea580c; color: #fff; }
  @media (max-width: 480px) {
    .cell-vote-playlist { width: calc(100% - 60px); padding: 8px 10px; min-height: 56px; gap: 8px; }
    .cell-vote { width: 60px; min-height: 56px; }
    .sequence-image { width: 40px; height: 40px; }
  }
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

${blockHtml}

<!-- Status messages — required by client JS -->
<div id="requestSuccessful" style="display:none"><div class="innerRequestSuccessful">Successfully Added!</div></div>
<div id="requestFailed" style="display:none"><div class="failed_Info_Box">An unexpected error has occurred.</div></div>
<div id="requestPlaying" style="display:none"><div class="failed_Info_Box">SONG ALREADY REQUESTED</div></div>
<div id="queueFull" style="display:none"><div class="failed_Info_Box">QUEUE FULL — max {QUEUE_DEPTH}</div></div>
<div id="invalidLocation" style="display:none"><div class="failed_Info_Box">INVALID LOCATION</div></div>
<div id="alreadyVoted" style="display:none"><div class="failed_Info_Box">ALREADY VOTED</div></div>
<div id="invalidLocationCode" style="display:none"><div class="failed_Info_Box">INVALID CODE</div></div>
`;
}

// Detect if a template's HTML was generated by the visual designer
function detectMode(html) {
  if (!html) return 'code';
  if (html.includes(MANAGED_MARKER_SETTINGS)) return 'settings';
  if (html.includes(MANAGED_MARKER_BLOCKS)) return 'blocks';
  return 'code';
}

module.exports = {
  DEFAULT_SETTINGS,
  BLOCK_TYPES,
  listBlockTypes,
  renderSettingsTemplate,
  renderBlocksTemplate,
  detectMode,
  MANAGED_MARKER_SETTINGS,
  MANAGED_MARKER_BLOCKS,
};
