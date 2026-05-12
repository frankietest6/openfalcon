// ============================================================
// Backup & Restore (v0.25.0+)
// ============================================================
// Exports a JSON backup of the show's configuration and templates,
// and restores from one. Includes optional cover-art images
// (base64-encoded inline) and the config.js secrets file.
//
// Format: a single JSON file. Custom format, no zip dependency.
// Cover art and config.js are embedded as base64 strings in the
// JSON object. Trade ~33% size overhead for zero new dependencies
// and a single inspectable file.
//
// File extension: .json (mime application/json), filename
// "showpilot-backup-YYYY-MM-DD-HHMM.json".
//
// Restore policies (per section):
//   - 'replace': delete existing rows, insert backup rows
//   - 'merge':   upsert backup rows by natural key (name/username),
//                keep destination rows not in backup
//   - 'skip':    don't touch this section
//
// Compatible across schema versions: each row is a flat key/value map.
// On import we filter to columns the destination knows about, so a
// backup from v0.24 imports cleanly into v0.30. Forward-only:
// can't import a backup from a NEWER version into an older server
// (refused with a clear error).
// ============================================================

const fs = require('fs');
const path = require('path');

// Use the cover-art module's own dir resolver — that way the backup
// module can't drift from where covers actually live (it's `data/covers`,
// not `data/cover-art`, and that's the kind of thing that's easy to get
// wrong if you hardcode it).
const { coverDir } = require('./cover-art');

const BACKUP_FORMAT_VERSION = 1;
const CONFIG_JS_PATH = path.join(__dirname, '..', 'config.js');

// Sections we handle, in deterministic order.
// Each section has: name, table, primaryKey (for upsert by ID),
// naturalKey (for merge by content match), and optional excludeColumns.
const SECTIONS = [
  {
    name: 'config',
    table: 'config',
    primaryKey: 'id',
    naturalKey: 'id',          // single-row table — merge means update
    excludeColumns: [
      // Runtime-only state — not part of backup intent
      'tiebreak_active', 'tiebreak_started_at', 'tiebreak_deadline_at',
      'tiebreak_candidates', 'interactions_since_last_psa',
      'plugin_last_sync_at', 'plugin_last_sync_playlist',
      'plugin_last_sync_count',
    ],
  },
  {
    name: 'sequences',
    table: 'sequences',
    primaryKey: 'id',
    naturalKey: 'name',
    excludeColumns: [],
    // Columns excluded by default but included when buildBackup({ includeStats: true }).
    // These are runtime play counters that are usually not what you want to
    // ship to a fresh install (you don't want yesterday's play counts to
    // affect today's PSA scheduling on a new server) — but if you're
    // migrating servers and want fidelity, opt in via the export checkbox.
    statsColumns: ['last_played_at', 'plays_since_hidden'],
  },
  {
    name: 'templates',
    table: 'viewer_page_templates',
    primaryKey: 'id',
    naturalKey: 'name',
    excludeColumns: [],
  },
  {
    name: 'users',
    table: 'users',
    primaryKey: 'id',
    naturalKey: 'username',
    excludeColumns: [],
  },
];

// ============================================================
// Helpers
// ============================================================

function getDb() {
  return require('./db').db;
}

function getServerVersion() {
  try {
    return require('../package.json').version;
  } catch (e) {
    return 'unknown';
  }
}

function tableColumns(tableName) {
  const db = getDb();
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
}

// Strip excluded columns from a row dump. Mutates input for speed.
function stripColumns(rows, excludeColumns) {
  if (!excludeColumns || excludeColumns.length === 0) return rows;
  return rows.map(row => {
    const out = {};
    for (const k of Object.keys(row)) {
      if (excludeColumns.indexOf(k) === -1) out[k] = row[k];
    }
    return out;
  });
}

// ============================================================
// EXPORT
// ============================================================

