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

  -- Voting safeguards
  prevent_multiple_votes INTEGER DEFAULT 1,
  reset_votes_after_round INTEGER DEFAULT 1,

  -- PSA (Public Service Announcements)
  play_psa_enabled INTEGER DEFAULT 0,
  psa_frequency INTEGER DEFAULT 5,                    -- play a PSA every N requests/votes

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

  -- Counter for PSA frequency (increments on each request/vote)
  interactions_since_last_psa INTEGER DEFAULT 0
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

CREATE INDEX IF NOT EXISTS idx_votes_round ON votes(round_id);
CREATE INDEX IF NOT EXISTS idx_queue_played ON jukebox_queue(played, requested_at);
CREATE INDEX IF NOT EXISTS idx_viewers_seen ON active_viewers(last_seen);
CREATE INDEX IF NOT EXISTS idx_history_played ON play_history(played_at);
CREATE INDEX IF NOT EXISTS idx_visits_at ON viewer_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_visitor ON viewer_visits(visitor_id);
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
  ['prevent_multiple_votes', 'INTEGER DEFAULT 1'],
  ['reset_votes_after_round', 'INTEGER DEFAULT 1'],
  ['play_psa_enabled', 'INTEGER DEFAULT 0'],
  ['psa_frequency', 'INTEGER DEFAULT 5'],
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
  ['page_snow_enabled', 'INTEGER DEFAULT 0'],       // page-wide snow effect on viewer page
  ['player_custom_color', `TEXT DEFAULT ''`],       // custom player bar color when decoration='none'
  ['public_base_url', `TEXT DEFAULT ''`],           // e.g. "https://lightsondrake.org" — used by viewer to build external audio URLs
  ['viewer_request_limit', 'INTEGER DEFAULT 1'],    // max concurrent requests per viewer in queue (used when prevent_multiple_requests=1)
  ['audio_gate_enabled', 'INTEGER DEFAULT 1'],      // restrict audio playback to listeners within radius (copyright safety) — default ON
  ['audio_gate_radius_miles', 'REAL DEFAULT 0.5'],  // separate radius from check_radius_miles so audio + interaction can have different rules
  ['viewer_source_obfuscate', 'INTEGER DEFAULT 0'], // hide viewer template HTML from casual view-source/Ctrl+U lookups
  ['visitor_ips_anonymized', 'INTEGER DEFAULT 0'],  // 1 once the v0.17 backfill has run on this database
];
for (const [col, spec] of configMigrations) {
  if (!columnExists('config', col)) {
    db.exec(`ALTER TABLE config ADD COLUMN ${col} ${spec}`);
  }
}

const sequenceMigrations = [
  ['image_url', 'TEXT'],
  ['is_psa', 'INTEGER DEFAULT 0'],
  ['last_played_at', 'DATETIME'],
  ['plays_since_hidden', 'INTEGER DEFAULT 0'],
  ['display_order', 'INTEGER DEFAULT 0'],
  ['media_name', 'TEXT'],   // FPP audio filename (e.g. "Wizards.mp3") for streaming
];
for (const [col, spec] of sequenceMigrations) {
  if (!columnExists('sequences', col)) {
    db.exec(`ALTER TABLE sequences ADD COLUMN ${col} ${spec}`);
    // Backfill display_order from sort_order on first migration
    if (col === 'display_order') {
      db.exec(`UPDATE sequences SET display_order = sort_order`);
    }
  }
}

// Migrations for jukebox_queue
if (!columnExists('jukebox_queue', 'handed_off_at')) {
  db.exec(`ALTER TABLE jukebox_queue ADD COLUMN handed_off_at DATETIME`);
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
  // Normally this is "now" (song just started). But if FPP reports the song
  // is already at position N (e.g. after resuming from an interrupt), we
  // backdate started_at by N seconds so /api/now-playing-audio computes the
  // correct elapsed position for the listener.
  const offset = (typeof secondsPlayed === 'number' && isFinite(secondsPlayed) && secondsPlayed > 0)
    ? secondsPlayed : 0;
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

module.exports = {
  db,
  getConfig,
  updateConfig,
  getNowPlaying,
  setNowPlaying,
  setNextScheduled,
  getSequenceByName,
  getActiveViewerCount,
  cleanupStaleViewers,
  getHighestVotedSequence,
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
  setUserPassword,
  deleteUser,
  recordUserLogin,
  countUsers,
};
