# ShowPilot — Architecture

This document describes how ShowPilot is built and how its components fit together. It is intended for developers and technically curious operators who want to understand the system beyond the surface level.

For feature documentation, see `README.md`. For deployment instructions, see `DEPLOY.md`. For in-depth architecture decisions and audio sync internals, see `PRIMER.md`.

---

## What ShowPilot Does

ShowPilot is a self-hosted web server that adds an interactive layer on top of Falcon Player (FPP), the open-source software that runs holiday light shows. When deployed:

- **Visitors** open a browser on their phones and see a styled page showing what's playing. They can vote for the next song, queue a jukebox request, or tap "Listen on Phone" to stream the show audio through their phone speaker — in sync with the venue speakers.
- **The operator** manages everything through a web admin dashboard: configuring the show, editing the viewer page, monitoring queue and vote activity, and reviewing visit statistics.
- **Falcon Player** communicates with ShowPilot through a companion plugin that reports what's playing, pushes audio files, and receives back the voted-for or next-queued sequence to play.

ShowPilot has no external cloud dependencies. The database, audio files, and all state live on the machine running ShowPilot.

---

## System Overview

```
 ┌────────────────────────────────────────────────────────────────────┐
 │                         Visitor Phones                             │
 │        Browser → viewer page (/, rf-compat.js, viewer.js)         │
 └───────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS (vote, jukebox, audio stream, Socket.io)
 ┌───────────────────────────▼────────────────────────────────────────┐
 │                      ShowPilot Server                               │
 │                   (Node.js / Express / Socket.io)                   │
 │                                                                     │
 │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
 │  │  /api/viewer │  │  /api/admin  │  │       /api/plugin        │  │
 │  │  Public API  │  │   Admin API  │  │       Plugin API         │  │
 │  │  (no auth)   │  │  (JWT auth)  │  │    (Bearer token auth)   │  │
 │  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
 │         │                 │                        │                │
 │  ┌──────▼─────────────────▼────────────────────────▼─────────────┐  │
 │  │                   Core Services                                │  │
 │  │  SQLite DB · Audio Cache · Viewer Renderer · Updater          │  │
 │  │  Cover Art · Visit Tracking · Cloudflare Tunnel               │  │
 │  └───────────────────────────────────────────────────────────────┘  │
 │                              │                                      │
 │             Audio Position Relay (lib/audio-position-relay.js)      │
 └─────────────────────────────┬──────────────────────────────────────┘
                               │ WebSocket (ws://<fpp-host>:8090)
 ┌─────────────────────────────▼──────────────────────────────────────┐
 │                     Falcon Player (FPP Pi)                          │
 │         showpilot_audio.js daemon (port 8090)                       │
 │         ShowPilot-plugin HTTP API                                   │
 │         FPP hardware output → physical venue speakers               │
 └────────────────────────────────────────────────────────────────────┘

 ┌────────────────────────────────────────────────────────────────────┐
 │                         Admin Browser                              │
 │        /admin/ → public/admin/index.html (SPA, no build)          │
 └────────────────────────────────────────────────────────────────────┘
```

---

## Component Descriptions

### Entry Point: `server.js`

`server.js` is the single startup file. It:

1. Creates the Express app and HTTP server
2. Attaches Socket.io with WebSocket-preferred transport (5 s ping interval, 10 s timeout — tuned for low-latency position updates)
3. Sets up the middleware stack in a specific order that must not change (see below)
4. Mounts all route handlers
5. Registers PWA manifest + service worker endpoints
6. Serves static files (`public/`, `data/covers/`, `public/admin/`)
7. On boot: starts `audio-position-relay`, auto-starts Cloudflare Tunnel if configured, starts background release polling

**Middleware order (load-bearing):**

```
helmet()                         — security headers
CORS middleware                  — allow FPP plugin UI cross-origin
cookieParser()                   — must precede any requireAdmin usage
/api/admin/backup router         — own 100 MB body parser, before global limit
express.json({ limit: '1mb' })   — global body limit for all other endpoints
request logger
```