// Build the backup object. Returns a JSON-serializable structure.
// `options.includeCoverArt` controls whether cover-art images are bundled.
function buildBackup(options) {
  options = options || {};
  const db = getDb();

  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    serverVersion: getServerVersion(),
    exportedAt: new Date().toISOString(),
    includes: {
      sections: SECTIONS.map(s => s.name),
      coverArt: !!options.includeCoverArt,
      stats: !!options.includeStats,
      configJs: true,
    },
    counts: {},
  };

  // Dump each section. For sections that have statsColumns (currently
  // just sequences), we include those columns iff includeStats is set;
  // otherwise we strip them along with anything in excludeColumns.
  const data = {};
  for (const section of SECTIONS) {
    const rows = db.prepare(`SELECT * FROM ${section.table}`).all();
    let toExclude = section.excludeColumns || [];
    if (section.statsColumns && !options.includeStats) {
      toExclude = toExclude.concat(section.statsColumns);
    }
    const stripped = stripColumns(rows, toExclude);
    data[section.name] = stripped;
    manifest.counts[section.name] = stripped.length;
  }

  // Read config.js verbatim. This holds jwtSecret + showToken.
  let configJs = null;
  try {
    if (fs.existsSync(CONFIG_JS_PATH)) {
      configJs = fs.readFileSync(CONFIG_JS_PATH, 'utf8');
    }
  } catch (e) {
    console.warn('[backup] could not read config.js:', e.message);
  }

  // Optionally bundle cover-art images.
  // The disk path comes from cover-art.coverDir() so it stays in sync
  // with where the cover-art module actually writes files. Sequence rows
  // reference these by `image_url: '/covers/<id>.jpg'`, so the filenames
  // here line up with what sequences expect after restore.
  let coverArt = null;
  if (options.includeCoverArt) {
    coverArt = {};
    const dir = coverDir();
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            // Cap individual file size at 2 MB to avoid runaway backups
            if (stat.size > 2 * 1024 * 1024) {
              console.warn(`[backup] skipping oversized cover-art file: ${file}`);
              continue;
            }
            coverArt[file] = fs.readFileSync(fullPath).toString('base64');
          } catch (e) {
            console.warn(`[backup] could not read cover-art ${file}:`, e.message);
          }
        }
        console.log(`[backup] bundled ${Object.keys(coverArt).length} cover-art files from ${dir}`);
      } else {
        console.log(`[backup] cover-art dir not found at ${dir} — none to bundle`);
      }
    } catch (e) {
      console.warn('[backup] could not enumerate cover-art dir:', e.message);
    }
  }

  return {
    manifest,
    data,
    configJs,
    coverArt,
  };
}

// ============================================================
// INSPECT
// ============================================================

// Validates a backup blob and returns a summary suitable for the
// restore-confirmation UI. Throws on validation failure.
function inspectBackup(backup) {
  if (!backup || typeof backup !== 'object') {
    throw new Error('Backup is not a valid JSON object');
  }
  const m = backup.manifest;
  if (!m || typeof m.formatVersion !== 'number') {
    throw new Error('Backup is missing manifest or format version');
  }
  if (m.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(`Backup format version ${m.formatVersion} is newer than this server supports (${BACKUP_FORMAT_VERSION}). Upgrade ShowPilot before restoring.`);
  }
  if (!backup.data || typeof backup.data !== 'object') {
    throw new Error('Backup is missing data section');
  }

  // Compare per-section counts: backup vs destination
  const summary = {
    backupVersion: m.serverVersion,
    backupExportedAt: m.exportedAt,
    formatVersion: m.formatVersion,
    hasConfigJs: !!backup.configJs,
    coverArtCount: backup.coverArt ? Object.keys(backup.coverArt).length : 0,
    sections: {},
  };

  const db = getDb();
  for (const section of SECTIONS) {
    const backupRows = backup.data[section.name] || [];
    const destCount = db.prepare(`SELECT COUNT(*) AS n FROM ${section.table}`).get().n;

    // For natural-key comparisons, compute the intersection
    let inBoth = 0;
    let onlyInBackup = 0;
    let onlyInDest = 0;
    if (section.naturalKey && backupRows.length > 0) {
      const backupKeys = new Set(backupRows.map(r => String(r[section.naturalKey])));
      const destRows = db.prepare(`SELECT ${section.naturalKey} FROM ${section.table}`).all();
      const destKeys = new Set(destRows.map(r => String(r[section.naturalKey])));
      for (const k of backupKeys) {
        if (destKeys.has(k)) inBoth++; else onlyInBackup++;
      }
      for (const k of destKeys) {
        if (!backupKeys.has(k)) onlyInDest++;
      }
    }

    summary.sections[section.name] = {
      backupCount: backupRows.length,
      destCount,
      inBoth,
      onlyInBackup,
      onlyInDest,
    };
  }

  return summary;
}

