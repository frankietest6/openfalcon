# ShowPilot Project Primer

This document orients new contributors (humans or AI assistants) to ShowPilot's architecture, conventions, and the non-obvious invariants that you'll otherwise rediscover painfully. Read this before opening other source files.

---

## What ShowPilot is

ShowPilot is a self-hosted companion app for [Falcon Player (FPP)](https://github.com/FalconChristmas/fpp) — the open-source software that runs Christmas and Halloween light shows. ShowPilot adds a public-facing **viewer page** where show visitors can vote on songs, make jukebox requests, and listen to the show audio on their phones in sync with the physical speakers at the show.

Key things it does:
- Serve a themed viewer page (HTML/CSS template the operator can customize)
- Run a jukebox/voting system for visitor interaction
- Stream audio to phones in sync with FPP playback
- Manage sequences (the songs/effects FPP plays)
- Edit the viewer page template (HTML/CSS, including a visual designer)
- Monitor plugin connectivity, queue activity, vote tallies
- Export/restore full instance backups

ShowPilot talks to FPP via a companion plugin (`ShowPilot-plugin`) that runs inside FPP. The plugin syncs sequence metadata, reports playback state, and pushes interaction events.

There is also a stripped-down sibling project, **ShowPilot-Lite**, which runs as an FPP plugin directly on the FPP host (no separate machine needed). Lite removes the audio-streaming features, intended for operators using PulseMesh, FM transmitters, or Icecast for audio delivery. Non-audio changes generally land in both repos under matching version numbers.

---

## Architecture

**Stack:**
- Node.js / Express server (`server.js` is the entry point)
- SQLite database via `better-sqlite3` (data lives at `data/showpilot.db`)
- Vanilla JS frontend (no React, no build step) — admin UI is one big HTML file at `public/admin/index.html`
- JWT-based admin auth in httpOnly cookies
- bcrypt for password hashing

**Key directories:**
```
/opt/showpilot/                  (typical install path; or /app/ in Docker)
├── server.js                    — main entry, route mounting
├── package.json                 — version source of truth
├── config.js                    — host-specific config (jwtSecret, port, dbPath, showToken)
├── config.example.js            — template for fresh installs
├── deploy.sh                    — install script (npm install + ffmpeg via apt-get)
├── lib/
│   ├── db.js                    — SQLite schema, migrations, getters/setters
│   ├── config-loader.js         — loads config.js
│   ├── backup.js                — export/inspect/restore logic
│   ├── process-supervisor.js    — detects PM2/systemd/NSSM/Docker for restarts
│   ├── cover-art.js             — Spotify cover art fetcher (covers stored in data/covers/)
│   ├── viewer-renderer.js       — server-renders viewer page from active template
│   ├── audio-cache.js           — audio file cache, ffmpeg M4A transcoding
│   ├── audio-position-relay.js  — WebSocket relay from FPP daemon to Socket.io viewers
│   └── ...
├── routes/
│   ├── admin.js                 — auth + admin CRUD endpoints (requireAdmin middleware lives here)
│   ├── viewer.js                — public viewer endpoints (vote, queue, audio stream)
│   ├── plugin.js                — endpoints the FPP plugin calls
│   └── backup.js                — backup/restore HTTP routes
├── public/
│   ├── admin/index.html         — entire admin SPA (one file, no build)
│   ├── rf-compat.js             — viewer-side JS (audio engine, sync, voting, jukebox)
│   └── ...
└── data/
    ├── showpilot.db             — SQLite DB
    ├── covers/                  — sequence cover art (jpg files named by sequence ID)
    └── audio-cache/             — cached audio files (.bin, transcoded to AAC/M4A by ffmpeg)
```

---

## Typical deployment topologies

ShowPilot is designed to run in any of:

**Production VM/LXC**
- Runs as a long-lived service (PM2, systemd, NSSM, etc.)
- Reverse-proxied through Nginx Proxy Manager / Caddy / Cloudflare Tunnel for HTTPS
- The application listens on `127.0.0.1:3100` by default

**Docker container**
- `ghcr.io/showpilotfpp/showpilot:latest` image is published on each release tag
- Map a host port to container `3100`, bind-mount `/app/data` for persistence
- GitHub Actions builds the image on tag push; Watchtower or similar can auto-pull `:latest`
- Useful for testing fresh installs, restore round-trips, and risky changes before prod

**FPP host (alongside the plugin)**
- The companion plugin `ShowPilot-plugin` (separate repo) runs inside FPP
- Plugin path: `/home/fpp/media/plugins/showpilot/`
- Plugin includes the FPP audio daemon (`showpilot_audio.js`, port 8090) which feeds position events to ShowPilot via WebSocket

### FPP audio daemon
- Runs `showpilot_audio.js` on port 8090 inside FPP
- Logs at `/home/fpp/media/logs/showpilot-audio.log`
- Receives playback events from FPP via a FIFO at `/tmp/SHOWPILOT_FIFO`
- Broadcasts position updates and syncPoints to ShowPilot via WebSocket
- ShowPilot relays these to viewers via Socket.io (`lib/audio-position-relay.js`)
- Daemon writes PID to `/tmp/showpilot-audio.pid` on startup for clean restarts

### CI/CD
- GitHub: [`ShowPilotFPP/ShowPilot`](https://github.com/ShowPilotFPP/ShowPilot) (main repo) and [`ShowPilotFPP/ShowPilot-plugin`](https://github.com/ShowPilotFPP/ShowPilot-plugin)
- GitHub Actions builds Docker images on tag push and publishes to ghcr.io
- Operator updates production manually: `git pull && pm2 restart showpilot` (or systemd equivalent)

---

## Deployment workflow

Standard release process for contributors:

```bash
# Pull latest, apply changes from a tarball or via git
cd /path/to/your/ShowPilot/clone
git pull origin main
# ... make edits ...
git add -A
git commit -m "vX.Y.Z — description"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

Production update (LXC / VM with PM2):
```bash
cd /opt/showpilot && git pull origin main
pm2 restart showpilot
pm2 logs showpilot
```

Docker test refresh:
```bash
docker stop sp-beta
docker pull ghcr.io/showpilotfpp/showpilot:latest
docker run -d --name sp-beta -p 3101:3100 \
  -v /path/to/sp-beta-data:/app/data \
  --restart unless-stopped \
  ghcr.io/showpilotfpp/showpilot:latest
```

### Standard tarball packaging

Tarballs are convenient for shipping updates without a full git push (e.g., to a private deploy tool):

```bash
tar --exclude='showpilot/.git' \
    --exclude='showpilot/node_modules' \
    --exclude='showpilot/config.js' \
    --exclude='showpilot/data' \
    --exclude='showpilot/*.tar.gz' \
    -czf showpilot-vX.Y.Z.tar.gz showpilot/
```

Always sanity-check syntax before packaging:
```bash
cd showpilot && node --check server.js && echo "OK"
```

Bump version in two places before shipping:
- `package.json` — `"version": "X.Y.Z"`
- `public/admin/index.html` — `<span class="app-version">vX.Y.Z</span>` near the top

### Test deploys without GitHub

When iterating locally without pushing, push a tarball straight to the host:
```bash
scp showpilot-test.tar.gz user@host:/tmp/
ssh user@host
cd /opt/showpilot && tar -xzf /tmp/showpilot-test.tar.gz --strip-components=1 && pm2 restart showpilot
```

Bump only the `rf-compat.js` cache buster (`v=NN` in `lib/viewer-renderer.js`) for test builds — don't bump `package.json` until you're ready to cut a real release.

---

## Audio sync architecture (v0.33.129+)

This is the most complex part of ShowPilot. Read carefully before touching audio-related code.

### Overview

Viewers open the ShowPilot viewer page and tap "Listen on Phone." Audio plays from ShowPilot's cache in sync with FPP's physical speakers. The goal: all phones play the same position in the song at the same wall-clock moment, and that moment matches the speakers.

### Signal chain

```
FPP hardware speakers
    ↑
FPP plays audio file → FIFO → showpilot_audio.js daemon (port 8090)
                                    ↓ WebSocket
                            audio-position-relay.js (on ShowPilot host)
                                    ↓ Socket.io (fppPosition, fppSyncPoint events)
                            rf-compat.js (viewer browser)
                                    ↓
                            AudioBufferSourceNode (Web Audio API)
                                    ↓
                            Phone speaker
```

### Key components

**`showpilot_audio.js`** (FPP plugin daemon):
- Listens to FIFO for `MediaSyncStart`, `MediaSyncStop`, `MediaSyncPacket` events from FPP
- Broadcasts `position` events every ~500ms via WebSocket
- Broadcasts `syncPoint` events every ~1s (suppressed for ~1s after song change)
- Suppression timings (reduced from older 2000ms/3100ms in v0.13.38 to land first syncPoint at ~2s instead of ~4s):
  - `MediaSyncStart` suppression: 1000ms
  - `MediaSyncPacket` song-change suppression: 800ms
  - setTimeout before forcing first syncPoint: 1000ms
  - Broadcast interval gate: 1000ms
- Writes PID to `/tmp/showpilot-audio.pid` on startup (v0.13.39). `postStart.sh` uses it for clean kills.
- `scripts/restart-daemon.sh` — run after plugin updates to restart the daemon without a full FPP restart
- The HTTP poll must NOT set `lastSyncPointAt` — only the FIFO handler controls syncPoint suppression

**`audio-position-relay.js`** (ShowPilot host):
- Connects to daemon WebSocket on the FPP host (configurable)
- Translates `position` → `io.emit('fppPosition', ...)` and `syncPoint` → `io.emit('fppSyncPoint', ...)`
- 500ms reconnect on disconnect
- Ping handler responds to server pings for keepalive

**`rf-compat.js`** (viewer browser) — Web Audio Engine:
- `startup()` creates `AudioContext`, fires initial HTTP clock sync, establishes Socket.io, re-syncs clock via Socket.io timesync burst
- `handleTrackChange()` — full startup sync sequence (see below)
- `fetch()` + `decodeAudioData()` decodes audio to PCM in memory
- `AudioBufferSourceNode.start(ctxTime, positionSec)` schedules playback
- Position tracked via `trackScheduledAtAudioCtx` / `trackScheduledAtPositionSec` anchor pair

### Startup sync sequence (per song change, v0.33.129+)

This is the core of multi-phone sync. Every song change goes through these steps in order:

1. **Fast-start** — audio begins playing immediately from current `fppStatus` position. No waiting. Phones may be slightly out of sync at this point.

2. **SyncPoint snap** (~2s after song change) — `handleTrackChange` awaits the first `fppSyncPoint` for this song. When it arrives, compute `snapPos` from the syncPoint's `positionSec + ageMs`. Stop the fast-start source, start a new `AudioBufferSourceNode` at `snapPos`. Hard cut (~20ms gap). All phones receive the same syncPoint and snap to the same position.

3. **Follow-up crossfade** (500ms after snap) — one 50ms crossfade correction using a fresh `fppStatus` reading. Catches residual scheduling jitter from the snap. After this, all phones should be within ~20ms of each other.

4. **Ongoing crossfade correction** — periodic check (50ms threshold, 10s cooldown) using fresh `fppStatus` (< 200ms stale). Only fires if drift exceeds threshold. Uses `snapAnchorCtxTime`/`snapAnchorPosSec` for device-clock-free drift measurement.

5. **Fast calibration** — 5 samples collected starting 3s after the follow-up crossfade. Measures `audioPos - fppPos` (raw, without deviceOffset applied). Median stored as `sp_device_offset` in localStorage. Applied to `snapPos` on the next song. Recalibrates every song so speaker offset is corrected automatically. No manual `audioSyncOffsetMs` tuning needed.

### Device-clock-free drift measurement (v0.33.134+)

**The problem:** Different devices (phone vs PC, or two phones) have OS clocks that may differ by 100-300ms even on the same LAN. Using `clockOffset` (server - client time) to compute `fppPositionNow` produces different values on each device, causing them to correct to different positions.

**The solution:** After the snap fires, drift is measured as:
```
expectedPos = snapAnchorPosSec + (audioCtx.currentTime - snapAnchorCtxTime)
drift = htmlAudio.currentTime - expectedPos
```
This is purely audio-clock-relative. No server clock, no `clockOffset`, no network. Both devices anchored to the same syncPoint → same `snapAnchorPosSec` → same drift calculation → corrections converge to the same position.

`fppPositionNow` is still computed (via `clockOffset`) for display and for the initial fast-start position, but NOT used as the drift reference after the snap.

### Clock sync (Socket.io NTP-style)

`syncClockBurst(n)` fires n parallel Socket.io `timesync` events. Server responds immediately. Viewer computes: `offset = ((t2-t1) + (t3-t4)) / 2`. Takes median of lowest-RTT half. Re-syncs every 30 seconds.

**Critical:** Do NOT update `clockOffset` from `fppSyncPoint` message timestamps — those are one-way and noisy. Only `syncClockBurst` should set `clockOffset`.

**High-jitter rejection (v0.33.133+):** `bestRttEverMs` tracks the best RTT seen across all bursts. A new burst's result is rejected if its best RTT exceeds `bestRttEverMs * 3`. This prevents a high-jitter burst (e.g. 200ms RTT when previous was 5ms) from corrupting a good clock estimate.

### Next-song prefetch (v0.33.130+)

While the current song plays, `rf-compat.js` prefetches and decodes the next scheduled song in the background. When the song change fires, `handleTrackChange` finds the buffer already in `decodedBufferCache` — decode time is near-zero, so the snap fires as soon as the syncPoint arrives (~2s) rather than waiting for fetch+decode.

### mediaName field (v0.33.129+)

`/api/now-playing-audio` response now includes `mediaName: seq.media_name` — the raw FPP filename (e.g. `"08 - Bloody Mary.mp3"`). This is what `fppSyncPoint` events carry as `filename`. Without this field, the syncPoint filename match in `handleTrackChange` always failed and snaps never fired.

### Per-filename syncPoint resolver map (v0.33.130+)

`window._pendingSyncPointResolvers` is a map keyed by `mediaName`, replacing the older single `window._pendingSyncPointResolver`. Rapid song changes no longer clobber each other's resolvers — each song change registers its own slot.

### Critical invariants — do not break

1. **`window._pendingSyncPointResolvers[mediaName]`** — keyed resolver map. Don't collapse back to a single global — rapid song changes will clobber each other.

2. **`trackScheduledAtAudioCtx` / `trackScheduledAtPositionSec`** must be updated atomically whenever a new `AudioBufferSourceNode` starts. `htmlAudio.currentTime` reads from these.

3. **`snapAnchorCtxTime` / `snapAnchorPosSec`** must be updated when the snap fires AND when the follow-up crossfade fires. These are the reference for device-clock-free drift. Reset in `stopAudio()`.

4. **The HTTP poll in `showpilot_audio.js` must NOT set `lastSyncPointAt`**. Only the FIFO handler controls syncPoint suppression.

5. **`htmlAudio` is a compatibility shim**, not a real `HTMLAudioElement`. All playback goes through `AudioBufferSourceNode`.

6. **Do not revert to HTML5 `<audio>`**. PCM-decoded Web Audio is the correct architecture (see "Architecture decisions" below).

7. **Do not use `fppPositionNow` as the drift reference after snap**. Use `snapAnchorCtxTime`/`snapAnchorPosSec`. Using `fppPositionNow` re-introduces the device-clock difference problem.

8. **Crossfade corrections must only fire with fresh fppStatus** (< 200ms stale). Stale extrapolation produces inaccurate targets and causes overcorrection.

### Daemon restart after plugin update

The daemon is a long-running Node process started by FPP's `postStart.sh`. It does NOT restart automatically when the plugin is updated via git pull. After any plugin update that touches `showpilot_audio.js`:

```bash
sudo /home/fpp/media/plugins/showpilot/scripts/restart-daemon.sh
```

This uses the PID file (`/tmp/showpilot-audio.pid`) for a clean kill and respawn.

### Audio cache and ffmpeg

Audio files uploaded by the FPP plugin are stored as `data/audio-cache/<sha256>.bin`. On startup, ShowPilot runs a background job to transcode all MP3 `.bin` files to AAC/M4A using:

```bash
ffmpeg -y -f <probed_format> -i input.bin -vn -c:a aac -b:a 192k -movflags +faststart output.m4a
```

The `-vn` flag is critical. `ffprobe` is used to detect the actual format. ffmpeg is installed via `apt-get install -y ffmpeg` in `deploy.sh`.

---

## Debug overlay

Add `?debug=1` to the viewer URL to show the sync debug overlay. Key fields:

- `drift` — audio-clock-relative drift from snap anchor (ms). After snap this should be near 0 on all devices regardless of OS clock differences.
- `engine` — `WebAudio` (always)
- `fppPos` — FPP's current position (extrapolated from last fppStatus via clockOffset)
- `audioPos` — `htmlAudio.currentTime` (from Web Audio tracking)
- `staleness` — how old the last fppStatus reading is
- `clockOffset` — server clock minus client clock in ms (used for fast-start position and display only, NOT for drift correction after snap)
- `seekedTo` — where audio was positioned at last snap/crossfade
- `deviceOff` — per-device calibration offset (N/5 = calibration progress, recalibrates every song)

If `fppPos` and `audioPos` differ significantly but `drift` shows ~0ms, that's expected — it means the audio-clock-relative measurement is working. The gap between `fppPos` and `audioPos` reflects the speaker offset, which `deviceOffset` corrects automatically on the next song.

---

## Architecture decisions worth knowing

**Surgical secrets restore (v0.25.2):** `lib/backup.js` extracts only `jwtSecret` and `showToken` from the backup's `config.js` via regex. Whole-file replacement was wrong — it baked in the source's port and dbPath.

**Body-size routing (v0.25.4):** Backup router mounted BEFORE global `express.json()` so backup requests hit the route-level 100MB parser first. Don't move that mount.

**Middleware ordering invariant (v0.25.5):** `cookieParser()` MUST run before any router that calls `requireAdmin`. Don't reorder.

**In-app updater (v0.33.0):** Git-in-place, no symlink reshape. Single snapshot at `data/.snapshots/previous/`. The audio cache is excluded from snapshots. Docker is gated to status-only.

**Restart=always in systemd unit (v0.33.140):** The README's systemd service guide previously had `Restart=on-failure`. The in-app updater calls `process.exit(0)` (clean exit, code 0) to pick up new code after an update — `on-failure` does not restart on clean exits, so the updater appeared to work but left ShowPilot stopped. Fixed to `Restart=always` in v0.33.140. Users on older installs need to update their service file manually:
```bash
sudo sed -i 's/Restart=on-failure/Restart=always/' /etc/systemd/system/showpilot.service
sudo systemctl daemon-reload
```

**Web Audio over HTML5 `<audio>` (v0.33.112):** Permanent. MP3 seeking on `<audio>` causes decoder restarts with audible artifacts. PCM-decoded Web Audio is the correct architecture. Do not propose reverting.

**No playbackRate for sync (v0.33.134):** playbackRate correction was tried and abandoned. It oscillates because the drift measurement has lag, and ±0.5% causes audible pitch changes on some devices. Crossfade is the correct correction mechanism — inaudible 50ms fade between sources at the correct position.

**Device-clock-free drift (v0.33.134):** OS clocks on different devices (phone vs PC) can differ by 100-300ms even on the same LAN. Using `clockOffset`-based `fppPositionNow` as the drift reference caused each device to correct to a different position. The fix: measure drift as `htmlAudio.currentTime - (snapAnchorPosSec + audioCtxElapsed)` — purely audio-clock-relative, device-clock-independent.

**Automatic speaker calibration (v0.33.135):** Do not add a manual `audioSyncOffsetMs` setting UI or suggest users tune it manually. The 5-sample fast calibration handles the speaker offset automatically every song. The `audioSyncOffsetMs` config value still exists for edge cases but should not need to be touched in normal operation.

**`window._pendingSyncPointResolver` → map (v0.33.130):** The original single global was fine for one song at a time, but rapid song changes caused the new song's setup to overwrite the previous song's resolver, leaving it permanently unresolved (8s timeout, then no snap). The per-filename map fixes this. Do not collapse back to a single global.

**`<img class="sequence-image">` `width=` only, no `height=` (v0.33.142):** The viewer renderer emits `<img ... width="40" loading="lazy">` for sequence covers and deliberately omits a `height` attribute. The HTML `height` attribute is a presentational hint that conflicts with author CSS like `aspect-ratio: 1/1` — producing a 40px-tall horizontal slice of the source image instead of a square thumbnail. Letting the browser infer height from the source's natural aspect ratio works for both worlds: CSS-less templates get a square 40px thumbnail; modern templates with `aspect-ratio` rules get the layout they intended.

**Viewer-page cache headers + SW navigation revalidation (v0.33.143):** The viewer page (`/`) sends `Cache-Control: no-cache, must-revalidate` so browsers don't apply heuristic caching (which can hold the rendered HTML for hours). The bundled service worker also forces `cache: 'reload'` on navigation requests — this bypasses HTTP cache for the page HTML even if a stale entry exists from before v0.33.143. Without both pieces, fresh deploys took hours to reach existing visitors because the previously-rendered HTML was sticky in browser caches and the SW's pass-through fetch went through the cache. Don't remove either piece without thinking about it: removing the response header makes future deploys slow to land; removing the SW navigation override leaves users on existing installs stuck on whatever HTML they had cached when they last loaded the page.

---

## Contributing

1. **Read this primer.** Then skim `server.js` and `lib/viewer-renderer.js` to orient.
2. **Don't assume your local clone is up to date.** Fresh-clone before patching: `git clone https://github.com/ShowPilotFPP/ShowPilot.git`
3. **Check `package.json` version** to confirm what release you're starting from.
4. **Don't reinvent documented decisions** in "Architecture decisions worth knowing" above. If you think one is wrong, raise it explicitly in an issue or PR rather than quietly changing course — the rationale that justified each decision matters.
5. **Match the established conventions** — surgical edits, no architectural rewrites unless explicitly invited. Each release should be a coherent change.
6. **Test what you can** before opening a PR. The audio sync code in particular benefits from dry runs against `?debug=1` in a multi-device setup.
