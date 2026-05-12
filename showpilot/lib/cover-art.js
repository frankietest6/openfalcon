// ============================================================
// ShowPilot — Cover Art Fetcher
//
// Sources, in order:
//   1. MusicBrainz / Cover Art Archive (free, no API key)
//   2. iTunes Search API (free, no API key)
//
// Covers download to <dataDir>/covers/<sequence-id>.jpg and
// the path '/covers/<id>.jpg' is stored in sequences.image_url.
// The Express server already serves /data/covers via static
// middleware (we add the route in server.js).
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Where covers live on disk
function coverDir() {
  const dir = path.join(__dirname, '..', 'data', 'covers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// HTTP/HTTPS GET that resolves with parsed JSON or buffer
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'ShowPilot/0.7 (https://github.com/ShowPilotFPP/ShowPilot)',
        'Accept': options.accept || 'application/json',
        ...(options.headers || {}),
      },
      timeout: 10000,
    }, (res) => {
      // Follow redirects (CAA returns 307/302 to actual image URL)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (options._depth ?? 0) < 5) {
        res.resume();
        return fetchUrl(res.headers.location, { ...options, _depth: (options._depth ?? 0) + 1 })
          .then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (options.binary) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Timeout fetching ${url}`)); });
  });
}

// ============================================================
// MusicBrainz / Cover Art Archive
// ============================================================
async function searchMusicBrainz(artist, title) {
  // MB is rate-limited to 1 req/s per UA. We're very low volume so OK.
  const query = encodeURIComponent(`recording:"${title}"${artist ? ` AND artist:"${artist}"` : ''}`);
  const url = `https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=5`;
  try {
    const data = await fetchUrl(url);
    const recordings = data.recordings || [];
    // Each recording has releases — we want a release with cover art available
    for (const rec of recordings) {
      for (const rel of (rec.releases || [])) {
        // Try to get cover art from CAA
        try {
          await fetchUrl(`https://coverartarchive.org/release/${rel.id}/front-500`, { binary: true, accept: 'image/jpeg' });
          return { releaseId: rel.id, source: 'musicbrainz', title: rel.title, artist: (rec['artist-credit'] || [{}])[0].name };
        } catch (e) { /* no cover for this release, try next */ }
      }
    }
  } catch (e) { /* search failed, fall through */ }
  return null;
}

// ============================================================
// iTunes Search API
// ============================================================
async function searchItunes(artist, title) {
  const term = encodeURIComponent([artist, title].filter(Boolean).join(' '));
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`;
  try {
    const data = await fetchUrl(url);
    const results = data.results || [];
    if (results.length === 0) return null;
    // Take the first result; upgrade artworkUrl100 to 600x600 by URL pattern
    const first = results[0];
    if (!first.artworkUrl100) return null;
    const hires = first.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg');
    return { url: hires, source: 'itunes', title: first.trackName, artist: first.artistName };
  } catch (e) { return null; }
}

// ============================================================
// Search both, return list of candidates (used by manual search modal)
// ============================================================
async function searchCovers(artist, title) {
  const candidates = [];

  // iTunes — return up to 5 results
  const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent([artist, title].filter(Boolean).join(' '))}&media=music&entity=song&limit=10`;
  try {
    const data = await fetchUrl(itunesUrl);
    for (const r of (data.results || [])) {
      if (!r.artworkUrl100) continue;
      candidates.push({
        source: 'itunes',
        url: r.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg'),
        thumbUrl: r.artworkUrl100,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
      });
    }
  } catch (e) { /* ignore */ }

  // MusicBrainz — search recordings with cover art
  try {
    const query = encodeURIComponent(`recording:"${title}"${artist ? ` AND artist:"${artist}"` : ''}`);
    const data = await fetchUrl(`https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=10`);
    for (const rec of (data.recordings || [])) {
      for (const rel of (rec.releases || []).slice(0, 2)) {
        candidates.push({
          source: 'musicbrainz',
          url: `https://coverartarchive.org/release/${rel.id}/front-500`,
          thumbUrl: `https://coverartarchive.org/release/${rel.id}/front-250`,
          title: rec.title,
          artist: ((rec['artist-credit'] || [{}])[0].name || ''),
          album: rel.title,
          releaseId: rel.id,
        });
      }
    }
  } catch (e) { /* ignore */ }

  return candidates;
}

