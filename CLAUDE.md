# ShowPilot — Claude Code Reference

Self-hosted Node.js companion server for Falcon Player (FPP) light shows. Visitors vote on songs, queue jukebox requests, and stream synchronized audio to their phones. Operators manage everything through a web admin dashboard.

**Current version:** see `package.json` → `version`
**GitHub:** github.com/ShowPilotFPP/ShowPilot

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18.0.0 (20.x or 22.x LTS recommended) |
| Web framework | Express 4.21 |
| Real-time | Socket.io 4.8 (WebSocket primary, polling fallback) |
| Database | SQLite via better-sqlite3 11.3 (synchronous, no server) |
| Auth | bcrypt 5.1 (passwords) + jsonwebtoken 9.0 (JWT session cookies) |
| Security headers | helmet 8.0 |
| Rate limiting | express-rate-limit 7.4 |
| Frontend | Vanilla JS — no framework, no build step |

---

## Directory Layout

```
ShowPilot/
├── server.js               Main entry point: Express setup, Socket.io, route mounting, boot
├── package.json            Version source of truth; scripts: start, dev
├── config.js               Host-specific config (copy from config.example.js — gitignored)
├── config.example.js       Template with all options documented
├── lib/
│   ├── db.js               SQLite schema + migrations + all getters/setters (~59 KB)
│   ├── config-loader.js    Loads config.js; auto-generates secrets if null
│   ├── viewer-renderer.js  Server-side HTML template rendering (~55 KB)
│   ├── audio-cache.js      SHA-256 content-addressed audio file cache; ffmpeg transcoding
│   ├── audio-position-relay.js  FPP WebSocket → Socket.io position fan-out
│   ├── backup.js           Full backup/restore (data/ dir + cover art, 100 MB limit)
│   ├── updater.js          In-app update mechanism; polls GitHub, downloads, installs
│   ├── cloudflared.js      Manages Cloudflare Tunnel as a child process
│   ├── cover-art.js        iTunes/MusicBrainz cover art lookup
│   ├── visit-tracking.js   Anonymous visitor analytics (cookie + IP/UA hash fallback)
│   ├── process-supervisor.js  Detects PM2/systemd/NSSM/Docker for restart commands
│   ├── secret-store.js     Persists auto-generated JWT secret + show token
│   ├── metadata-scraper.js Auto-fill song title/artist from online sources
│   └── visual-designer.js  Viewer page editor state helpers
├── routes/
│   ├── admin.js            /api/admin/* — JWT auth + all admin CRUD (~70 KB)
│   ├── plugin.js           /api/plugin/* — FPP plugin endpoints (~47 KB)
│   ├── viewer.js           /api/* — public voting, jukebox, audio stream (~51 KB)
│   ├── backup.js           Backup/restore HTTP handlers (100 MB body limit)
│   ├── cloudflared.js      Cloudflare Tunnel management routes
│   ├── public.js           /api/public/* — demo status
│   └── updates.js          /api/admin/updates/* — version check, install, rollback
├── public/
│   ├── admin/index.html    Entire admin SPA (~400 KB, vanilla JS, single file)
│   ├── rf-compat.js        Viewer-side engine: audio, sync, vote/request UI (~230 KB)
│   ├── viewer.html         Default viewer page template (fallback)
│   ├── viewer.css          Viewer page base styles
│   ├── viewer.js           Viewer Socket.io + polling logic
│   ├── viewer-templates/   Pre-built operator templates
│   ├── favicons/           SVG monogram + browser icons
│   └── vendor/             Bundled third-party libraries
└── data/                   Runtime data (gitignored)
    ├── showpilot.db        SQLite database
    ├── secrets.json        Auto-generated JWT secret + show token
    ├── covers/             Sequence cover art (JPG, named by sequence ID)
    └── audio-cache/        Transcoded audio files (.bin, .m4a)
```

---

## Development Commands

```bash
npm dev       # node --watch server.js — auto-reloads on file changes
npm start     # node server.js — production
```

Default URL: `http://localhost:3100/`  
Admin: `http://localhost:3100/admin/`  
Health: `http://localhost:3100/health` (returns `{ ok: true, version: "..." }`)

---

## Configuration

Config lives in `config.js` at the repo root. Copy `config.example.js` to create it.

**`config.js` is gitignored.** Never commit it.

