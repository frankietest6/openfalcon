# ShowPilot — Agent Instructions

This file gives AI agents the context and rules they need to work safely and idiomatically in this repository. Read it alongside `CLAUDE.md` (infrastructure) and `PRIMER.md` (architecture decisions) before making any changes.

---

## What ShowPilot Is

ShowPilot is a **self-hosted Node.js server** that lets holiday light show visitors vote on songs, queue jukebox requests, and stream synchronized audio to their phones — all without depending on Remote Falcon or any external cloud service. It communicates with Falcon Player (FPP) via a companion plugin that runs on the FPP Raspberry Pi.

The operator (Will) runs the show as "Lights On Drake" at `lightsondrake.org`. He is a non-coder who runs commands and tests but does not write code himself.

---

## Navigation Guide

| What you're looking for | Where to find it |
|---|---|
| Server startup, middleware order, route mounting | `server.js` |
| Admin API endpoints (auth, CRUD, config) | `routes/admin.js` + `requireAdmin` middleware defined there |
| FPP plugin integration endpoints | `routes/plugin.js` |
| Public viewer endpoints (vote, jukebox, audio) | `routes/viewer.js` |
| Backup / restore HTTP handlers | `routes/backup.js` |
| Database schema, migrations, all getters/setters | `lib/db.js` |
| Config loading + secret generation | `lib/config-loader.js` |
| Audio file caching + ffmpeg transcoding | `lib/audio-cache.js` |
| FPP WebSocket → Socket.io position relay | `lib/audio-position-relay.js` |
| Viewer page HTML template rendering | `lib/viewer-renderer.js` |
| In-app update mechanism | `lib/updater.js` |
| Cloudflare Tunnel child-process supervisor | `lib/cloudflared.js` |
| Entire admin SPA (single file, no build) | `public/admin/index.html` |
| Viewer-side audio engine + sync logic | `public/rf-compat.js` |
| All configuration options with docs | `config.example.js` |
| Architecture decisions + audio sync deep-dive | `PRIMER.md` |
| Infrastructure overview | `CLAUDE.md` |

---

## Rules for Making Changes

### Language and Module Style

- **CommonJS only.** Use `require()` and `module.exports`. Do not introduce ES module syntax (`import`/`export`).
- Match the existing file's indentation and quote style. The codebase uses 2-space indentation and single quotes throughout.
- Write inline `// comments` that explain *why*, not *what*. The existing codebase has extensive why-comments; add yours in the same style.

### Commits

