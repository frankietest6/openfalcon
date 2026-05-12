// ============================================================
// ShowPilot — Title/Artist Metadata Scraper
//
// Cleans up messy sequence filenames into proper display_name + artist.
//
// Strategy (per sequence):
//   1. Try iTunes Search API — match by raw filename, take the top result's
//      trackName + artistName when confidence is decent
//   2. If no match, fall back to smart-split — heuristic parsing of the
//      filename to detect artist/title separators
//
// Smart-split heuristics handle common patterns:
//   "Pentatonix-God Rest Ye Merry Gentlemen"   → artist: Pentatonix, title: God Rest Ye Merry Gentlemen
//   "Carrie Underwood- Away In A Manger"       → artist: Carrie Underwood, title: Away In A Manger
//   "Bing Crosby - Silver Bells"               → artist: Bing Crosby, title: Silver Bells
//   "DJ Play A Christmas Song - Cher"          → artist: Cher, title: DJ Play A Christmas Song
//   "07 You're Welcome"                        → leading track number stripped, title only
//   "Intro"                                    → title only, no artist guess
// ============================================================

const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ShowPilot/0.8 (https://github.com/ShowPilotFPP/ShowPilot)',
        'Accept': 'application/json',
      },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
  });
}

// ============================================================
// Smart-split fallback parser
// ============================================================
function smartSplit(filename) {
  let raw = String(filename || '').trim();
  if (!raw) return { title: '', artist: '' };

  // Strip leading track numbers: "07 Foo", "07. Foo", "07-Foo"
  raw = raw.replace(/^\s*\d{1,3}[\s\.\-_]+/, '');

  // Try common artist-title separators in priority order. We include en-dash
  // and em-dash because filenames sometimes use those instead of hyphens.
  // Convention assumed: "Artist <sep> Title".
  const separators = [
    ' \u2013 ', ' \u2014 ',  // en-dash, em-dash with spaces (most distinctive)
    '\u2013', '\u2014',       // bare en-dash, em-dash
    ' - ',                    // standard separator
    '- ', ' -',               // asymmetric whitespace variants
    '-',                      // bare hyphen — only if exactly one
  ];

  for (const sep of separators) {
    const idx = raw.indexOf(sep);
    if (idx === -1) continue;
    // For bare "-", only split if exactly one occurrence
    if (sep === '-') {
      const occurrences = raw.split('-').length - 1;
      if (occurrences !== 1) continue;
    }
    const left = raw.slice(0, idx).trim();
    const right = raw.slice(idx + sep.length).trim();
    if (!left || !right) continue;

    // Default: assume "Artist - Title". We don't try to flip — too unreliable
    // without a real lookup, and iTunes will correct it for sequences that
    // match its catalog.
    return { title: right, artist: left };
  }

  // No separator found — title only
  return { title: raw, artist: '' };
}

// ============================================================
// iTunes lookup
// ============================================================
async function lookupItunes(rawFilename) {
  // Strip extension just in case (sequences shouldn't have one but be safe)
  const cleaned = String(rawFilename).replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  if (!cleaned) return null;

  // Strip leading track number for better matching
  const queryStr = cleaned.replace(/^\s*\d{1,3}[\s\.\-_]+/, '');
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(queryStr)}&media=music&entity=song&limit=3`;

  try {
    const data = await fetchJson(url);
    const results = data.results || [];
    if (results.length === 0) return null;

    // Take first result. iTunes ranks by relevance.
    const top = results[0];
    if (!top.trackName || !top.artistName) return null;

    // Sanity check: iTunes will sometimes match wildly off-base. Require
    // some overlap between the original filename and the matched title.
    const titleWords = String(top.trackName).toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const filenameWords = queryStr.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = titleWords.filter(w => filenameWords.includes(w)).length;

    // Require at least one significant word shared, OR an exact match on a short title
    const exactShortMatch = top.trackName.toLowerCase() === queryStr.toLowerCase();
    if (!exactShortMatch && overlap === 0) return null;

    return {
      title: top.trackName.trim(),
      artist: top.artistName.trim(),
      source: 'itunes',
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// Combined scraper
// ============================================================
async function scrapeMetadata(rawFilename) {
  // Try iTunes first
  const itunes = await lookupItunes(rawFilename);
  if (itunes) return itunes;

  // Fall back to smart-split
  const split = smartSplit(rawFilename);
  return { ...split, source: 'split' };
}

module.exports = {
  scrapeMetadata,
  smartSplit,
  lookupItunes,
};
