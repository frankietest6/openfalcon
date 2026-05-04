// ============================================================
// ShowPilot — Database module
// Uses better-sqlite3 (synchronous, fast, simple).
// Schema is created/migrated on first run.
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config-loader');

// Ensure data directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Schema
// ============================================================

const schema = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  show_name TEXT DEFAULT 'My Light Show',
  viewer_control_mode TEXT DEFAULT 'VOTING',
  last_active_mode TEXT DEFAULT 'VOTING',
  managed_psa_enabled INTEGER DEFAULT 0,
  interrupt_schedule INTEGER DEFAULT 0,
  viewer_page_html TEXT,
  viewer_page_css TEXT,
  admin_password_hash TEXT,
  current_voting_round INTEGER DEFAULT 1,

  -- Jukebox safeguards
  jukebox_queue_depth INTEGER DEFAULT 0,              -- 0 = unlimited
  jukebox_sequence_request_limit INTEGER DEFAULT 3,   -- max times same seq can be in queue (0 = unlimited)
  prevent_multiple_requests INTEGER DEFAULT 1,        -- block if viewer has a request playing/queued
  block_request_currently_playing INTEGER DEFAULT 1,  -- reject jukebox request for the song playing now
  block_request_next_up INTEGER DEFAULT 1,            -- reject jukebox request for the song already next up

  -- Voting safeguards
  prevent_multiple_votes INTEGER DEFAULT 1,
  reset_votes_after_round INTEGER DEFAULT 1,
  block_vote_currently_playing INTEGER DEFAULT 1,     -- reject vote for the song playing now
  block_vote_next_up INTEGER DEFAULT 1,               -- reject vote for the song already winning
  -- Vote shifting (v0.32.6+): when prevent_multiple_votes=1 AND this is on,
  -- a viewer's second vote in a round REPLACES their first instead of being
  -- rejected. Still 1 effective vote per viewer; just lets them change their mind.
  allow_vote_change INTEGER DEFAULT 0,

  -- PSA (Public Service Announcements)
  play_psa_enabled INTEGER DEFAULT 0,
  psa_frequency INTEGER DEFAULT 5,                    -- play a PSA every N (interactions or sequences, see psa_trigger_mode)
  -- psa_trigger_mode (v0.30.0+): how psa_frequency is counted.
  --   'interactions' — every N viewer interactions (votes / jukebox requests).
  --                    PSA only fires when ShowPilot is actively driving
  --                    playback in VOTING or JUKEBOX mode. If the show is
  --                    just running its scheduled playlist with no audience
  --                    voting/requesting, PSAs never fire. Original behavior.
  --   'sequences' —    every N sequences FPP plays (excluding PSAs themselves).
  --                    Fires regardless of viewer interaction. Best for
  --                    schedule-driven shows that want regular sponsor /
  --                    safety reminders.
  psa_trigger_mode TEXT DEFAULT 'interactions',

  -- Viewer-present location check
  check_viewer_present INTEGER DEFAULT 0,
  viewer_present_mode TEXT DEFAULT 'GPS',             -- 'GPS' for now, room for others
  show_latitude REAL DEFAULT 0,
  show_longitude REAL DEFAULT 0,
  check_radius_miles REAL DEFAULT 0.5,

  -- Sequence hiding after play
  hide_sequence_after_played INTEGER DEFAULT 0,       -- N plays before unhiding (0 = never hide)

  -- IP blocking
  blocked_ips TEXT DEFAULT '',                         -- comma-separated

  -- Counters for PSA frequency. Which one is consulted depends on
  -- psa_trigger_mode above. Both increment in their respective code paths
  -- regardless of mode, so switching modes mid-season doesn't hard-reset
  -- to zero — the threshold check just uses the appropriate counter.
  interactions_since_last_psa INTEGER DEFAULT 0,
  sequences_since_last_psa INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  artist TEXT,
  category TEXT,
  image_url TEXT,
  duration_seconds INTEGER,
  visible INTEGER DEFAULT 1,
  votable INTEGER DEFAULT 1,
  jukeboxable INTEGER DEFAULT 1,
  is_psa INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0,
  last_played_at DATETIME,
  plays_since_hidden INTEGER DEFAULT 0,
  -- cooldown_minutes (v0.29.2+): when this sequence starts playing, suppress
  -- it from the request UI / voting ballot for this many minutes, AND purge
  -- any other queued copies of it. 0 = no cooldown (default, original
  -- behavior). Per-sequence so short novelty songs can stay always-requestable
  -- while long centerpieces get breathing room.
  cooldown_minutes INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS viewer_page_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  is_builtin INTEGER DEFAULT 0,    -- built-in templates can't be deleted (only duplicated/modified)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sequence snapshots — save the current sequences list with all metadata
-- (display names, artists, sort order, visibility, etc.) so it can be restored
-- when switching seasons. Useful for "save my Halloween config" → "restore it
-- next year" without re-doing all the playlist customization work.
CREATE TABLE IF NOT EXISTS sequence_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  sequence_count INTEGER DEFAULT 0,    -- denormalized count for fast list display
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sequence_snapshot_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES sequence_snapshots(id) ON DELETE CASCADE,
  -- Mirror of the sequences columns we want to preserve. Excludes runtime
  -- counters like last_played_at and plays_since_hidden.
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  artist TEXT,
  category TEXT,
  media_name TEXT,
  image_url TEXT,
  duration_seconds INTEGER,
  visible INTEGER DEFAULT 1,
  votable INTEGER DEFAULT 1,
  jukeboxable INTEGER DEFAULT 1,
  is_psa INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshot_items ON sequence_snapshot_items(snapshot_id);

-- Users for admin panel access. All users have full admin privileges
-- (no role distinction — keep simple). Per-user "remember me" controls
-- whether the JWT lives 30 days or expires when the browser closes.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  remember_me INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  must_change_password INTEGER DEFAULT 0,    -- forces password change on next login
  last_login_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS now_playing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sequence_name TEXT,                     -- Raw name as received from FPP
  started_at DATETIME,
  next_sequence_name TEXT,                -- What's scheduled next
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jukebox_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL,
  sequence_name TEXT NOT NULL,            -- Denormalized for plugin response
  viewer_token TEXT,
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  played INTEGER DEFAULT 0,               -- 0 = pending or in-flight, 1 = confirmed played
  handed_off_at DATETIME,                 -- When the plugin popped it (in-flight to FPP)
  played_at DATETIME,                     -- When FPP actually started playing it
  FOREIGN KEY (sequence_id) REFERENCES sequences(id)
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL,
  sequence_name TEXT NOT NULL,
  viewer_token TEXT NOT NULL,
  round_id INTEGER NOT NULL,
  voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(viewer_token, round_id),
  FOREIGN KEY (sequence_id) REFERENCES sequences(id)
);

