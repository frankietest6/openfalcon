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
  return { path: filePath, mimeType: row.mime_type || 'audio/mpeg', hash: row.hash };
}

// Hash-based lookup (v0.24.3+). Sequences store their audio file's hash
// directly in sequences.audio_hash; this resolves that hash to a cached
// file path. The advantage over getCachedFileForMediaName: many
// sequences can share the same hash (legitimately — e.g. "indoor +
// outdoor lights" and "outdoor only" sequences using the same MP3),
// and this lookup serves them all from the single shared cache row.
function getCachedFileByHash(hash) {
  if (!hash || !isValidHash(hash)) return null;
  const row = db.prepare(`
    SELECT mime_type FROM audio_cache_files WHERE hash = ? LIMIT 1
  `).get(hash);
  if (!row) return null;
  const filePath = pathForHash(hash);
  if (!fs.existsSync(filePath)) return null;
  return { path: filePath, mimeType: row.mime_type || 'audio/mpeg', hash };
}

// Look up the cache file for a sequence by its name. Resolves the
// sequence's audio_hash, then resolves that hash to a cached file.
// Falls back to the old media_name lookup if audio_hash isn't set
// (e.g. installs that haven't yet re-synced after the migration).
function getCachedFileForSequence(sequenceName) {
  const seq = db.prepare(
    `SELECT audio_hash, media_name FROM sequences WHERE name = ? COLLATE NOCASE`
  ).get(sequenceName);
  if (!seq) return null;
  if (seq.audio_hash) {
    const byHash = getCachedFileByHash(seq.audio_hash);
    if (byHash) return byHash;
  }
  // Legacy fallback — old installs that haven't re-synced will keep
  // working by media_name lookup until the next sync sets audio_hash.
  if (seq.media_name) {
    return getCachedFileForMediaName(seq.media_name);
  }
  return null;
}