// ============================================================
// RESTORE
// ============================================================

// Apply a backup to the database. policies is an object like
// { config: 'replace', sequences: 'merge', templates: 'merge',
//   users: 'merge', secrets: 'replace' }.
//
// Atomic: wraps the entire operation in a SQLite transaction.
// If anything throws, the transaction rolls back and DB state
// is unchanged.
//
// Returns: { restored: { sectionName: count, ... },
//            secretsRestored: bool, configJsRestored: bool,
//            coverArtRestored: count, requiresRestart: bool }
function restoreBackup(backup, policies, options) {
  options = options || {};
  inspectBackup(backup);  // throws on invalid

  const db = getDb();
  const result = {
    restored: {},
    secretsRestored: false,
    configJsRestored: false,
    coverArtRestored: 0,
    requiresRestart: false,
  };

  // Build the work as a single transaction so a failure in any
  // section rolls back the entire restore.
  const tx = db.transaction(() => {
    for (const section of SECTIONS) {
      const policy = policies[section.name] || 'skip';
      if (policy === 'skip') {
        result.restored[section.name] = 0;
        continue;
      }

      const backupRows = backup.data[section.name] || [];
      const destColumns = tableColumns(section.table);

      // Filter each row to columns the destination has. Drops any
      // columns from a newer schema we don't understand.
      const filteredRows = backupRows.map(row => {
        const out = {};
        for (const k of Object.keys(row)) {
          if (destColumns.indexOf(k) !== -1) out[k] = row[k];
        }
        return out;
      });

      if (policy === 'replace') {
        // Wipe destination, insert backup rows. Skip the wipe for
        // the config table since it's a single row that we always
        // want to keep one of.
        if (section.table === 'config') {
          // Single-row table: do an UPDATE instead of DELETE + INSERT
          // so the row's id stays at 1 and other tables' references
          // don't break. (Currently no FKs but defensive.)
          if (filteredRows.length > 0) {
            const row = filteredRows[0];
            // Drop the id column from the update — we want id=1 to stay.
            const updateCols = Object.keys(row).filter(k => k !== 'id');
            if (updateCols.length > 0) {
              const setClause = updateCols.map(c => `${c} = @${c}`).join(', ');
              const stmt = db.prepare(`UPDATE config SET ${setClause} WHERE id = 1`);
              stmt.run(row);
            }
          }
        } else {
          db.prepare(`DELETE FROM ${section.table}`).run();
          if (filteredRows.length > 0) {
            // Insert each row preserving its primary key
            for (const row of filteredRows) {
              const cols = Object.keys(row);
              const placeholders = cols.map(c => `@${c}`).join(', ');
              const stmt = db.prepare(
                `INSERT INTO ${section.table} (${cols.join(', ')}) VALUES (${placeholders})`
              );
              stmt.run(row);
            }
          }
        }
        result.restored[section.name] = filteredRows.length;
      } else if (policy === 'merge') {
        // Upsert by natural key. For each backup row, find a matching
        // destination row by naturalKey value; if found, UPDATE it,
        // otherwise INSERT.
        let count = 0;
        for (const row of filteredRows) {
          if (section.table === 'config') {
            // Single-row: same as replace path for config
            const updateCols = Object.keys(row).filter(k => k !== 'id');
            if (updateCols.length > 0) {
              const setClause = updateCols.map(c => `${c} = @${c}`).join(', ');
              db.prepare(`UPDATE config SET ${setClause} WHERE id = 1`).run(row);
            }
            count++;
            continue;
          }

          const naturalKeyValue = row[section.naturalKey];
          const existing = db.prepare(
            `SELECT id FROM ${section.table} WHERE ${section.naturalKey} = ? LIMIT 1`
          ).get(naturalKeyValue);

          if (existing) {
            // UPDATE — drop the primary key from the SET clause to
            // preserve the destination's id (foreign key safety).
            const updateCols = Object.keys(row).filter(c => c !== section.primaryKey);
            if (updateCols.length > 0) {
              const setClause = updateCols.map(c => `${c} = @${c}`).join(', ');
              db.prepare(
                `UPDATE ${section.table} SET ${setClause} WHERE ${section.primaryKey} = ${existing.id}`
              ).run(row);
            }
          } else {
            // INSERT — drop the primary key so the destination assigns
            // a fresh one (avoids ID collisions).
            const insertRow = { ...row };
            delete insertRow[section.primaryKey];
            const cols = Object.keys(insertRow);
            const placeholders = cols.map(c => `@${c}`).join(', ');
            db.prepare(
              `INSERT INTO ${section.table} (${cols.join(', ')}) VALUES (${placeholders})`
            ).run(insertRow);
          }
          count++;
        }
        result.restored[section.name] = count;
      } else {
        throw new Error(`Unknown policy '${policy}' for section ${section.name}`);
      }
    }

    // After all section restores, validate the active template ref.
    // If a template was set as active in config but doesn't exist
    // (e.g. user picked SKIP for templates), pick the first available.
    try {
      const tplCount = db.prepare(`SELECT COUNT(*) AS n FROM viewer_page_templates`).get().n;
      if (tplCount > 0) {
        const activeRow = db.prepare(`SELECT id FROM viewer_page_templates WHERE is_active = 1 LIMIT 1`).get();
        if (!activeRow) {
          // Nothing active — set the first template active
          db.prepare(`UPDATE viewer_page_templates SET is_active = 1 WHERE id = (SELECT id FROM viewer_page_templates ORDER BY id LIMIT 1)`).run();
        }
      }
    } catch (_) { /* defensive */ }
  });

  // Run the transaction. Any throw rolls everything back.
  tx();

  // After the DB transaction commits, handle the file-based parts.
  // (Outside the transaction because they're filesystem ops.)

  // 1. Cover art images
  if (backup.coverArt && policies.coverArt !== 'skip') {
    try {
      const dir = coverDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      for (const [filename, b64] of Object.entries(backup.coverArt)) {
        // Restrict to safe filenames — no path separators, no parents
        if (filename.indexOf('/') !== -1 || filename.indexOf('\\') !== -1 || filename.indexOf('..') !== -1) {
          console.warn(`[backup] skipping unsafe cover-art filename: ${filename}`);
          continue;
        }
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(path.join(dir, filename), buf);
        result.coverArtRestored++;
      }
      console.log(`[backup] restored ${result.coverArtRestored} cover-art files to ${dir}`);
    } catch (e) {
      console.warn('[backup] cover-art restore partial failure:', e.message);
    }
  }

  // 2. config.js (secrets only — surgical, not whole-file overwrite)
  //
  // Why surgical: the backup's config.js contains host-specific values
  // (port, dbPath, sessionCookieName, etc.) that should NOT be carried
  // over to the destination. The whole point of the secrets-restore is
  // to keep auth + plugin connectivity working post-migration:
  //   - jwtSecret → so admin sessions transfer
  //   - showToken → so the FPP plugin keeps working without re-pasting
  // Everything else in config.js is the destination's business.
  //
  // We parse the backup's config.js text to extract those two values,
  // then surgically replace just those keys in the destination's
  // config.js, preserving its port, dbPath, comments, formatting.
  //
  // Caveat: this assumes config.js follows the standard `key: 'value'`
  // format from config.example.js. Custom-formatted configs (multi-line
  // strings, dynamic values, etc.) may not match the regex; in that
  // case we leave the destination's config.js alone and warn.
  if (backup.configJs && policies.secrets === 'replace') {
    try {
      // Extract just the secrets we care about from the backup
      const extractedSecrets = extractSecretsFromConfigJs(backup.configJs);
      if (!extractedSecrets.jwtSecret && !extractedSecrets.showToken) {
        console.warn('[backup] backup config.js had no recognizable secrets — skipping secrets restore');
      } else if (!fs.existsSync(CONFIG_JS_PATH)) {
        // Destination has no config.js — write the backup's wholesale.
        // This path is mostly for first-boot restore where the container
        // has only config.example.js and no config.js yet. Whole-file
        // overwrite is safe here because there's no destination config
        // to preserve.
        fs.writeFileSync(CONFIG_JS_PATH, backup.configJs, 'utf8');
        result.secretsRestored = true;
        result.configJsRestored = true;
        result.requiresRestart = true;
        console.log('[backup] no destination config.js — wrote backup config verbatim (first-boot path)');
      } else {
        // Destination has its own config.js — merge surgically
        const destConfigJs = fs.readFileSync(CONFIG_JS_PATH, 'utf8');
        const merged = mergeSecretsIntoConfigJs(destConfigJs, extractedSecrets);
        if (merged === destConfigJs) {
          // Nothing to do — destination already had the same values,
          // or we couldn't find a place to splice them in. Warn either way.
          console.warn('[backup] could not merge secrets into destination config.js — secrets unchanged');
        } else {
          // Backup the current config.js before overwriting
          const backupPath = CONFIG_JS_PATH + '.bak.' + Date.now();
          fs.copyFileSync(CONFIG_JS_PATH, backupPath);
          console.log(`[backup] saved current config.js to ${backupPath}`);
          fs.writeFileSync(CONFIG_JS_PATH, merged, 'utf8');
          result.secretsRestored = true;
          result.configJsRestored = true;
          result.requiresRestart = true;
          console.log('[backup] config.js secrets merged — server restart required');
        }
      }
    } catch (e) {
      console.warn('[backup] secrets restore failed:', e.message);
    }
  }

  return result;
}

