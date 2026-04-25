// ============================================================
// OpenFalcon — Database module
// Uses better-sqlite3 (synchronous, fast, simple).
// Schema is created/migrated on first run.
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

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
  ['audio_daemon_port', 'INTEGER DEFAULT 8090'],
  ['player_decoration', `TEXT DEFAULT 'none'`],     // viewer player decoration theme
  ['player_decoration_animated', 'INTEGER DEFAULT 1'],
  ['page_snow_enabled', 'INTEGER DEFAULT 0'],       // page-wide snow effect on viewer page
  ['player_custom_color', `TEXT DEFAULT ''`],       // custom player bar color when decoration='none'
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

// Seed singleton rows if empty
db.prepare(`INSERT OR IGNORE INTO config (id) VALUES (1)`).run();
db.prepare(`INSERT OR IGNORE INTO now_playing (id) VALUES (1)`).run();

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
    `).run('Default (OpenFalcon)', defaultHtml);
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

function setNowPlaying(sequenceName) {
  db.prepare(`
    UPDATE now_playing
    SET sequence_name = ?, started_at = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(sequenceName);
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
// Caller is responsible for confirming this destructive action with the user.
// Returns count of restored sequences.
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
    db.prepare(`DELETE FROM sequences`).run();
    const insertSeq = db.prepare(`
      INSERT INTO sequences
        (name, display_name, artist, category, media_name, image_url,
         duration_seconds, visible, votable, jukeboxable, is_psa, sort_order, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      insertSeq.run(
        it.name, it.display_name, it.artist, it.category, it.media_name, it.image_url,
        it.duration_seconds, it.visible, it.votable, it.jukeboxable, it.is_psa,
        it.sort_order, it.display_order
      );
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
};