// Store an uploaded file. Verifies the claimed hash matches the actual
// bytes (defense against plugin bugs or tampering between plugin and
// server). Throws if hash doesn't match. Returns the stored file path.
//
// Side effect: this hash claims ownership of the given media_name. If
// any OTHER row in the table is currently mapped to the same media_name
// (e.g. a previous version of the same audio file), that mapping is
// cleared — its row is kept (the file bytes might still be valid) but
// its media_name is set to NULL so the lookup query no longer returns
// it. The orphaned bytes can be cleaned up by pruneOrphanedHashes()
// later. Without this, multiple rows could point at the same media_name
// and the lookup's LIMIT 1 would non-deterministically return either,
// causing stale audio to be served.
function storeUploadedFile(buf, claimedHash, mediaName, mimeType) {
  if (!isValidHash(claimedHash)) {
    throw new Error('Invalid hash format');
  }
  const actualHash = hashBuffer(buf);
  if (actualHash !== claimedHash) {
    throw new Error(`Hash mismatch: claimed ${claimedHash}, actual ${actualHash}`);
  }
  const filePath = pathForHash(claimedHash);

  // Write the raw file first, then attempt to transcode to AAC/M4A.
  // M4A has a proper seek table (moov atom) and clean keyframe boundaries,
  // enabling inaudible micro-seeks for audio sync correction.
  // MP3 has ~26ms keyframe spacing causing decoder restarts on seek.
  fs.writeFileSync(filePath, buf);

  // Attempt ffmpeg transcoding to M4A (AAC with faststart)
  const m4aPath = filePath.replace(/\.bin$/, '.m4a');
    try {
      const { execSync } = require('child_process');
      execSync('which ffmpeg', { timeout: 2000 });
      let inputFormat = '';
      try {
        const probe = execSync(`ffprobe -v quiet -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${filePath}" 2>/dev/null`).toString().trim().split(',')[0];
        if (probe) inputFormat = `-f ${probe}`;
      } catch (_) {}
      const m4aPath = filePath.replace(/\.bin$/, '.m4a');
      execSync(
        `ffmpeg -y ${inputFormat} -i "${filePath}" -c:a aac -b:a 192k -movflags +faststart "${m4aPath}" 2>/dev/null`,
        { timeout: 30000 }
      );
    // If transcoding succeeded, remove raw file and use m4a
    if (fs.existsSync(m4aPath) && fs.statSync(m4aPath).size > 1000) {
      fs.unlinkSync(filePath);
      // Rename m4a to .bin so the rest of the code works unchanged
      fs.renameSync(m4aPath, filePath);
      mimeType = 'audio/mp4';
      console.log(`[audio-cache] transcoded to AAC/M4A: ${mediaName}`);
    }
  } catch (err) {
    // ffmpeg not available or failed — keep raw file as-is
    console.warn(`[audio-cache] ffmpeg transcoding failed for ${mediaName}: ${err.message}`);
    if (fs.existsSync(m4aPath)) try { fs.unlinkSync(m4aPath); } catch (_) {}
  }

  // Detach any OTHER rows currently claiming this media_name. Without
  // this, after a re-extraction (e.g. fixing a bug like switching from
  // M4A to MP3 output), the new hash would coexist with the old one,
  // both pointing at the same media_name. SQLite's LIMIT 1 makes the
  // lookup result non-deterministic — could return either row's hash.
  db.prepare(`
    UPDATE audio_cache_files SET media_name = NULL
    WHERE media_name = ? AND hash != ?
  `).run(mediaName, claimedHash);

  // Upsert the DB record. If a row already exists with this hash but a
  // different media_name, update — same hash means same bytes, but the
  // user might have renamed the file on FPP, and we want the latest
  // mediaName mapping.
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
  // Detach any other rows currently claiming this media_name. Same
  // reasoning as in storeUploadedFile — prevents duplicate mappings
  // that would make the lookup query non-deterministic.
  db.prepare(`
    UPDATE audio_cache_files SET media_name = NULL
    WHERE media_name = ? AND hash != ?
  `).run(mediaName, hash);
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

// Remove cache entries that no longer correspond to any active sequence.
// Catches three cases:
//   (1) media_name is NULL — detached by storeUploadedFile or linkMediaNameToHash
//       when a newer hash took over (e.g. re-extracted with different settings)
//   (2) media_name doesn't match any sequence — sequence was deleted from FPP
//       since the file was originally cached
//   (3) on-disk file is missing — DB row exists but bytes are gone
// Returns the number of entries removed.
function pruneOrphanedHashes() {
  const orphaned = db.prepare(`
    SELECT hash FROM audio_cache_files
    WHERE media_name IS NULL
       OR media_name NOT IN (SELECT media_name FROM sequences WHERE media_name IS NOT NULL)
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

// Transcode existing cached MP3 files to AAC/M4A in the background.
// Called once at startup. Skips files already transcoded (mime_type = audio/mp4).
function transcodeCacheToM4A() {
  try {
    const { execSync, execFile } = require('child_process');
    // Check ffmpeg is available
    try { execSync('which ffmpeg', { timeout: 2000 }); } catch (_) { return; }

    const rows = db.prepare(`
      SELECT hash, mime_type FROM audio_cache_files
      WHERE mime_type IS NULL OR mime_type != 'audio/mp4'
    `).all();

    if (rows.length === 0) return;
    console.log(`[audio-cache] transcoding ${rows.length} cached file(s) to AAC/M4A...`);

    let converted = 0;
    for (const row of rows) {
      const binPath = pathForHash(row.hash);
      if (!fs.existsSync(binPath)) continue;
      const m4aPath = binPath + '.m4a.tmp';
      try {
        // Probe input format since .bin extension isn't recognized by ffmpeg
        let inputFormat = '';
        try {
          const probe = execSync(`ffprobe -v quiet -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${binPath}" 2>/dev/null`).toString().trim().split(',')[0];
          if (probe) inputFormat = `-f ${probe}`;
        } catch (_) {}
        execSync(
          `ffmpeg -y ${inputFormat} -i "${binPath}" -c:a aac -b:a 192k -movflags +faststart "${m4aPath}" 2>/dev/null`,
          { timeout: 60000 }
        );
        if (fs.existsSync(m4aPath) && fs.statSync(m4aPath).size > 1000) {
          fs.renameSync(m4aPath, binPath);
          db.prepare(`UPDATE audio_cache_files SET mime_type = 'audio/mp4' WHERE hash = ?`).run(row.hash);
          converted++;
        } else {
          try { fs.unlinkSync(m4aPath); } catch (_) {}
        }
      } catch (err) {
        try { fs.unlinkSync(m4aPath); } catch (_) {}
        console.warn(`[audio-cache] transcode failed for ${row.hash.slice(0,8)}: ${err.message}`);
      }
    }
    console.log(`[audio-cache] transcoded ${converted}/${rows.length} files to AAC/M4A`);
  } catch (err) {
    console.warn('[audio-cache] background transcode failed:', err.message);
  }
}

// Run transcode migration in background after a short delay
setTimeout(() => {
  try { transcodeCacheToM4A(); } catch (_) {}
}, 5000);

module.exports = {
  cacheDir,
  pathForHash,
  isValidHash,
  hashBuffer,
  getCachedHashes,
  getCachedPathForMediaName,
  getCachedFileForMediaName,
  getCachedFileByHash,
  getCachedFileForSequence,
  storeUploadedFile,
  linkMediaNameToHash,
  getCacheStats,
  pruneOrphanedHashes,
  transcodeCacheToM4A,
};