// ============================================================
// config.js secret extraction & surgical merge helpers
// ============================================================

// Extract jwtSecret and showToken values from a config.js source string.
// Returns { jwtSecret: string|null, showToken: string|null }.
//
// Matches keys formatted as: `jwtSecret: 'value'` or `jwtSecret: "value"`,
// with any leading whitespace and an optional trailing comma. This is the
// format produced by config.example.js and the documented setup; nothing
// fancier is supported.
function extractSecretsFromConfigJs(src) {
  const out = { jwtSecret: null, showToken: null };
  // Captures the value between matching quotes — backreference \2 ensures
  // we don't accidentally splice across single→double quote boundaries.
  const jwtMatch = src.match(/jwtSecret\s*:\s*(['"])((?:(?!\1).)*)\1/);
  if (jwtMatch) out.jwtSecret = jwtMatch[2];
  const tokenMatch = src.match(/showToken\s*:\s*(['"])((?:(?!\1).)*)\1/);
  if (tokenMatch) out.showToken = tokenMatch[2];
  return out;
}

// Splice secrets into a config.js source string, preserving everything
// else (port, dbPath, comments, formatting). Returns the modified source,
// or the original unchanged if nothing could be merged.
function mergeSecretsIntoConfigJs(destSrc, secrets) {
  let out = destSrc;
  if (secrets.jwtSecret) {
    out = replaceConfigValue(out, 'jwtSecret', secrets.jwtSecret);
  }
  if (secrets.showToken) {
    out = replaceConfigValue(out, 'showToken', secrets.showToken);
  }
  return out;
}

// Replace `key: '...'` in a config.js source string with a new value.
// Preserves the original quote style (single vs double). If the key isn't
// found in the destination, returns the source unchanged — we don't try
// to insert new keys, only overwrite existing ones.
function replaceConfigValue(src, key, newValue) {
  // Escape any character in newValue that would break a JS string literal.
  // We always emit single quotes, so we only need to escape backslashes
  // and single quotes (and newlines, though secrets shouldn't have those).
  const escaped = String(newValue)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  const re = new RegExp(`(${key}\\s*:\\s*)(['"])((?:(?!\\2).)*)\\2`, 'g');
  let replaced = false;
  const result = src.replace(re, (_, prefix) => {
    replaced = true;
    return `${prefix}'${escaped}'`;
  });
  return replaced ? result : src;
}

// ============================================================
// First-boot detection
// ============================================================

// Returns true iff this server is in its initial state — exactly one
// user named 'admin' with must_change_password set. Used by the login
// view to decide whether to offer the "Restore from backup" option.
//
// Why this signal: brand-new installs always seed admin/admin with
// must_change_password=1 (see lib/db.js seed block). Once the admin
// has changed their password, they're no longer "fresh" and shouldn't
// see the restore-from-backup option on the login page. They can
// still restore from inside the admin app.
function isFirstBoot() {
  try {
    const db = getDb();
    const users = db.prepare(`SELECT username, must_change_password FROM users`).all();
    if (users.length !== 1) return false;
    if (users[0].username !== 'admin') return false;
    if (users[0].must_change_password !== 1) return false;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  buildBackup,
  inspectBackup,
  restoreBackup,
  isFirstBoot,
  BACKUP_FORMAT_VERSION,
  SECTIONS,
};