-- Tiebreak votes are tracked separately from main-round votes (v0.24.0+).
-- Why a separate table: lets a main-round voter cast a tiebreak vote
-- without overwriting their main-round vote, and lets us tabulate
-- "tiebreak resolution" without commingling pre- and post-tiebreak votes.
-- The unique constraint enforces "one tiebreak vote per viewer per round."
CREATE TABLE IF NOT EXISTS tiebreak_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_name TEXT NOT NULL,
  viewer_token TEXT NOT NULL,
  round_id INTEGER NOT NULL,
  voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(viewer_token, round_id)
);

CREATE TABLE IF NOT EXISTS active_viewers (
  viewer_token TEXT PRIMARY KEY,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_hash TEXT,
  user_agent TEXT,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_name TEXT NOT NULL,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source TEXT,                            -- 'schedule' | 'jukebox' | 'vote' | 'unknown'
  viewer_count_at_start INTEGER DEFAULT 0
);

-- viewer_visits: one row per viewer page load. Used for unique-visitor and
-- total-visits analytics. visitor_id is a UUID stored in the of_vid cookie
-- (90-day expiry); ip+ua_hash is a fallback identity used when cookies are
-- blocked. Bots are filtered before insertion. preview-mode loads (admin
-- iframe) are skipped so admin tinkering doesn't pollute the stats.
CREATE TABLE IF NOT EXISTS viewer_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT,                        -- UUID from of_vid cookie (NULL if cookie blocked)
  ip TEXT,
  ua_hash TEXT,                           -- short hash of User-Agent, for fallback identity
  visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  path TEXT                               -- e.g. '/', '/halloween' (future-proofing for multi-show)
);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER,                    -- 0 = Sunday, 6 = Saturday; NULL = specific date
  specific_date DATE,                     -- For date-overrides (e.g., Christmas Eve)
  start_time TEXT,                        -- "17:30"
  end_time TEXT,                          -- "22:00"
  active INTEGER DEFAULT 1,
  notes TEXT
);