Key settings:
- `port` — default 3100
- `host` — default `0.0.0.0`
- `trustProxy` — set to `1` if behind a reverse proxy (Nginx, Caddy, Cloudflare Tunnel); default `false`
- `dbPath` — default `./data/showpilot.db`
- `jwtSecret` / `showToken` — set to `null` to auto-generate on first run (recommended); or set via `SHOWPILOT_JWT_SECRET` / `SHOWPILOT_SHOW_TOKEN` env vars (Docker)
- `logLevel` — `'debug'` | `'info'` | `'warn'` | `'error'`

Auto-generated secrets are persisted to `data/secrets.json`. To rotate them, delete that file and restart.

---

## Database

**Driver:** `better-sqlite3` — fully synchronous. No async/await for DB calls.  
**Location:** `data/showpilot.db` (auto-created on first run)  
**Mode:** WAL (Write-Ahead Logging), foreign keys enabled  
**Schema:** Defined in `lib/db.js`; schema auto-created and migrations applied on startup

Key tables: `config`, `sequences`, `viewer_page_templates`, `users`, `now_playing`, `jukebox_queue`, `votes`, `tiebreak_votes`, `active_viewers`, `play_history`, `viewer_visits`, `schedule`, `audio_cache_files`, `update_state`

Add new columns via the migrations table in `lib/db.js`. Never drop or destructively alter existing columns.

---

## Testing & Linting

**No test framework.** No `test/` directory, no Jest/Mocha/Vitest.  
**No linter.** No ESLint, Prettier, or formatting config.

Verify changes manually:
1. `npm dev` to start with auto-reload
2. Browser-test the changed feature at `http://localhost:3100`
3. Risky changes: test on Docker first (`docker run -p 3101:3100 ...`), then prod

---

## Commit Convention

Every commit must:
1. Bump `version` in `package.json`
2. Use this exact format: `vX.Y.Z — short description`

Examples from git log:
```
v0.33.141 — log slow requests (> 2s) regardless of log level
v0.33.140 — fix README systemd guide: Restart=on-failure → Restart=always
v0.33.138 — admin version loaded from /health; no more dual-file version bumps
```

---

## Code Style

- **CommonJS only** — `require()` / `module.exports`. No ES module imports.
- **Inline WHY comments** — explain non-obvious decisions, security choices, and quirks. Do not comment what; do comment why.
- **No build step** — frontend is served as-is from `public/`. The admin SPA is a single HTML file.
- **Synchronous DB** — `better-sqlite3` is sync; all DB calls block. This is intentional.
- **Middleware order matters** — see `server.js` for the invariant: backup router before global `express.json()`, `cookieParser()` before any `requireAdmin` call.

---

## Critical Architecture Invariants

These must not be changed without understanding the full context in `PRIMER.md`:

1. **Audio sync** — Uses Web Audio API + `AudioBufferSourceNode`, NOT `<audio>`. `rf-compat.js` implements snap-to-syncPoint + crossfade correction. Do not revert to HTML5 audio. Do not modify `snapPoints`, `snapAnchorCtxTime`/`snapAnchorPosSec`, or PLL logic without reading the audio sync section of `PRIMER.md` first.

2. **Backup router mount** — `routes/backup.js` is mounted BEFORE `app.use(express.json(...))` in `server.js`. Do not reorder. Backup files can be 5–50 MB; the backup router has its own 100 MB parser.

3. **cookieParser order** — `app.use(cookieParser())` must run before any route that calls `requireAdmin`. It is currently at the top of `server.js`.

4. **Systemd `Restart=always`** — The in-app updater calls `process.exit(0)` after installing an update. `Restart=on-failure` would leave ShowPilot stopped after a successful update. Always use `Restart=always` in systemd units.

5. **Per-filename syncPoint resolver map** — `window._pendingSyncPointResolvers` in `rf-compat.js` is a `Map` keyed by `mediaName`. Do not collapse it back to a single global; rapid song changes will clobber each other's resolvers.

6. **Secrets restore is surgical** — `lib/backup.js` extracts only `jwtSecret` and `showToken` from a backup's `config.js` via regex. Whole-file replacement would bake in the wrong port/dbPath.

---

## Deployment Quick Reference

| Method | Command |
|---|---|
| Dev (local) | `npm dev` |
| Prod (PM2) | `pm2 start server.js --name showpilot` |
| Prod (systemd) | See README for unit file |
| Docker | `docker run -p 3100:3100 -v $(pwd)/data:/app/data ghcr.io/showpilotfpp/showpilot:latest` |

Docker images are multi-arch (amd64 + arm64). Native deps (`bcrypt`, `better-sqlite3`) are compiled in the builder stage.

See `PRIMER.md` for full deployment topology including prod LXC, Docker test, and FPP plugin environments.