---

### Plugin API: `routes/plugin.js`

This is how FPP talks to ShowPilot. The companion plugin (`ShowPilot-plugin`, a separate repo) runs inside FPP and makes HTTP calls to these endpoints. All requests carry `Authorization: Bearer <showToken>`.

Key endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/plugin/playing` | POST | FPP reports a track change (now playing + elapsed time); ShowPilot broadcasts state to viewers |
| `POST /api/plugin/position` | POST | FPP reports live playback position (~500 ms intervals); relayed to viewers via Socket.io |
| `POST /api/plugin/next` | POST | FPP reports what's scheduled next |
| `GET /api/plugin/state` | GET | Plugin polls for vote leader, queue head, control mode, safeguards — one call for everything |
| `POST /api/plugin/sync-sequences` | POST | Plugin uploads full sequence list + audio file SHA-256 hashes |
| `POST /api/plugin/heartbeat` | POST | Keepalive; carries plugin version and connection state |
| `GET /api/plugin/audio-cache/*` | GET/POST | Audio cache manifest, file upload, link, prune |

The plugin is the only component that knows what FPP is playing. ShowPilot stores it in the `now_playing` table and broadcasts it outward.

---

### Viewer API: `routes/viewer.js`

The public API that visitor browsers call. No authentication.

Key endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Current mode, now-playing, vote counts, queue, next up |
| `POST /api/vote` | Cast a vote; enforces per-viewer limits, round reset, blocking current/next |
| `POST /api/jukebox/add` | Queue a request; enforces depth, per-viewer cap, blocking current/next |
| `POST /api/heartbeat` | Viewer keepalive (updates `active_viewers` table) |
| `GET /api/visual-config` | Theme colors, fonts, show hours, GPS coordinates, FM frequency |
| `GET /api/now-playing-audio` | Redirects to the correct audio endpoint (cache or FPP proxy) |
| `GET /api/audio-stream/:sequence` | Streams cached .m4a audio file |

Viewer identity is anonymous: a UUID stored in an `httpOnly` cookie (`of_vid`), with an IP + User-Agent hash as fallback if cookies are blocked.

---

### Admin API: `routes/admin.js`

Everything the operator controls. All routes require a valid JWT session cookie, verified by the `requireAdmin` middleware defined at the top of this file.

Functional areas:
- **Auth:** login (bcrypt verify → JWT cookie), logout, current user, change password
- **Users:** list, create, delete, force password reset; self-protection (can't delete self or last user)
- **Config:** show name, control mode (voting / jukebox / manual), all safeguards, GPS, PSA, IP blocks, theme, PWA
- **Sequences:** list, reorder, rename, set votable/jukeboxable, hide, per-sequence cooldown timer
- **Stats:** vote counts, play history, active viewers, unique visitors
- **Templates:** CRUD viewer page templates; lock/unlock; toggle active
- **Audio cache:** stats, file list, clear, prune unused
- **Plugin status:** last heartbeat, plugin version, connection health
- **Backup:** download (tar.gz of `data/`), restore from file (100 MB limit)
- **Cloudflare Tunnel:** configure + start/stop the tunnel child process
- **Updates:** check for new releases, install, rollback

Login is rate-limited to 8 attempts per 15 minutes per IP.

---

### Database: `lib/db.js`

ShowPilot uses SQLite via `better-sqlite3`, which is fully synchronous. There is no connection pool; a single database connection is opened at startup and shared across all requests.

The schema is defined and auto-applied at startup. New columns are added via incremental `ALTER TABLE` migrations (wrapped in `try/catch` because SQLite errors if the column already exists).

**Tables grouped by concern:**

| Group | Tables |
|---|---|
| Show state | `config`, `now_playing`, `schedule` |
| Sequences | `sequences`, `sequence_snapshots` |
| Interaction | `votes`, `tiebreak_votes`, `jukebox_queue` |
| Viewers | `active_viewers`, `viewer_visits` |
| Content | `viewer_page_templates`, `audio_cache_files` |
| Users | `users` |
| History | `play_history` |
| System | `update_state` |

`config` is a key-value table that stores all show settings. Access it via `getConfig()` (returns an object) and `setConfig(key, value)` (updates one key).

---

### Audio Cache: `lib/audio-cache.js`

ShowPilot caches the FPP audio files locally rather than proxying every stream through the FPP Pi. This solves three problems:

1. The FPP Pi's SD card is a bottleneck for concurrent audio streams
2. Proxied streams have 500–1500 ms first-byte latency; cached files serve in 50–100 ms
3. Audio continues streaming even if FPP is momentarily unreachable

**How it works:**

- When the plugin syncs sequences, it uploads audio files (or provides a SHA-256 hash for ShowPilot to fetch)
- Files are stored as `data/audio-cache/<sha256>.bin`
- On startup, ShowPilot transcodes all `.bin` files to AAC/M4A using ffmpeg:
  ```
  ffmpeg -y -f <detected_format> -i input.bin -vn -c:a aac -b:a 192k -movflags +faststart output.m4a
  ```
- `-movflags +faststart` puts the MP4 header at the front of the file for low-latency streaming
- The `audio_cache_files` table maps SHA-256 hashes to sequence media names

When a viewer requests audio, `routes/viewer.js` checks the cache first and falls back to proxying through FPP if the file isn't cached yet.

---

### Audio Position Relay: `lib/audio-position-relay.js`

This is what makes phone audio sync with the venue speakers.

A separate daemon (`showpilot_audio.js`) runs on the FPP Pi alongside FPP. It listens on a Unix FIFO for FPP's `MediaSyncPacket` events and broadcasts the current playback position over a WebSocket on port 8090.

`audio-position-relay.js` connects to that WebSocket and translates the messages into Socket.io events that all connected viewer browsers receive:

- `fppPosition` — current playback position (seconds), emitted ~every 500 ms
- `fppSyncPoint` — a high-accuracy position snapshot, emitted ~every second after the first ~2 s of a song

Browsers use these events to keep their `AudioBufferSourceNode` in sync with FPP. On reconnect (e.g., FPP restart), the relay reconnects within 500 ms.

---

### Viewer Renderer: `lib/viewer-renderer.js`

The viewer page at `/` is rendered server-side from an HTML template stored in the `viewer_page_templates` table. The operator authors the template in the admin visual designer (or imports one from Remote Falcon).

The renderer substitutes placeholders in the template HTML:

```
{NOW_PLAYING}            → current sequence display name
{NEXT_PLAYLIST_ITEM}     → next up display name
{JUKEBOX_QUEUE}          → rendered queue list HTML
{VOTE_COUNT_TOTAL}       → total votes this round
```

"Next up" is resolved by `getNextUp()` in `lib/db.js` using a four-tier priority:
1. **JUKEBOX mode** — first unplayed entry in the jukebox queue
2. **VOTING mode with votes cast** — highest-voted sequence in the current round
3. **FPP-reported next** — `now_playing.next_sequence_name`, set in real time by `POST /api/plugin/next` as FPP transitions between songs
4. **Sort-order fallback** — next visible non-PSA sequence by `sort_order` (FPP playlist index from last sync), used only when the plugin hasn't reported yet

Container elements with special `data-showpilot-*` attributes are populated by `rf-compat.js` at runtime. The renderer injects the initial values for fast first render; JavaScript takes over after page load.

Template editing has three modes in the admin:
- **Settings mode** — form-based controls for common options (show name, hours, theme colors)
- **Blocks mode** — drag-and-drop component placement
- **Code mode** — Monaco editor for full HTML/CSS control

---

### Admin SPA: `public/admin/index.html`

The admin dashboard is a single self-contained HTML file (~400 KB). It uses vanilla JavaScript with no framework and no build step. Edits take effect immediately when the file is saved.

The SPA is served as a static file and accessed at `/admin/`. The SPA fallback in `server.js` routes all `/admin/*` paths to this file for client-side routing.

---

### Viewer Frontend: `public/rf-compat.js`

`rf-compat.js` is the viewer page's JavaScript engine (~230 KB). It handles:

- **Audio playback** — decodes audio files via the Web Audio API (`AudioContext` + `AudioBufferSourceNode`) rather than HTML5 `<audio>`. This is a permanent architectural choice: HTML5 audio seeking causes decoder restarts with audible glitches in PCM-decoded streams.
- **Audio sync** — implements the snap-to-syncPoint + crossfade correction algorithm (see [Audio Sync](#audio-sync) below)
- **Real-time updates** — Socket.io connection for live state, viewer count, and position updates; HTTP polling fallback
- **Vote and jukebox UI** — button handlers, debouncing, optimistic UI updates
- **Remote Falcon compatibility** — supports the same placeholder and container-attribute conventions as Remote Falcon so operators can import existing templates

The `rf-` prefix is a historical artifact from the Remote Falcon compatibility layer; the file now does much more than compatibility.

---

## Audio Sync

Audio sync is the most technically sophisticated part of ShowPilot. The goal: every visitor's phone plays the same position of the same song at the same wall-clock moment, matching the physical venue speakers.

### Signal Chain

```
FPP plays audio → FIFO → showpilot_audio.js (FPP Pi, port 8090)
                              │ WebSocket
                         audio-position-relay.js (ShowPilot server)
                              │ Socket.io (fppPosition, fppSyncPoint events)
                         rf-compat.js (visitor browser)
                              │ Web Audio API
                         Phone speaker
```

### Startup Sync Sequence (per song change)

When FPP starts a new song, every connected phone goes through this sequence:

1. **Fast-start** — audio begins playing immediately from the current reported position. Phones may be slightly out of sync at this point, but audio starts within ~200 ms of the song change.

2. **SyncPoint snap (~2 s)** — the audio daemon suppresses sync point events for ~1 s after a song change, then emits the first high-accuracy position. When `rf-compat.js` receives this, it stops the fast-start audio and starts a new `AudioBufferSourceNode` anchored to the sync point's exact position. All phones receive the same sync point and snap to the same position simultaneously.

3. **Follow-up crossfade (500 ms after snap)** — a 50 ms crossfade correction using a fresh position reading catches any residual jitter from the snap's scheduling.

4. **Ongoing crossfade correction** — periodic drift check (50 ms threshold, 10 s cooldown). Uses the snap anchor as the reference rather than the FPP-reported position, which eliminates the effect of OS clock differences between devices.

5. **Speaker calibration** — 5 position samples are collected starting 3 s after the follow-up crossfade. The median offset between audio position and FPP position is stored as `sp_device_offset` in `localStorage` and applied at the next song's snap, automatically compensating for the acoustic delay between the venue speakers and the listener.

### Why Web Audio API

HTML5 `<audio>` seeking causes the browser's decoder to restart, which produces audible artifacts. Web Audio API decodes the entire file to PCM first, then schedules playback with sample-accurate timing. This is the only correct approach for a synchronized multi-device audio stream.

### Debug Overlay

Add `?debug=1` to the viewer URL to display a live sync status overlay showing `drift`, `fppPos`, `audioPos`, `clockOffset`, `seekedTo`, and `deviceOff`. After a snap, `drift` should read near 0 ms on all devices regardless of OS clock differences between them.

---

## Authentication Model

ShowPilot has three independent authentication domains:

### Admin Sessions

Visitors who log into `/admin/` receive a JWT signed with `jwtSecret` and stored in an `httpOnly` cookie (`showpilot_session`). The cookie has the `secure` flag set automatically when HTTPS is detected. Default session duration is 30 days. All admin API calls verify the JWT via the `requireAdmin` middleware.

### FPP Plugin

The FPP plugin authenticates with a shared secret (`showToken`), sent as `Authorization: Bearer <token>` on every API call. The token is auto-generated on first run and displayed in the admin under Plugin Settings. If the token is rotated, the plugin must be reconfigured.

### Viewer Anonymity

Viewer pages are fully public — no login. Each visitor is tracked anonymously by a UUID stored in an `httpOnly` cookie (`of_vid`), with an IP + User-Agent hash as fallback if cookies are unavailable. This identity is used to enforce per-viewer safeguards (one vote per round, jukebox request limits) without requiring any account or login.

---

## Deployment Topology

### Native (Linux)

ShowPilot runs as a systemd service or PM2 process. The default path is `/opt/showpilot/`. System-level `ffmpeg` must be installed separately (`apt-get install -y ffmpeg`).

`systemd` unit must use `Restart=always` (not `Restart=on-failure`) because the in-app updater calls `process.exit(0)` after a successful install — a clean exit that `on-failure` would not restart.

### Docker

Multi-arch images (amd64 + arm64) are published to `ghcr.io/showpilotfpp/showpilot:latest` on every tagged release. The Dockerfile uses a two-stage build: a builder stage compiles native dependencies (`bcrypt`, `better-sqlite3`) with the necessary build tools; the runtime stage is a minimal Alpine image.

Data is persisted via a volume mount at `/app/data`. Config is injected either via environment variables (`SHOWPILOT_JWT_SECRET`, `SHOWPILOT_SHOW_TOKEN`) or a bind-mounted `config.js`.

### Reverse Proxy

ShowPilot listens on port 3100 (configurable). For HTTPS, place it behind a reverse proxy (Nginx Proxy Manager, Caddy, Traefik) or use the built-in Cloudflare Tunnel integration. Set `trustProxy: 1` in `config.js` when behind a proxy so ShowPilot receives accurate client IPs.

HTTPS is required for geolocation features (GPS audio gate, GPS proximity check) — browsers block the Geolocation API on `http://`.

### Cloudflare Tunnel (Optional)

ShowPilot can manage a Cloudflare Tunnel as a child process, providing HTTPS without port forwarding or a separate reverse proxy. Configure it in Admin → Settings → Cloudflare Tunnel. ShowPilot starts and monitors `cloudflared` on boot and kills it cleanly on shutdown.

---

## Key Design Decisions

These decisions were made deliberately and should not be reversed without reading `PRIMER.md` for full context.

| Decision | Rationale |
|---|---|
| Web Audio API instead of `<audio>` | HTML5 audio seeking causes audible decoder restart artifacts; PCM Web Audio is the only glitch-free path |
| Crossfade for sync correction, not `playbackRate` | playbackRate adjustments cause audible pitch changes on some devices and oscillate due to measurement lag |
| Device-clock-free drift measurement | OS clocks across phones differ by 100–300 ms; using the NTP-derived `clockOffset` as the drift reference causes each device to correct to a different position |
| Per-filename syncPoint resolver Map | A single global resolver is clobbered by rapid song changes, preventing the snap from ever firing |
| Backup router before global `express.json()` | Backup files can be 5–50 MB; global 1 MB limit would reject them before the backup route could apply its own 100 MB limit |
| `Restart=always` in systemd | Updater calls `process.exit(0)`; `Restart=on-failure` does not restart on clean exits |
| Surgical secrets restore | Whole-file config.js replacement would bake in the source's port and dbPath; only `jwtSecret` and `showToken` are extracted |
| SQLite + better-sqlite3 (synchronous) | Eliminates all async DB patterns; Node.js's event loop makes synchronous DB calls safe; zero-dependency deployment |
| No CSP header | User-authored viewer templates load fonts, images, and styles from anywhere; a CSP would break the core customization feature |