-- ============================================================
-- audio_cache_files — local cache of FPP audio files
-- ============================================================
-- The plugin uploads audio file bytes to ShowPilot during sync, keyed
-- by the SHA-256 hash of the file contents. Files are stored on disk
-- at data/audio-cache/<hash>.bin; this table maps hashes to the
-- media_name they correspond to. The viewer audio-stream route looks
-- up files by media_name to serve them locally instead of proxying
-- every request through FPP.
--
-- See lib/audio-cache.js for the operations (get/store/link/prune).
CREATE TABLE IF NOT EXISTS audio_cache_files (
  hash TEXT PRIMARY KEY,                  -- SHA-256, hex, 64 chars
  media_name TEXT,                        -- filename as referenced by sequences.media_name
  size_bytes INTEGER,
  mime_type TEXT,                         -- usually 'audio/mpeg' but recorded for completeness
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- In-app updater state (v0.33.0+).
-- Single-row table (id always = 1). Records the previous version we
-- updated FROM so the rollback button knows where to revert to. Cleared
-- after a rollback (no second-level history kept on purpose — see the
-- updater module's design notes).
CREATE TABLE IF NOT EXISTS update_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  previous_version_tag TEXT,              -- e.g. 'v0.32.14'
  previous_version_sha TEXT,              -- the git commit we were on before update
  last_update_at DATETIME,
  last_update_target TEXT                 -- the tag we updated TO (or 'rollback to ...')
);

CREATE INDEX IF NOT EXISTS idx_votes_round ON votes(round_id);
CREATE INDEX IF NOT EXISTS idx_queue_played ON jukebox_queue(played, requested_at);
CREATE INDEX IF NOT EXISTS idx_viewers_seen ON active_viewers(last_seen);
CREATE INDEX IF NOT EXISTS idx_history_played ON play_history(played_at);
CREATE INDEX IF NOT EXISTS idx_visits_at ON viewer_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_visitor ON viewer_visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_audio_cache_media ON audio_cache_files(media_name);
`;

db.exec(schema);

// ============================================================
// Migrations — idempotent column additions for upgrades
// ============================================================

function columnExists(table, column) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(c => c.name === column);
}

if (!columnExists('config', 'last_active_mode')) {
  db.exec(`ALTER TABLE config ADD COLUMN last_active_mode TEXT DEFAULT 'VOTING'`);
}

// Migrations for v0.4.0 safeguards
const configMigrations = [
  ['jukebox_queue_depth', 'INTEGER DEFAULT 0'],
  ['jukebox_sequence_request_limit', 'INTEGER DEFAULT 3'],
  ['prevent_multiple_requests', 'INTEGER DEFAULT 1'],
  // ---- Repeat blockers (v0.31.1+) ----
  // Reject viewer requests/votes for songs that are currently playing or
  // already lined up next, so the same song doesn't play back-to-back.
  // "Next up" is computed the same way the viewer state shows it:
  //   JUKEBOX mode → first item in the queue (or schedule if queue empty)
  //   VOTING mode  → highest-voted song this round (or schedule if none)
  // All four default ON (the more intuitive behavior); admins who want
  // the legacy "anything goes" behavior can untick them.
  ['block_request_currently_playing', 'INTEGER DEFAULT 1'],
  ['block_request_next_up',          'INTEGER DEFAULT 1'],
  ['block_vote_currently_playing',   'INTEGER DEFAULT 1'],
  ['block_vote_next_up',             'INTEGER DEFAULT 1'],
  ['prevent_multiple_votes', 'INTEGER DEFAULT 1'],
  ['reset_votes_after_round', 'INTEGER DEFAULT 1'],
  // Vote shifting (v0.32.6+): when prevent_multiple_votes=1 AND this is on,
  // a viewer's second vote in a round REPLACES their first instead of being
  // rejected. Default off so existing installs keep their current behavior.
  ['allow_vote_change', 'INTEGER DEFAULT 0'],
  // ---- Tiebreak feature (v0.24.0+) ----
  // When enabled and a strict tie exists at the top of the vote count when
  // the plugin asks for a winner, the system enters a tiebreak round
  // instead of falling back to first-vote-wins. During tiebreak, only the
  // tied sequences accept votes, and main-round voters can vote again
  // (their tiebreak vote is tracked separately in tiebreak_votes table).
  // If the tiebreak timer expires without a clear winner, all votes for
  // the round are dumped and FPP plays its scheduled next song.
  ['tiebreak_enabled', 'INTEGER DEFAULT 0'],          // boolean: opt-in
  ['tiebreak_duration_sec', 'INTEGER DEFAULT 60'],    // how long the tiebreak window stays open
  ['tiebreak_active', 'INTEGER DEFAULT 0'],           // boolean: tiebreak in progress
  ['tiebreak_started_at', 'TEXT'],                    // ISO timestamp when tiebreak started
  ['tiebreak_deadline_at', 'TEXT'],                   // ISO timestamp when tiebreak window closes (min of timer + song-end)
  ['tiebreak_candidates', `TEXT DEFAULT ''`],         // comma-separated sequence names eligible for tiebreak votes
  ['play_psa_enabled', 'INTEGER DEFAULT 0'],
  ['psa_frequency', 'INTEGER DEFAULT 5'],
  // v0.30.0+: choose how psa_frequency is counted. See schema comment
  // above for semantics. Existing installs default to 'interactions' so
  // upgrade behavior is identical to v0.29.x.
  ['psa_trigger_mode', `TEXT DEFAULT 'interactions'`],
  ['sequences_since_last_psa', 'INTEGER DEFAULT 0'],
  ['check_viewer_present', 'INTEGER DEFAULT 0'],
  ['viewer_present_mode', `TEXT DEFAULT 'GPS'`],
  ['show_latitude', 'REAL DEFAULT 0'],
  ['show_longitude', 'REAL DEFAULT 0'],
  ['check_radius_miles', 'REAL DEFAULT 0.5'],
  ['hide_sequence_after_played', 'INTEGER DEFAULT 0'],
  ['blocked_ips', `TEXT DEFAULT ''`],
  ['interactions_since_last_psa', 'INTEGER DEFAULT 0'],
  // Plugin status — persist so restarts don't reset to "never synced"
  ['plugin_last_sync_at', 'DATETIME'],
  ['plugin_last_sync_playlist', 'TEXT'],
  ['plugin_last_sync_count', 'INTEGER DEFAULT 0'],
  ['plugin_last_seen_at', 'DATETIME'],
  ['plugin_version', 'TEXT'],
  ['plugin_fpp_host', 'TEXT'],   // IP/hostname of FPP for audio streaming proxy
  // audio_daemon_port: kept as a vestigial column from the v0.14.x days when
  // a Node.js audio daemon ran on FPP alongside the listener. The daemon was
  // removed in v0.15.0 (proxy-only audio path). Column stays so existing
  // databases don't need a destructive migration; nothing reads it anymore.
  ['audio_daemon_port', 'INTEGER DEFAULT 8090'],
  ['player_decoration', `TEXT DEFAULT 'none'`],     // viewer player decoration theme
  ['player_decoration_animated', 'INTEGER DEFAULT 1'],
  ['page_snow_enabled', 'INTEGER DEFAULT 0'],       // legacy boolean; superseded by page_effect (v0.32.0+). Kept for backward-compat reads.
  // Page-wide ambient effects (v0.32.0+). Replaces the single page_snow_enabled
  // toggle with a multi-effect dropdown. Values: 'none' | 'snow' | 'leaves' |
  // 'fireworks' | 'hearts' | 'stars' | 'bats' | 'confetti' | 'petals' |
  // 'embers' | 'bubbles' | 'rain'. Color is empty string for "use the
  // effect's default" or any CSS color. Intensity is 'subtle'|'medium'|'heavy'.
  // Migration logic below auto-sets page_effect='snow' for installs that had
  // page_snow_enabled=1.
  ['page_effect',           `TEXT DEFAULT 'none'`],
  ['page_effect_color',     `TEXT DEFAULT ''`],
  ['page_effect_intensity', `TEXT DEFAULT 'medium'`],
  ['player_custom_color', `TEXT DEFAULT ''`],       // custom player bar color when decoration='none'
  ['public_base_url', `TEXT DEFAULT ''`],           // e.g. "https://lightsondrake.org" — used by viewer to build external audio URLs
  ['viewer_request_limit', 'INTEGER DEFAULT 1'],    // max concurrent requests per viewer in queue (used when prevent_multiple_requests=1)
  ['audio_enabled', 'INTEGER DEFAULT 1'],           // master audio toggle. When 0, viewers see no listen button, audio endpoints 404, and the plugin skips audio sync entirely (manifest endpoint signals no upload). For shows that use external audio delivery (PulseMesh, FM, Icecast) and don't want ShowPilot to host audio at all — saves disk + plugin sync time.
  ['audio_gate_enabled', 'INTEGER DEFAULT 1'],      // restrict audio playback to listeners within radius (copyright safety) — default ON
  ['audio_gate_radius_miles', 'REAL DEFAULT 0.5'],  // separate radius from check_radius_miles so audio + interaction can have different rules
  ['audio_sync_offset_ms', 'INTEGER DEFAULT 200'], // milliseconds to delay viewer audio to match physical speakers. Compensates for FPP's hardware audio output buffer (the delay between FPP submitting samples and speakers emitting them). 200 is a reasonable default for Pi analog/HDMI; users with USB DACs or AVRs may need to adjust. Tuned once per show via admin Settings → Audio. Existing installs keep whatever value they already have.
  ['viewer_source_obfuscate', 'INTEGER DEFAULT 0'], // hide viewer template HTML from casual view-source/Ctrl+U lookups
  // ---- PWA install settings (v0.23.0+) ----
  // When enabled, admin/viewer pages serve a manifest.json that browsers
  // recognize for "Install as App" / "Add to Home Screen" prompts.
  // Admin uses a fixed name and ShowPilot's favicon; viewer is configurable.
  ['pwa_admin_enabled', 'INTEGER DEFAULT 0'],       // boolean: include admin PWA manifest + service worker registration
  ['pwa_viewer_enabled', 'INTEGER DEFAULT 0'],      // boolean: same for viewer
  ['pwa_viewer_name', 'TEXT'],                      // app name shown on home screen; falls back to show_name when null/empty
  ['pwa_viewer_icon', 'TEXT'],                      // icon as data: URL (base64-encoded PNG). Single icon, browsers downscale for various display contexts. Should be 512x512+ square for best results.
  // ---- Listen-on-phone launcher button (v0.26.0+) ----
  // The floating red headphones button on the viewer page that opens the
  // audio player. Admin can swap the icon (built-in preset or custom upload),
  // toggle the round button chrome on/off, and pick a size.
  ['launcher_icon_source', `TEXT DEFAULT 'default'`], // 'default' = original 🎧 emoji, 'preset:<key>' = built-in preset, 'custom' = use launcher_icon_data
  ['launcher_icon_data', `TEXT DEFAULT ''`],       // data: URL for custom uploaded image. Empty unless launcher_icon_source='custom'.
  ['launcher_show_chrome', 'INTEGER DEFAULT 1'],   // 1 = show round red button background; 0 = bare icon (image must look clickable on its own)
  ['launcher_size', `TEXT DEFAULT 'medium'`],      // 'small' (40px), 'medium' (52px, default), 'large' (72px)
  ['visitor_ips_anonymized', 'INTEGER DEFAULT 0'],  // 1 once the v0.17 backfill has run on this database
  // Location code (v0.33.24+): when enabled, viewers must enter a code
  // displayed at the show before they can vote or make requests. The code
  // is set by the admin and checked server-side on every vote/request.
  // Works independently of GPS — either or both can be active at once.
  ['location_code_enabled', 'INTEGER DEFAULT 0'],
  ['location_code',         `TEXT DEFAULT ''`],
];
for (const [col, spec] of configMigrations) {
  if (!columnExists('config', col)) {
    db.exec(`ALTER TABLE config ADD COLUMN ${col} ${spec}`);
  }
}

// One-shot migration (v0.32.0+): legacy page_snow_enabled=1 installs were
// upgraded to add the new page_effect column with default 'none'. Detect
// that inconsistency once and promote the boolean to the new dropdown
// value. Idempotent — re-running is a no-op because we only act when the
// new column is at its default. After admin makes their first explicit
// pick (which writes a non-default value), this block stops touching it.
try {
  const cfgRow = db.prepare(
    `SELECT page_snow_enabled, page_effect FROM config WHERE id = 1`
  ).get();
  if (cfgRow && cfgRow.page_snow_enabled === 1 && cfgRow.page_effect === 'none') {
    db.prepare(`UPDATE config SET page_effect = 'snow' WHERE id = 1`).run();
  }
} catch (e) {
  // Either columns aren't there yet (fresh install — schema CREATE handles it)
  // or some other quirk. Migration is best-effort; the new fields default
  // sensibly so this is non-blocking.
}

const sequenceMigrations = [
  ['image_url', 'TEXT'],
  ['is_psa', 'INTEGER DEFAULT 0'],
  ['last_played_at', 'DATETIME'],
  ['plays_since_hidden', 'INTEGER DEFAULT 0'],
  ['display_order', 'INTEGER DEFAULT 0'],
  ['media_name', 'TEXT'],   // FPP audio filename (e.g. "Wizards.mp3") for streaming
  // audio_hash (v0.24.3+): SHA-256 of this sequence's audio bytes. Used
  // to look up the cache row directly via hash, sidestepping the
  // many-to-one limitation where audio_cache_files.media_name only
  // names ONE sequence per hash. Two FPP sequences sharing the same
  // audio file (e.g. "indoor+outdoor lights" + "outdoor only" of the
  // same song) both store the same hash here; the cache row is shared.
  ['audio_hash', 'TEXT'],
  // cooldown_minutes (v0.29.2+): per-sequence "after I play, suppress me
  // and purge other queued copies for N minutes." 0 = no cooldown.
  ['cooldown_minutes', 'INTEGER DEFAULT 0'],
];
for (const [col, spec] of sequenceMigrations) {
  if (!columnExists('sequences', col)) {
    db.exec(`ALTER TABLE sequences ADD COLUMN ${col} ${spec}`);
    // Backfill display_order from sort_order on first migration
    if (col === 'display_order') {
      db.exec(`UPDATE sequences SET display_order = sort_order`);
    }
    // Backfill audio_hash from existing cache mappings on first migration.
    // The audio_cache_files.media_name column was the old (broken-for-
    // duplicates) lookup; for sequences whose media_name still matches
    // a cache row, copy the hash over. Sequences whose audio was
    // claimed by a duplicate sibling will be fixed on next plugin sync.
    if (col === 'audio_hash') {
      db.exec(`
        UPDATE sequences
        SET audio_hash = (
          SELECT hash FROM audio_cache_files
          WHERE audio_cache_files.media_name = sequences.media_name
          LIMIT 1
        )
        WHERE media_name IS NOT NULL AND media_name != ''
      `);
    }
  }
}

// Migrations for jukebox_queue
if (!columnExists('jukebox_queue', 'handed_off_at')) {
  db.exec(`ALTER TABLE jukebox_queue ADD COLUMN handed_off_at DATETIME`);
}

// Per-user theme preference. NULL means "no preference set" — admin UI
// applies its default until the user picks one. Stored on the user so the
// choice follows them to any device they sign in on, instead of being
// pinned to localStorage on a single browser.
if (!columnExists('users', 'theme')) {
  db.exec(`ALTER TABLE users ADD COLUMN theme TEXT`);
}

// Migrations for viewer_page_templates — Visual Designer needs to track
// which mode (code/settings/blocks) the template was last edited in, plus
// the form values + block layout so Settings/Blocks modes can be reopened
// without losing the user's intent.
const templateMigrations = [
  ['mode', `TEXT DEFAULT 'code'`],   // 'code' | 'settings' | 'blocks'
  ['settings_json', `TEXT DEFAULT ''`],   // form values when in 'settings' mode
  ['blocks_json', `TEXT DEFAULT ''`],     // block layout when in 'blocks' mode
  ['draft_html', `TEXT DEFAULT ''`],      // preview-only HTML, for live preview during edits
  ['draft_updated_at', 'DATETIME'],
  ['locked', `INTEGER DEFAULT 0`],        // when locked, edits + commits are blocked until unlocked
  // Custom favicon for this template's viewer page. Two storage forms:
  //   - URL like 'https://example.com/icon.png' or '/some/path' — used as-is in <link rel="icon">
  //   - data URL like 'data:image/svg+xml;base64,...' — populated by the file-upload path
  // Either is just dropped into the <link href="..."> attribute, so the renderer
  // doesn't care which storage form was used. Empty/null = no custom favicon
  // (browser uses /favicon.ico if you have one, otherwise nothing).
  ['favicon_url', `TEXT DEFAULT ''`],
  // (v0.32.3+) SHA-256 of this template's HTML the last time the built-in
  // seeder wrote it. Used to detect "admin edited it since seed" — if the
  // row's current HTML hashes to this value, the row is still pristine
  // and the seeder may refresh it from the file. If they differ, an admin
  // edited the template and we must leave it alone. NULL/empty for
  // user-created templates (is_builtin=0) and for legacy rows from v0.32.0
  // through v0.32.2 — those get treated as pristine on first v0.32.3 boot
  // (one-time cost of shipping a non-refreshing seeder; documented in
  // the upgrade notes).
  ['builtin_source_hash', `TEXT DEFAULT ''`],
];
for (const [col, spec] of templateMigrations) {
  if (!columnExists('viewer_page_templates', col)) {
    db.exec(`ALTER TABLE viewer_page_templates ADD COLUMN ${col} ${spec}`);
  }
}

// Seed singleton rows if empty
db.prepare(`INSERT OR IGNORE INTO config (id) VALUES (1)`).run();
db.prepare(`INSERT OR IGNORE INTO now_playing (id) VALUES (1)`).run();

// One-time backfill: anonymize any IPs in viewer_visits that were logged
// before v0.17 added IP anonymization. Idempotent — re-anonymizing an
// already-anonymized address is a no-op (last octet is already 0).
// Tracked via a config flag so this doesn't run on every boot.
{
  const cfgRow = db.prepare(`SELECT visitor_ips_anonymized FROM config WHERE id = 1`).get();
  if (cfgRow && !cfgRow.visitor_ips_anonymized) {
    try {
      const { anonymizeIp } = require('./visit-tracking');
      const rows = db.prepare(`SELECT id, ip FROM viewer_visits WHERE ip IS NOT NULL AND ip != ''`).all();
      const upd = db.prepare(`UPDATE viewer_visits SET ip = ? WHERE id = ?`);
      const tx = db.transaction((batch) => {
        for (const r of batch) upd.run(anonymizeIp(r.ip), r.id);
      });
      tx(rows);
      db.prepare(`UPDATE config SET visitor_ips_anonymized = 1 WHERE id = 1`).run();
      if (rows.length > 0) {
        console.log(`[migration] Anonymized ${rows.length} historical visitor IPs`);
      }
    } catch (err) {
      console.warn('[migration] IP anonymization backfill skipped:', err.message);
    }
  }
}

// Seed default viewer page template if none exists
{
  const count = db.prepare(`SELECT COUNT(*) AS n FROM viewer_page_templates`).get().n;
  if (count === 0) {
    const fs = require('fs');
    const path = require('path');
    const defaultPath = path.join(__dirname, '..', 'public', 'viewer.html');
    let defaultHtml = '';
    try { defaultHtml = fs.readFileSync(defaultPath, 'utf8'); } catch (e) { /* ignore */ }
    db.prepare(`
      INSERT INTO viewer_page_templates (name, html, is_active, is_builtin)
      VALUES (?, ?, 1, 1)
    `).run('Default (ShowPilot)', defaultHtml);
  }
}

// Seed built-in viewer templates (v0.32.0+, refresh logic v0.32.3+)
// Five themed templates ship in public/viewer-templates/. The seeder runs
// on every boot and:
//   - INSERTs any built-in name that doesn't exist in the DB yet
//   - REFRESHes a built-in row's HTML when the source file has changed
//     SINCE WE LAST SEEDED IT — but only if the row hasn't been edited by
//     the admin. We detect "edited" via builtin_source_hash: if the row's
//     HTML still hashes to the value we stored at last seed, the admin
//     hasn't touched it; if it differs, they have.
//   - LEAVEs alone any row where builtin_source_hash differs from the
//     row's actual HTML hash (admin edited)
//   - LEAVEs alone any user-created template (is_builtin=0) sharing the name
//
// MIGRATION: rows from v0.32.0..v0.32.2 have empty builtin_source_hash. We
// treat those as pristine and refresh them to the current file content on
// first v0.32.3 boot. This is a one-time clobber; thereafter, edits are
// protected. To keep a customized built-in across upgrades, rename it
// (the seeder won't touch a row with a different name).
//
// To permanently hide a built-in: rename it (any change keeps the seeder
// from re-creating it under the original name).
{
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const dir = path.join(__dirname, '..', 'public', 'viewer-templates');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.html')); } catch (e) { /* dir absent → no-op */ }
  const DISPLAY_NAMES = {
    'drive-in':         'Drive-In',
    'independence-day': 'Independence Day',
    'neon':             'Neon',
    'radio-station':    'Radio Station',
    'retro-crt':        'Retro CRT',
  };
  const fallbackName = (slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  for (const file of files) {
    const slug = file.replace(/\.html$/, '');
    const name = DISPLAY_NAMES[slug] || fallbackName(slug);

    let fileHtml = '';
    try { fileHtml = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { continue; }
    const fileHash = sha256(fileHtml);

    const existing = db.prepare(
      `SELECT id, html, is_builtin, builtin_source_hash
       FROM viewer_page_templates WHERE name = ? LIMIT 1`
    ).get(name);

    if (!existing) {
      // Brand new — INSERT
      db.prepare(`
        INSERT INTO viewer_page_templates
          (name, html, is_active, is_builtin, builtin_source_hash)
        VALUES (?, ?, 0, 1, ?)
      `).run(name, fileHtml, fileHash);
      continue;
    }

    if (existing.is_builtin !== 1) {
      // User created a template by this name — never touch
      continue;
    }

    // Built-in row — decide refresh vs leave-alone based on edit detection.
    const rowHash = sha256(existing.html || '');
    const storedHash = existing.builtin_source_hash || '';
    const adminEdited = storedHash && storedHash !== rowHash;

    if (adminEdited) {
      // Admin edited; leave alone. We do NOT update the stored hash —
      // they may want to revert later by deleting+rebooting.
      continue;
    }

    if (fileHash === rowHash) {
      // Already up to date. Backfill the hash if it was empty (legacy row),
      // so future edit detection works.
      if (!storedHash) {
        db.prepare(
          `UPDATE viewer_page_templates SET builtin_source_hash = ? WHERE id = ?`
        ).run(fileHash, existing.id);
      }
      continue;
    }

    // File changed and admin hasn't edited the row — refresh.
    db.prepare(`
      UPDATE viewer_page_templates
         SET html = ?, builtin_source_hash = ?
       WHERE id = ?
    `).run(fileHtml, fileHash, existing.id);
    console.log(`[ShowPilot] Refreshed built-in template '${name}' from disk (file changed)`);
  }
}

// Seed users:
//  - If users table is empty AND legacy admin_password_hash exists, migrate it
//    to a user named "admin" so existing installs keep working.
//  - If users table is empty AND no legacy hash, create default "admin/admin"
//    with must_change_password=1 so first login forces a fresh password.
{
  const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  if (userCount === 0) {
    const cfg = db.prepare(`SELECT admin_password_hash FROM config WHERE id = 1`).get();
    if (cfg && cfg.admin_password_hash) {
      // Migrate from legacy single-password auth
      db.prepare(`
        INSERT INTO users (username, password_hash, enabled, must_change_password)
        VALUES ('admin', ?, 1, 0)
      `).run(cfg.admin_password_hash);
      console.log('[ShowPilot] Migrated legacy admin password to user "admin"');
    } else {
      // Brand new install — create admin/admin and force password change
      const bcrypt = require('bcrypt');
      const defaultHash = bcrypt.hashSync('admin', 10);
      db.prepare(`
        INSERT INTO users (username, password_hash, enabled, must_change_password)
        VALUES ('admin', ?, 1, 1)
      `).run(defaultHash);
      console.log('[ShowPilot] Created default user "admin" with password "admin" — change it on first login!');
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function getConfig() {
  return db.prepare(`SELECT * FROM config WHERE id = 1`).get();
}

function updateConfig(updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE config SET ${setClause} WHERE id = 1`).run(updates);
}