Every commit must:
1. Bump `version` in `package.json` (patch increment unless it's a larger change)
2. Use this exact commit message format: `vX.Y.Z — short description`

```
v0.33.142 — fix jukebox depth check off-by-one
```

Never commit with a different format. The version in `package.json` is the single source of truth; the health endpoint (`/health`) reads it directly.

### Files That Must Never Be Committed

These are in `.gitignore` — do not stage them:
- `config.js` (host-specific secrets and settings)
- `data/` (database, audio cache, cover art)
- `node_modules/`
- `*.tar.gz`

### Testing

There is no test framework. Verify changes by:
1. Running `npm dev` and testing the feature in a browser
2. For risky changes (DB migrations, backup/restore, auth): test on the Docker container first (`docker run -p 3101:3100 ...`), then prod
3. Always test both the happy path and the safeguard cases (e.g., jukebox depth limit, duplicate vote rejection)

### No Linting Tools

There is no ESLint, Prettier, or pre-commit hook. Match the style of surrounding code manually.

---

## Database Rules

1. **Synchronous only.** `better-sqlite3` is synchronous by design. All DB calls are blocking. Never introduce async DB patterns.

2. **Migrations go in `lib/db.js`.** New columns are added via the migration block near the top of `db.js`. The pattern is:
   ```js
   // Add new column if it doesn't exist
   try { db.exec(`ALTER TABLE foo ADD COLUMN bar TEXT DEFAULT NULL`); } catch {}
   ```

3. **Never drop or rename existing columns.** SQLite ALTER TABLE has limited support; more importantly, existing deployments have live data. Add columns; don't remove them.

4. **WAL mode and foreign keys are enabled** at startup in `lib/db.js`. Do not disable them.

5. **Use prepared statements.** All queries use `db.prepare(...).get/all/run(...)`. Never string-interpolate user input into SQL.

---

## Authentication Rules

| Route prefix | Auth mechanism | Middleware |
|---|---|---|
| `/api/admin/*` | JWT in `httpOnly` cookie | `requireAdmin` (defined in `routes/admin.js`) |
| `/api/plugin/*` | Bearer token in `Authorization` header | Inline check in `routes/plugin.js` |
| `/api/*` (viewer) | None — public | — |
| `/api/public/*` | None — public | — |

- **Admin routes** must use `requireAdmin`. Do not create admin-only endpoints outside this middleware.
- **Plugin routes** check `Authorization: Bearer <showToken>`. The show token comes from `config.showToken` (auto-generated if null).
- **Viewer routes** are intentionally public. Safeguards (rate limits, per-viewer caps) are applied in the route logic, not at the auth layer.
- JWT is issued at login as an `httpOnly` cookie. Session duration is configurable (`sessionDurationHours` in config). The `secure` flag is set automatically when HTTPS is detected.
- Login is rate-limited to 8 attempts per 15 minutes per IP (`express-rate-limit` in `routes/admin.js`).

---

## Frontend Rules

### Admin SPA (`public/admin/index.html`)

- This is a **single file** (~400 KB). Do not split it into separate JS/CSS files.
- There is no build step — edits are live immediately.
- The file is served as a static asset; the SPA fallback in `server.js` routes all `/admin/*` paths to it.

### Viewer Frontend (`public/rf-compat.js`, `public/viewer.js`)

- `rf-compat.js` is the Remote Falcon compatibility layer and viewer audio engine. It is large (~230 KB) and critical.
- Do not split, rename, or restructure `rf-compat.js`. FPP operators reference it by filename.
- The viewer page is rendered server-side from a user-authored HTML template by `lib/viewer-renderer.js`. The template may load external fonts, images, and inline styles. This is why `contentSecurityPolicy` is disabled in `server.js`.

### Template Placeholder Compatibility

Viewer templates use Remote Falcon–style placeholders. These must be preserved exactly:

```
{NOW_PLAYING}          {NEXT_PLAYLIST_ITEM}    {VOTE_COUNT_TOTAL}
{JUKEBOX_QUEUE}        {PLAYLIST_VOTE_COUNTER} {VOTE_WINNER}
```

Container attributes used by `rf-compat.js` for dynamic updates (e.g. `data-showpilot-playlist`) must not be renamed.

---

## Audio Sync — Caution Zone

The audio sync system is the most complex part of ShowPilot. It went through many iterations (see `PRIMER.md` version history). Before modifying anything in `rf-compat.js` related to audio playback:

1. **Read the audio sync section of `PRIMER.md` in full.**
2. Understand the signal chain: FPP FIFO → `showpilot_audio.js` daemon → `audio-position-relay.js` → Socket.io → `rf-compat.js` → Web Audio API.

### Invariants that must not be broken

| Invariant | Why |
|---|---|
| Use `AudioBufferSourceNode`, never `<audio>` | HTML5 audio seeking causes decoder restarts with audible artifacts |
| Do not use `fppPositionNow` as the drift reference after a snap | Uses `clockOffset` (per-device); different devices correct to different positions |
| Drift measurement uses `snapAnchorCtxTime`/`snapAnchorPosSec` | Audio-clock-relative, device-clock-independent |
| `window._pendingSyncPointResolvers` is a Map keyed by `mediaName` | Rapid song changes would clobber each other if collapsed to a single global |
| Crossfade corrections only fire with fresh fppStatus (< 200ms stale) | Stale extrapolation causes overcorrection |
| Do not use playbackRate for sync | Causes audible pitch changes; crossfade is the correct mechanism |

---

## Middleware Order Invariants

These ordering rules in `server.js` are load-bearing. Do not reorder them:

1. `app.use(cookieParser())` — must be before any route using `requireAdmin`
2. `app.use('/api/admin/backup', ...)` — must be before `app.use(express.json({ limit: '1mb' }))` — backup files can be 5–50 MB; the backup router has its own 100 MB parser
3. Admin router before viewer router — to avoid `/api/admin` prefix collisions with `/api`

---

## Deployment Awareness

- **Docker images are multi-arch** (amd64 + arm64). If you change native-compiled dependencies (`bcrypt`, `better-sqlite3`), verify the Dockerfile builder stage still works on both architectures.
- **systemd `Restart=always` is required** — the in-app updater calls `process.exit(0)` on success. `Restart=on-failure` would leave the service stopped. Never change this in documented service files.
- **PM2 is used on prod LXC.** The process name is `showpilot`. Restart with `pm2 restart showpilot`.
- **ffmpeg must be installed** for audio transcoding (`apt-get install -y ffmpeg`). `deploy.sh` handles this for native installs.

---

## Security Rules

- **Never log `jwtSecret`, `showToken`, passwords, or session cookies.** These appear in `config` and request headers — be careful with debug logging.
- **`httpOnly` cookie handling is correct as-is.** Do not change cookie flags or expose the JWT to JavaScript.
- **Never use string interpolation in SQL.** All queries must use prepared statements.
- **Do not disable Helmet.** `contentSecurityPolicy` and `crossOriginEmbedderPolicy` are intentionally disabled (user templates need external assets); all other Helmet defaults remain active.
- **Input validation at the boundary.** Validate user input in route handlers. Trust internal module calls.

---

## Packaging and Shipping

When packaging a release tarball for Will to extract over his dev clone:

```bash
tar --exclude='showpilot/.git' \
    --exclude='showpilot/node_modules' \
    --exclude='showpilot/config.js' \
    --exclude='showpilot/data' \
    --exclude='showpilot/*.tar.gz' \
    -czf /mnt/user-data/outputs/showpilot-vX.Y.Z.tar.gz showpilot/
```

**Never exclude `.github/`** — the GitHub Actions workflow must be in the tarball.

Always syntax-check before packaging:
```bash
node --check server.js && echo "OK"
```
