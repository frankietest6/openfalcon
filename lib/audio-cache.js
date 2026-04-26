// ============================================================
// ShowPilot — Audio Cache
// ============================================================
// Stores audio files locally so viewer requests can be served from
// ShowPilot's disk instead of proxying every request through FPP. This
// solves three problems at once:
//
//   1. SCALE — FPP runs on a Pi with an SD card. Many concurrent reads
//      of the same audio file thrash the SD card controller, causing
//      stalls for viewers. ShowPilot can be on real hardware (NUC, NAS,
//      LXC) where concurrent reads come from page cache or NVMe.
//
//   2. LATENCY — Viewer audio start no longer requires a cross-network
//      hop to FPP. First-byte latency drops from ~500-1500ms to
//      ~50-100ms.
//
//   3. INDEPENDENCE — Once cached, audio plays even if FPP is briefly
//      unreachable (network blip, FPP restart). Viewers don't notice.
//
// Storage layout:
//
//   data/audio-cache/<sha256>.bin       — content-addressed audio file
//   audio_cache_files (DB table)        — sha256 → media_name mapping
//
// Files are content-addressed by hash. Two sequences sharing the same
// audio file (e.g. a song and its alternate-light-show pairing) share
// one cache entry. Renaming a sequence on FPP doesn't invalidate the
// cache — same hash means same bytes.
//
// Lifecycle:
//   1. Plugin computes hashes of FPP music files during sync.
//   2. Plugin asks /audio-cache/manifest what hashes ShowPilot has.
//   3. Plugin uploads missing files to /audio-cache/upload.
//   4. Plugin posts mediaName → hash links to /audio-cache/link.
//   5. /api/audio-stream/<seq> serves from cache, falls back to FPP
//      proxy when not cached.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');