// ============================================================
// Manual track search — used by the per-row "Search" button in the
// admin's Sequences tab. Behavior differs from searchCovers() in two
// ways: takes a single free-form query string (not artist/title pair)
// because users are typing whatever they want, and uses iTunes as the
// primary source with MusicBrainz as a fallback only when iTunes
// returns nothing. Returns up to 10 result candidates.
// ============================================================
async function searchTracks(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const results = [];

  // ---- Primary: iTunes ----
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=10`;
    const data = await fetchUrl(url);
    for (const r of (data.results || [])) {
      const thumb = r.artworkUrl100 || '';
      results.push({
        source: 'itunes',
        title: r.trackName || '',
        artist: r.artistName || '',
        album: r.collectionName || '',
        thumbUrl: thumb,
        // iTunes returns a 100x100 URL; rewriting to 600x600 gets the high-res
        // variant that we'll download as the cover.
        coverUrl: thumb.replace('100x100bb.jpg', '600x600bb.jpg'),
      });
    }
  } catch (e) {
    console.warn('[searchTracks] iTunes lookup failed:', e.message);
  }

  // ---- Fallback: MusicBrainz, only if iTunes was empty ----
  // MB has better coverage of remixes, mashups, and obscure light-show
  // material, but its results don't always have artwork. Filter those out
  // since the user is choosing visually.
  if (results.length === 0) {
    try {
      const data = await fetchUrl(
        `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=10`
      );
      for (const rec of (data.recordings || [])) {
        const artist = ((rec['artist-credit'] || [{}])[0].name || '');
        for (const rel of (rec.releases || []).slice(0, 2)) {
          results.push({
            source: 'musicbrainz',
            title: rec.title || '',
            artist,
            album: rel.title || '',
            thumbUrl: `https://coverartarchive.org/release/${rel.id}/front-250`,
            coverUrl: `https://coverartarchive.org/release/${rel.id}/front-500`,
            releaseId: rel.id,
          });
        }
      }
    } catch (e) {
      console.warn('[searchTracks] MusicBrainz fallback failed:', e.message);
    }
  }

  return results;
}

// ============================================================
// Download a cover URL to disk and return the local path.
// Caller is responsible for updating sequences.image_url.
// ============================================================
async function downloadCover(sourceUrl, sequenceId) {
  const dir = coverDir();
  const localPath = path.join(dir, `${sequenceId}.jpg`);
  const buf = await fetchUrl(sourceUrl, { binary: true, accept: 'image/jpeg,image/png,image/*' });

  // Sanity check — skip writing if response is suspiciously small (probably an error page)
  if (buf.length < 1024) {
    throw new Error(`Cover from ${sourceUrl} too small (${buf.length} bytes) — likely not an image`);
  }

  fs.writeFileSync(localPath, buf);
  return `/covers/${sequenceId}.jpg`;
}

// ============================================================
// Fetch a cover for a sequence using auto strategy:
// MB first, fall back to iTunes. Returns local path or null.
// ============================================================
async function autoFetchCover(seq) {
  const artist = (seq.artist || '').trim();
  const title = (seq.display_name || seq.name || '').trim();
  if (!title) return null;

  // Try MusicBrainz first
  const mb = await searchMusicBrainz(artist, title);
  if (mb) {
    try {
      return await downloadCover(`https://coverartarchive.org/release/${mb.releaseId}/front-500`, seq.id);
    } catch (e) { /* fall through to iTunes */ }
  }

  // Fall back to iTunes
  const it = await searchItunes(artist, title);
  if (it) {
    try {
      return await downloadCover(it.url, seq.id);
    } catch (e) { /* both failed */ }
  }

  return null;
}

// ============================================================
// Add a cache-buster to local cover URLs (?v=<mtime>) so browsers
// re-fetch when we replace a cover. Returns the original URL unchanged
// for external URLs or null/empty inputs.
// ============================================================
function bustCoverUrl(imageUrl) {
  if (!imageUrl) return imageUrl;
  // Only mtime-bust local /covers/ URLs; external URLs are caller-managed
  if (!String(imageUrl).startsWith('/covers/')) return imageUrl;
  const filename = String(imageUrl).slice('/covers/'.length).split('?')[0];
  const filePath = path.join(coverDir(), filename);
  try {
    const stat = fs.statSync(filePath);
    return `/covers/${filename}?v=${Math.floor(stat.mtimeMs)}`;
  } catch (e) {
    return imageUrl; // file missing — return as-is, browser will 404
  }
}

// Convenience for arrays of sequences — adds cache-bust to each image_url
function bustSequenceCovers(sequences) {
  if (!Array.isArray(sequences)) return sequences;
  return sequences.map(s => ({
    ...s,
    image_url: bustCoverUrl(s.image_url),
  }));
}

module.exports = {
  coverDir,
  searchCovers,
  searchTracks,
  downloadCover,
  autoFetchCover,
  bustCoverUrl,
  bustSequenceCovers,
};