function getNowPlaying() {
  return db.prepare(`SELECT * FROM now_playing WHERE id = 1`).get();
}

function setNowPlaying(sequenceName, secondsPlayed) {
  // started_at represents when the song's current playback POSITION was at 0.
  //
  // Important: we anchor started_at ONCE per track (on the first report for
  // a new sequence name), then leave it alone for the rest of the track.
  // Without this, every plugin report (typically once per second) would
  // re-anchor started_at to CURRENT_TIMESTAMP - seconds_played. That sounds
  // self-correcting in theory, but in practice the report-to-DB pipeline has
  // ±50-200ms of jitter from network/processing variance. Each re-anchor
  // bakes that jitter into started_at, which the viewer reads as
  // trackStartedAtMs, which the drift calculation uses as the target.
  // Result: the viewer's sync target moves around constantly, and continuous
  // playback rate adjustment chases an unstable anchor.
  //
  // By anchoring once and trusting it, the viewer's audio clock and our
  // anchor stay in fixed relationship. Continuous resync still handles
  // natural drift between FPP's audio clock and the phone's audio clock,
  // but it's correcting against a STABLE target instead of a jittery one.
  //
  // The downside: if FPP itself jumps in playback (interrupt that resumes
  // mid-song to a different position), we won't pick that up until the
  // sequence name changes. In practice FPP doesn't do that — interrupts
  // play a different sequence, and we re-anchor when the new sequence comes
  // in.
  const offset = (typeof secondsPlayed === 'number' && isFinite(secondsPlayed) && secondsPlayed > 0)
    ? secondsPlayed : 0;

  // Check if this is a NEW sequence (different from what's already there)
  const current = db.prepare(`SELECT sequence_name FROM now_playing WHERE id = 1`).get();
  const isNewSequence = !current || current.sequence_name !== sequenceName;

  if (isNewSequence) {
    // New track — anchor started_at based on the reported position. This
    // handles the "resume mid-song" case correctly (FPP starts a sequence
    // already at position N because it's resuming after an interrupt).
    if (offset > 0) {
      db.prepare(`
        UPDATE now_playing
        SET sequence_name = ?,
            started_at = datetime(CURRENT_TIMESTAMP, ? || ' seconds'),
            last_updated = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(sequenceName, '-' + offset.toFixed(2));
    } else {
      db.prepare(`
        UPDATE now_playing
        SET sequence_name = ?, started_at = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(sequenceName);
    }
  } else {
    // Same sequence — just update the heartbeat timestamp so we know FPP
    // is still alive. DON'T touch started_at — that's the stable anchor
    // viewers are using to compute playback position.
    db.prepare(`
      UPDATE now_playing
      SET last_updated = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();
  }
}

function setNextScheduled(sequenceName) {
  db.prepare(`
    UPDATE now_playing
    SET next_sequence_name = ?, last_updated = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(sequenceName);
}

function getSequenceByName(name) {
  // Case-insensitive — FPP playlist sync may store with one case while
  // FPP's runtime status reports another (e.g. "HunterX" vs "Hunterx").
  return db.prepare(`SELECT * FROM sequences WHERE name = ? COLLATE NOCASE`).get(name);
}

// "Next up" with full priority logic:
//   1. JUKEBOX + queue has entries after now-playing → first queued
//   2. VOTING + votes cast this round → highest-voted song
//   3. Fallback → next visible non-PSA song by sort_order (FPP playlist position)
function getNextUp(cfg, nowPlayingName) {
  if (cfg.viewer_control_mode === 'JUKEBOX') {
    const firstQueued = db.prepare(`
      SELECT sequence_name FROM jukebox_queue
      WHERE played = 0 AND sequence_name != COALESCE(?, '')
      ORDER BY requested_at ASC LIMIT 1
    `).get(nowPlayingName || null);
    if (firstQueued) return firstQueued.sequence_name;
  }

  if (cfg.viewer_control_mode === 'VOTING') {
    const top = db.prepare(`
      SELECT sequence_name FROM votes
      WHERE round_id = ?
      GROUP BY sequence_name
      ORDER BY COUNT(*) DESC
      LIMIT 1
    `).get(cfg.current_voting_round);
    if (top) return top.sequence_name;
  }

  let currentSortOrder = null;
  if (nowPlayingName) {
    const row = db.prepare(
      `SELECT sort_order FROM sequences WHERE name = ? COLLATE NOCASE LIMIT 1`
    ).get(nowPlayingName);
    if (row) currentSortOrder = row.sort_order;
  }

  const nextRow = currentSortOrder !== null
    ? db.prepare(`
        SELECT name FROM sequences
        WHERE sort_order > ? AND visible = 1 AND is_psa = 0
        ORDER BY sort_order ASC LIMIT 1
      `).get(currentSortOrder)
    : db.prepare(`
        SELECT name FROM sequences
        WHERE visible = 1 AND is_psa = 0
        ORDER BY sort_order ASC LIMIT 1
      `).get();

  return nextRow ? nextRow.name : null;
}

function getActiveViewerCount() {
  const cutoff = new Date(Date.now() - config.viewer.activeWindowSeconds * 1000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM active_viewers WHERE last_seen > ?`).get(cutoff);
  return row.n;
}

function cleanupStaleViewers() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min
  db.prepare(`DELETE FROM active_viewers WHERE last_seen < ?`).run(cutoff);
}

// Highest-voted sequence in current round. Returns { sequence_name, vote_count, sort_order } or null.
// sort_order is the playlist index FPP needs to Insert Playlist by position.
function getHighestVotedSequence() {
  const cfg = getConfig();
  return db.prepare(`
    SELECT v.sequence_name,
           COUNT(*) AS vote_count,
           s.sort_order
    FROM votes v
    LEFT JOIN sequences s ON s.name = v.sequence_name
    WHERE v.round_id = ?
    GROUP BY v.sequence_name
    ORDER BY vote_count DESC, MIN(v.voted_at) ASC
    LIMIT 1
  `).get(cfg.current_voting_round);
}

// Detect a strict tie at the top of the vote distribution for the given
// round. Returns an array of tied sequence_names if ≥2 sequences share
// the highest count (and that count is > 0), else returns null.
//
// Used by the tiebreak feature (v0.24.0+) to decide whether to enter
// tiebreak mode instead of the default first-vote-wins behavior. Strict
// tie keeps the trigger condition simple and predictable — no fuzzy
// "close enough" thresholds for users to reason about.
function detectVoteTie(roundId) {
  const counts = db.prepare(`
    SELECT sequence_name, COUNT(*) AS cnt
    FROM votes
    WHERE round_id = ?
    GROUP BY sequence_name
    ORDER BY cnt DESC
  `).all(roundId);
  if (counts.length < 2) return null;
  const top = counts[0].cnt;
  if (top <= 0) return null;
  const tied = counts.filter(c => c.cnt === top);
  if (tied.length < 2) return null;
  return tied.map(c => c.sequence_name);
}

// Combined main-round + tiebreak vote totals for a given round and the
// supplied set of candidate sequence names. Used to determine the winner
// during tiebreak: each candidate's effective score is its main-round
// count PLUS its tiebreak count. The winner is the candidate with the
// highest combined score; if still tied (rare), we return null and let
// the caller decide (timer-expire dump path).
function getTiebreakLeader(roundId, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  // Build the tally by candidate. Two queries (main + tiebreak) summed
  // in JS — simpler than a UNION ALL aggregation and the candidate set
  // is small (almost always 2-3 sequences) so query cost is negligible.
  const placeholders = candidates.map(() => '?').join(',');
  const mainCounts = db.prepare(`
    SELECT sequence_name, COUNT(*) AS cnt
    FROM votes
    WHERE round_id = ? AND sequence_name IN (${placeholders})
    GROUP BY sequence_name
  `).all(roundId, ...candidates);
  const tbCounts = db.prepare(`
    SELECT sequence_name, COUNT(*) AS cnt, MIN(voted_at) AS first_vote
    FROM tiebreak_votes
    WHERE round_id = ? AND sequence_name IN (${placeholders})
    GROUP BY sequence_name
  `).all(roundId, ...candidates);
  const totals = {};
  const firstVotes = {};
  for (const c of candidates) totals[c] = 0;
  for (const r of mainCounts) totals[r.sequence_name] = (totals[r.sequence_name] || 0) + r.cnt;
  for (const r of tbCounts) {
    totals[r.sequence_name] = (totals[r.sequence_name] || 0) + r.cnt;
    firstVotes[r.sequence_name] = r.first_vote;
  }
  // Determine top
  let topScore = -1;
  for (const c of candidates) if (totals[c] > topScore) topScore = totals[c];
  const leaders = candidates.filter(c => totals[c] === topScore);
  if (leaders.length === 1) {
    const winnerName = leaders[0];
    const seq = db.prepare(`SELECT name, sort_order FROM sequences WHERE name = ? COLLATE NOCASE`).get(winnerName);
    return seq ? {
      sequence_name: seq.name,
      vote_count: topScore,
      sort_order: seq.sort_order,
      candidates,
      totals,
    } : null;
  }
  // Still tied. Return null — caller should keep waiting until timer
  // resolves OR more votes come in.
  return null;
}

// Cast a tiebreak vote. Returns 'ok', 'duplicate', or 'invalid_candidate'.
// Mirrors the main vote endpoint's UNIQUE-error handling so the result
// shape is predictable. Doesn't enforce mode/safeguards itself — caller
// (route handler) does that.
function castTiebreakVote(viewerToken, sequenceName, roundId, candidates) {
  if (!Array.isArray(candidates) || !candidates.includes(sequenceName)) {
    return 'invalid_candidate';
  }
  try {
    db.prepare(`
      INSERT INTO tiebreak_votes (sequence_name, viewer_token, round_id)
      VALUES (?, ?, ?)
    `).run(sequenceName, viewerToken, roundId);
    return 'ok';
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return 'duplicate';
    throw e;
  }
}

// Clear all votes (main + tiebreak) for a round and any tiebreak state.
// Used both when a tiebreak resolves successfully and when it expires.
function clearVotesForRound(roundId) {
  db.prepare(`DELETE FROM votes WHERE round_id = ?`).run(roundId);
  db.prepare(`DELETE FROM tiebreak_votes WHERE round_id = ?`).run(roundId);
}

function clearTiebreakState() {
  db.prepare(`
    UPDATE config
    SET tiebreak_active = 0,
        tiebreak_started_at = NULL,
        tiebreak_deadline_at = NULL,
        tiebreak_candidates = ''
    WHERE id = 1
  `).run();
}

// Atomically pop the next queued request and mark it as handed off to the
// plugin. The request stays in the queue with played=0 until we *confirm*
// it actually played (via setNowPlaying when the plugin reports the sequence
// is now playing on FPP, OR via timeout cleanup for stragglers).
//
// This matters for "Up Next" — if we marked played=1 immediately on pop,
// the queue would always look empty between pop and play-confirmation.
function popNextQueuedRequest() {
  const next = db.prepare(`
    SELECT q.*, s.sort_order
    FROM jukebox_queue q
    LEFT JOIN sequences s ON s.name = q.sequence_name
    WHERE q.played = 0 AND q.handed_off_at IS NULL
    ORDER BY q.requested_at ASC
    LIMIT 1
  `).get();

  if (!next) return null;

  // Mark as handed-off (in flight) but NOT played
  db.prepare(`
    UPDATE jukebox_queue
    SET handed_off_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(next.id);

  return next;
}

// Mark a queue entry as played. Called when the plugin reports a viewer
// request actually started playing on FPP (via setNowPlaying matching one
// of our handed-off entries).
function markQueueEntryPlayed(sequenceName) {
  // Find the oldest handed-off, unplayed entry matching this sequence name
  const entry = db.prepare(`
    SELECT id FROM jukebox_queue
    WHERE sequence_name = ? AND played = 0 AND handed_off_at IS NOT NULL
    ORDER BY handed_off_at ASC
    LIMIT 1
  `).get(sequenceName);
  if (!entry) return false;

  db.prepare(`
    UPDATE jukebox_queue
    SET played = 1, played_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(entry.id);
  return true;
}

// Cleanup stragglers — handed-off but never confirmed-played requests older
// than N seconds get marked played to keep the queue clean.
function cleanupStaleHandoffs(olderThanSeconds = 300) {
  db.prepare(`
    UPDATE jukebox_queue
    SET played = 1, played_at = CURRENT_TIMESTAMP
    WHERE played = 0
      AND handed_off_at IS NOT NULL
      AND datetime(handed_off_at, '+' || ? || ' seconds') < datetime('now')
  `).run(olderThanSeconds);
}

// Advance voting round (called after winning vote plays)
function advanceVotingRound() {
  db.prepare(`UPDATE config SET current_voting_round = current_voting_round + 1 WHERE id = 1`).run();
}

// ---- Sequence snapshots ----

function listSnapshots() {
  return db.prepare(`
    SELECT id, name, description, sequence_count, created_at
    FROM sequence_snapshots
    ORDER BY created_at DESC
  `).all();
}

function createSnapshot(name, description) {
  // Atomic: write the snapshot row + copy all current sequences in one transaction
  const tx = db.transaction((snapName, snapDesc) => {
    const seqs = db.prepare(`
      SELECT name, display_name, artist, category, media_name, image_url,
             duration_seconds, visible, votable, jukeboxable, is_psa,
             sort_order, display_order
      FROM sequences
    `).all();
    const result = db.prepare(`
      INSERT INTO sequence_snapshots (name, description, sequence_count)
      VALUES (?, ?, ?)
    `).run(snapName, snapDesc || null, seqs.length);
    const snapshotId = result.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO sequence_snapshot_items
        (snapshot_id, name, display_name, artist, category, media_name, image_url,
         duration_seconds, visible, votable, jukeboxable, is_psa, sort_order, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of seqs) {
      insertItem.run(
        snapshotId, s.name, s.display_name, s.artist, s.category, s.media_name, s.image_url,
        s.duration_seconds, s.visible, s.votable, s.jukeboxable, s.is_psa, s.sort_order, s.display_order
      );
    }
    return { id: snapshotId, count: seqs.length };
  });
  return tx(name, description);
}

// Restore strategy: clear current sequences entirely, insert from snapshot.
// Restore strategy: instead of DELETE+reinsert (which fails on foreign-key
// references from votes/queue/play_history and would orphan stats anyway),
// we UPSERT by `name` (the natural key from FPP) and hide leftovers.
//
//  - Sequence in snapshot AND in DB → update existing row in place
//  - Sequence in snapshot, NOT in DB → insert it
//  - Sequence in DB, NOT in snapshot → mark visible=0, votable=0, jukeboxable=0
//      (preserves play history but removes from viewer page)
//
// This way restoring NEVER fails on foreign keys, and stats from the previous
// season are preserved if the user re-adds the sequence later.
function restoreSnapshot(snapshotId) {
  const tx = db.transaction((id) => {
    const items = db.prepare(`
      SELECT name, display_name, artist, category, media_name, image_url,
             duration_seconds, visible, votable, jukeboxable, is_psa,
             sort_order, display_order
      FROM sequence_snapshot_items
      WHERE snapshot_id = ?
    `).all(id);
    if (items.length === 0) return 0;

    const snapshotNames = new Set(items.map(it => it.name));

    // Hide all sequences NOT in the snapshot (don't delete — preserves FK references)
    const placeholders = items.map(() => '?').join(',');
    if (placeholders) {
      db.prepare(`
        UPDATE sequences
        SET visible = 0, votable = 0, jukeboxable = 0
        WHERE name NOT IN (${placeholders})
      `).run(...Array.from(snapshotNames));
    } else {
      db.prepare(`UPDATE sequences SET visible = 0, votable = 0, jukeboxable = 0`).run();
    }

    // Upsert each snapshot item — update existing by name, insert if new
    const findByName = db.prepare(`SELECT id FROM sequences WHERE name = ?`);
    const updateExisting = db.prepare(`
      UPDATE sequences
      SET display_name = ?, artist = ?, category = ?, media_name = ?, image_url = ?,
          duration_seconds = ?, visible = ?, votable = ?, jukeboxable = ?, is_psa = ?,
          sort_order = ?, display_order = ?
      WHERE name = ?
    `);
    const insertNew = db.prepare(`
      INSERT INTO sequences
        (name, display_name, artist, category, media_name, image_url,
         duration_seconds, visible, votable, jukeboxable, is_psa, sort_order, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of items) {
      const existing = findByName.get(it.name);
      if (existing) {
        updateExisting.run(
          it.display_name, it.artist, it.category, it.media_name, it.image_url,
          it.duration_seconds, it.visible, it.votable, it.jukeboxable, it.is_psa,
          it.sort_order, it.display_order, it.name
        );
      } else {
        insertNew.run(
          it.name, it.display_name, it.artist, it.category, it.media_name, it.image_url,
          it.duration_seconds, it.visible, it.votable, it.jukeboxable, it.is_psa,
          it.sort_order, it.display_order
        );
      }
    }
    return items.length;
  });
  return tx(snapshotId);
}

function deleteSnapshot(snapshotId) {
  // CASCADE on items table handles the cleanup
  return db.prepare(`DELETE FROM sequence_snapshots WHERE id = ?`).run(snapshotId);
}

function renameSnapshot(snapshotId, newName, newDescription) {
  return db.prepare(`
    UPDATE sequence_snapshots SET name = ?, description = ? WHERE id = ?
  `).run(newName, newDescription || null, snapshotId);
}

// ============================================================
// User helpers
// ============================================================

function listUsers() {
  return db.prepare(`
    SELECT id, username, remember_me, enabled, must_change_password, last_login_at, created_at
    FROM users ORDER BY username COLLATE NOCASE
  `).all();
}

function getUserByUsername(username) {
  return db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(username);
}

function getUserById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

function createUser({ username, passwordHash, mustChangePassword }) {
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, must_change_password, enabled)
    VALUES (?, ?, ?, 1)
  `).run(username, passwordHash, mustChangePassword ? 1 : 0);
  return result.lastInsertRowid;
}

function updateUser(id, fields) {
  // Only allow specific fields to be updated this way
  const allowed = ['username', 'remember_me', 'enabled', 'must_change_password'];
  const updates = {};
  for (const k of allowed) {
    if (k in fields) updates[k] = fields[k];
  }
  if (Object.keys(updates).length === 0) return;
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id });
}

// Theme is a self-service per-user preference, kept separate from
// updateUser() (which is the admin-managed user-record endpoint). A user
// updating their own theme should not flow through the same code path that
// can flip 'enabled' or 'must_change_password'. NULL clears the preference.
function setUserTheme(id, theme) {
  db.prepare(`UPDATE users SET theme = ? WHERE id = ?`).run(theme, id);
}

function setUserPassword(id, passwordHash, mustChange) {
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?
  `).run(passwordHash, mustChange ? 1 : 0, id);
}

function deleteUser(id) {
  return db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

function recordUserLogin(id) {
  db.prepare(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

function countUsers() {
  return db.prepare(`SELECT COUNT(*) AS n FROM users WHERE enabled = 1`).get().n;
}

// ============================================================
// Update state (v0.33.0+)
// ============================================================
// Single-row table tracking the previous-version pointer for the
// in-app updater's rollback feature. We use INSERT OR REPLACE on a
// fixed id=1 so callers don't have to know whether the row exists.

function getUpdateState() {
  return db.prepare(`SELECT * FROM update_state WHERE id = 1`).get() || null;
}

function setUpdateState(fields) {
  // Merge with existing — partial updates should preserve unchanged
  // fields. INSERT OR REPLACE alone would null out anything not
  // mentioned, which is the wrong default for an upsert here.
  const existing = getUpdateState() || {};
  const merged = {
    previous_version_tag: fields.previous_version_tag !== undefined
      ? fields.previous_version_tag : existing.previous_version_tag,
    previous_version_sha: fields.previous_version_sha !== undefined
      ? fields.previous_version_sha : existing.previous_version_sha,
    last_update_at: fields.last_update_at !== undefined
      ? fields.last_update_at : existing.last_update_at,
    last_update_target: fields.last_update_target !== undefined
      ? fields.last_update_target : existing.last_update_target,
  };
  db.prepare(`
    INSERT OR REPLACE INTO update_state
      (id, previous_version_tag, previous_version_sha, last_update_at, last_update_target)
    VALUES (1, ?, ?, ?, ?)
  `).run(
    merged.previous_version_tag,
    merged.previous_version_sha,
    merged.last_update_at,
    merged.last_update_target
  );
  return merged;
}

module.exports = {
  db,
  getConfig,
  updateConfig,
  getNowPlaying,
  setNowPlaying,
  setNextScheduled,
  getSequenceByName,
  getNextUp,
  getActiveViewerCount,
  cleanupStaleViewers,
  getHighestVotedSequence,
  detectVoteTie,
  getTiebreakLeader,
  castTiebreakVote,
  clearVotesForRound,
  clearTiebreakState,
  popNextQueuedRequest,
  markQueueEntryPlayed,
  cleanupStaleHandoffs,
  advanceVotingRound,
  listSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  renameSnapshot,
  listUsers,
  getUserByUsername,
  getUserById,
  createUser,
  updateUser,
  setUserTheme,
  setUserPassword,
  deleteUser,
  recordUserLogin,
  countUsers,
  getUpdateState,
  setUpdateState,
};