// Resolve the cache directory relative to the data dir. We piggyback on
// dbPath the same way secret-store does — wherever the SQLite DB lives,
// audio cache lives next to it.
function cacheDir() {
  const config = require('./config-loader');
  const dbPath = config.dbPath || './data/showpilot.db';
  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = path.isAbsolute(dbPath)
    ? path.dirname(dbPath)
    : path.resolve(projectRoot, path.dirname(dbPath));
  const dir = path.join(dataDir, 'audio-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  return dir;
}

// Path to a cached file given its hash. Hash MUST be already validated
// (hex, 64 chars) before being passed here — we don't sanitize, callers
// do.
function pathForHash(hash) {
  return path.join(cacheDir(), `${hash}.bin`);
}

// Validate a hex SHA-256 string. The plugin sends hashes; we want to
// reject anything that isn't exactly 64 lowercase hex chars before
// using it as a filename or DB key. Defense against path traversal.
function isValidHash(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

// Compute the SHA-256 of a Buffer. Used at upload time to verify the
// plugin's hash claim matches the bytes we received.
function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Get the list of all hashes currently in the cache. Used by the manifest
// endpoint so the plugin can compute the diff (what to upload).
function getCachedHashes() {
  const rows = db.prepare(`SELECT hash FROM audio_cache_files`).all();
  return rows.map(r => r.hash);
}

// Look up the cached file path for a given media_name. Returns null if
// not cached. Used by /api/audio-stream when serving viewer requests.
function getCachedPathForMediaName(mediaName) {
  const row = db.prepare(`
    SELECT hash FROM audio_cache_files WHERE media_name = ? LIMIT 1
  `).get(mediaName);
  if (!row) return null;
  const filePath = pathForHash(row.hash);
  // Sanity check: DB says we have it, but did the file get deleted out
  // from under us? Return null if so — caller can fall back to FPP proxy.
  // Don't auto-clean the orphan DB row here; that happens in the periodic
  // verifier (or on next plugin sync, whichever comes first).
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

// Same as getCachedPathForMediaName but also returns the stored MIME
// type so the audio-stream route can set the correct Content-Type
// header. Important for video-extracted audio (M4A/AAC) — without
// the right MIME the browser won't decode it correctly. Returns
// { path, mimeType } or null when not cached.
function getCachedFileForMediaName(mediaName) {
  const row = db.prepare(`
    SELECT hash, mime_type FROM audio_cache_files WHERE media_name = ? LIMIT 1
  `).get(mediaName);
  if (!row) return null;
  const filePath = pathForHash(row.hash);
  if (!fs.existsSync(filePath)) return null;
  return { path: filePath, mimeType: row.mime_type || 'audio/mpeg' };
}

// Store an uploaded file. Verifies the claimed hash matches the actual
// bytes (defense against plugin bugs or tampering between plugin and
// server). Throws if hash doesn't match. Returns the stored file path.
function storeUploadedFile(buf, claimedHash, mediaName, mimeType) {
  if (!isValidHash(claimedHash)) {
    throw new Error('Invalid hash format');
  }
  const actualHash = hashBuffer(buf);
  if (actualHash !== claimedHash) {
    throw new Error(`Hash mismatch: claimed ${claimedHash}, actual ${actualHash}`);
  }
  const filePath = pathForHash(claimedHash);
  fs.writeFileSync(filePath, buf);

  // Upsert the DB record. If a row already exists with this hash but a
  // different media_name, update — same hash means same bytes, but the
  // user might have renamed the file on FPP, and we want the latest
  // mediaName mapping. (Multiple media_names per hash IS possible if
  // two sequences point at the same audio file; in practice we keep
  // the most-recently-seen one. The viewer route looks up by media_name
  // and finds the file regardless.)
  db.prepare(`
    INSERT INTO audio_cache_files (hash, media_name, size_bytes, mime_type, cached_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(hash) DO UPDATE SET
      media_name = excluded.media_name,
      size_bytes = excluded.size_bytes,
      mime_type = excluded.mime_type,
      cached_at = CURRENT_TIMESTAMP
  `).run(claimedHash, mediaName, buf.length, mimeType || 'audio/mpeg');

  return filePath;
}

// Link a media_name to a hash. Used when the plugin reports "this
// sequence's audio file lives in cache as hash X" without re-uploading
// (because we already had that hash from a previous sync). Updates the
// existing row's media_name if needed.
function linkMediaNameToHash(mediaName, hash) {
  if (!isValidHash(hash)) {
    throw new Error('Invalid hash format');
  }
  // Verify the file actually exists in cache
  if (!fs.existsSync(pathForHash(hash))) {
    throw new Error(`Hash ${hash} is not in cache`);
  }
  db.prepare(`
    UPDATE audio_cache_files SET media_name = ?, cached_at = CURRENT_TIMESTAMP WHERE hash = ?
  `).run(mediaName, hash);
}

// Stats for the admin UI — total file count and total bytes used.
function getCacheStats() {
  const row = db.prepare(`
    SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
    FROM audio_cache_files
  `).get();
  return {
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
  };
}

// Remove cache entries for hashes no longer referenced by any sequence's
// media_name. Used during sync as cleanup to prevent unbounded growth.
// Returns the number of entries removed.
function pruneOrphanedHashes() {
  const orphaned = db.prepare(`
    SELECT hash FROM audio_cache_files
    WHERE media_name NOT IN (SELECT media_name FROM sequences WHERE media_name IS NOT NULL)
  `).all();
  let removed = 0;
  for (const row of orphaned) {
    const filePath = pathForHash(row.hash);
    try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
    db.prepare(`DELETE FROM audio_cache_files WHERE hash = ?`).run(row.hash);
    removed++;
  }
  return removed;
}

module.exports = {
  cacheDir,
  pathForHash,
  isValidHash,
  hashBuffer,
  getCachedHashes,
  getCachedPathForMediaName,
  getCachedFileForMediaName,
  storeUploadedFile,
  linkMediaNameToHash,
  getCacheStats,
  pruneOrphanedHashes,
};
