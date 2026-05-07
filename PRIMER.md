# ShowPilot Project Primer

This document gives you (Claude, in a future conversation) the context you need to help Will work on ShowPilot effectively. Read this first before any other project files.

---

## What ShowPilot is

ShowPilot is a self-hosted companion app for Falcon Player (FPP) — the open-source software that runs Christmas and Halloween light shows. It adds a public-facing viewer page where show visitors can vote on songs, make jukebox requests, and listen to the show audio on their phones in sync with the physical speakers.

Key things it does:
- Serve a themed viewer page (HTML/CSS template the operator can customize)
- Run a jukebox/voting system for visitor interaction
- Stream audio to phones in sync with FPP playback
- Manage sequences (the songs/effects that play)
- Edit the viewer page template (HTML/CSS)
- Monitor plugin connectivity, queue activity, vote tallies
- Export/restore full instance backups

ShowPilot talks to FPP via a companion plugin (`ShowPilot-plugin`) that runs inside FPP. The plugin syncs sequence metadata, reports playback state, and pushes interaction events.

**Branding/domain context:** Will runs his show as "Lights On Drake" at lightsondrake.org. ShowPilot is the underlying software (formerly "OpenFalcon" — references to that name still appear in some config defaults).

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
/opt/showpilot/                  (prod LXC) or /app/ (Docker)
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

## Deployment topology

Will runs **three** ShowPilot environments. Don't conflate them.

### 1. Production LXC (Proxmox)
- Host: `192.168.1.230`, hostname still says `OpenFalcon` (cosmetic, not renamed yet)
- Path: `/opt/showpilot/`
- Process manager: **PM2** (process name: `showpilot`)
- Public URL: `lightsondrake.org` / `lights.lightsondrake.org` (via Cloudflare DNS-only mode + Nginx Proxy Manager)
- Restart: `pm2 restart showpilot`
- Logs: `pm2 logs showpilot`
- Show token: `f68a60ee2d903c8229c9a331af163d999b995c724be31578`

### 2. Docker test container (Will's Windows PC)
- Image: `ghcr.io/showpilotfpp/showpilot:latest`
- Container name: `sp-beta`
- Port: host `3101` → container `3100`
- Bind mount: `C:\Users\Will\sp-beta-data` → `/app/data`
- Auto-update: Watchtower watches and pulls new `:latest` images
- Restart policy: `unless-stopped`
- Used for: testing fresh installs, restore round-trips, anything risky before prod

### 3. FPP-Main plugin (the Falcon Player itself)
- Host: `192.168.1.247`
- Software: FPP v10.x-master-219-g2d311770
- Plugin path: `/home/fpp/media/plugins/showpilot/`
- Logs: `/home/fpp/media/logs/showpilot-listener.log`
- Repo: `github.com/ShowPilotFPP/ShowPilot-plugin` (separate from the main repo)

### FPP Audio Daemon
- The ShowPilot plugin also runs a separate audio daemon (`showpilot_audio.js`) on port 8090
- Daemon log: `/home/fpp/media/logs/showpilot-audio.log`
- Receives playback events from FPP via a FIFO at `/tmp/SHOWPILOT_FIFO`
- Broadcasts position updates and syncPoints to ShowPilot LXC via WebSocket
- ShowPilot relays these to viewers via Socket.io (`lib/audio-position-relay.js`)
- Daemon writes PID to `/tmp/showpilot-audio.pid` on startup for clean restarts

### CI/CD
- GitHub: `github.com/ShowPilotFPP/ShowPilot` (main repo) and `ShowPilotFPP/ShowPilot-plugin`
- GitHub Actions builds Docker images on tag push and publishes to ghcr.io
- Watchtower on the Docker host auto-pulls new `:latest`
- Prod LXC is updated manually via `git pull + pm2 restart`

---

## Deployment workflow

Standard release process:

```powershell
# On Will's dev machine (Windows, PowerShell)
cd C:\dev\ShowPilot
git pull origin main
tar -xzf "$env:USERPROFILE\Downloads\showpilot-vX.Y.Z.tar.gz" --strip-components=1
git add -A
git commit -m "vX.Y.Z — description"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

```bash
# Deploy to prod LXC
ssh root@192.168.1.230
cd /opt/showpilot && git pull origin main
pm2 restart showpilot
pm2 logs showpilot
```

For Docker test, watchtower auto-pulls. To force a fresh test:

```powershell
docker stop sp-beta
Remove-Item -Recurse -Force C:\Users\Will\sp-beta-data
docker pull ghcr.io/showpilotfpp/showpilot:latest
New-Item -ItemType Directory -Path C:\Users\Will\sp-beta-data | Out-Null
docker run -d --name sp-beta -p 3101:3100 -v C:\Users\Will\sp-beta-data:/app/data --restart unless-stopped ghcr.io/showpilotfpp/showpilot:latest
```

When you ship code, package it as a tarball at `/mnt/user-data/outputs/showpilot-vX.Y.Z.tar.gz`. Will downloads, extracts over his dev clone, commits, pushes.

### Standard tarball packaging commands (CRITICAL — never exclude .github)

```bash
# ShowPilot main
tar --exclude='showpilot/.git' \
    --exclude='showpilot/node_modules' \
    --exclude='showpilot/config.js' \
    --exclude='showpilot/data' \
    --exclude='showpilot/*.tar.gz' \
    -czf /mnt/user-data/outputs/showpilot-vX.Y.Z.tar.gz showpilot/

# ShowPilot plugin
tar --exclude='showpilot-plugin/.git' \
    -czf /mnt/user-data/outputs/showpilot-plugin-vX.Y.Z.tar.gz showpilot-plugin/
```

Always syntax-check before packaging:
```bash
cd /home/claude/showpilot && node --check server.js && echo "OK"
node --check /home/claude/showpilot-plugin/showpilot_audio.js && echo "Daemon OK"
```

### ShipPilot

Will uses ShipPilot (his own tool, separate LXC) to push releases to GitHub. Each release needs a `.release.json` in the repo root:

```json
{
  "repo": "showpilot",
  "version": "0.33.135",
  "commit_message": "v0.33.135 — description",
  "tag": "v0.33.135"
}
```

### Testing on LXC only (no GitHub)

When testing locally without pushing to GitHub, use a test tarball:
```powershell
scp "$env:USERPROFILE\Downloads\showpilot-test.tar.gz" root@192.168.1.230:/tmp/
```
```bash
ssh root@192.168.1.230
cd /opt/showpilot && tar -xzf /tmp/showpilot-test.tar.gz --strip-components=1 && pm2 restart showpilot
```
Only bump the rf-compat.js cache buster (`v=NN` in `lib/viewer-renderer.js`) for test builds — don't bump the package.json version until ready to ship.

---

## Audio sync architecture (v0.33.129+)

This is the most complex part of ShowPilot. Read carefully before touching anything audio-related.

### Overview

Viewers open the ShowPilot viewer page and tap "Listen on Phone." Audio plays from ShowPilot's cache in sync with FPP's physical speakers. The goal: all phones play the same position in the song at the same wall-clock moment, matching the speakers.

### Signal chain

```
FPP hardware speakers
    ↑
FPP plays audio file → FIFO → showpilot_audio.js daemon (port 8090)
                                    ↓ WebSocket (ws://192.168.1.247:8090)
                            audio-position-relay.js (on ShowPilot LXC)
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
- `MediaSyncStart` suppression: 1000ms. `MediaSyncPacket` song-change suppression: 800ms. setTimeout before forcing first syncPoint: 1000ms. Broadcast interval gate: 1000ms. (All reduced from original 2000ms/3100ms values in v0.13.38 to get first syncPoint at ~2s instead of ~4s.)
- Writes PID to `/tmp/showpilot-audio.pid` on startup (v0.13.39). `postStart.sh` uses it for clean kills.
- `scripts/restart-daemon.sh` — run after plugin updates to restart daemon without full fppd restart
- The HTTP poll must NOT set `lastSyncPointAt` — only the FIFO handler controls syncPoint suppression

**`audio-position-relay.js`** (ShowPilot LXC):
- Connects to daemon WebSocket at `ws://192.168.1.247:8090`
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

2. **SyncPoint snap** (~2s after song change) — `handleTrackChange` awaits the first `fppSyncPoint` for this song (daemon suppresses them for ~1s, first one arrives at ~2s). When it arrives, compute `snapPos` from the syncPoint's `positionSec + ageMs`. Stop the fast-start source, start a new `AudioBufferSourceNode` at `snapPos`. This is a hard cut (~20ms gap). All phones receive the same syncPoint and snap to the same position.

3. **Follow-up crossfade** (500ms after snap) — one 50ms crossfade correction using a fresh `fppStatus` reading. Catches any residual error from the snap's scheduling jitter. After this, all phones should be within ~20ms of each other.

4. **Ongoing crossfade correction** — periodic check (50ms threshold, 10s cooldown) using fresh `fppStatus` (< 200ms stale). Only fires if drift exceeds threshold. Uses `snapAnchorCtxTime`/`snapAnchorPosSec` for device-clock-free drift measurement.

5. **Fast calibration** — 5 samples collected starting 3s after the follow-up crossfade. Measures `audioPos - fppPos` (raw, without deviceOffset applied). Median stored as `sp_device_offset` in localStorage. Applied to `snapPos` on the next song. Recalibrates every song so speaker offset is automatically corrected. No manual `audioSyncOffsetMs` tuning needed.

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

`window._pendingSyncPointResolvers` is a map keyed by `mediaName`, replacing the single `window._pendingSyncPointResolver`. Rapid song changes no longer clobber each other's resolvers — each song change registers its own slot.

### Critical invariants — do not break

1. **`window._pendingSyncPointResolvers[mediaName]`** — keyed resolver map. Don't collapse back to a single global — rapid song changes will clobber each other.

2. **`trackScheduledAtAudioCtx` / `trackScheduledAtPositionSec`** must be updated atomically whenever a new `AudioBufferSourceNode` starts. `htmlAudio.currentTime` reads from these.

3. **`snapAnchorCtxTime` / `snapAnchorPosSec`** must be updated when the snap fires AND when the follow-up crossfade fires. These are the reference for device-clock-free drift. Reset in `stopAudio()`.

4. **The HTTP poll in `showpilot_audio.js` must NOT set `lastSyncPointAt`**. Only the FIFO handler controls syncPoint suppression.

5. **`htmlAudio` is a compatibility shim**, not a real `HTMLAudioElement`. All playback goes through `AudioBufferSourceNode`.

6. **Do not revert to HTML5 `<audio>`**. PCM-decoded Web Audio is the correct architecture.

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

## Version history (recent)

| Version | Change |
|---------|--------|
| 0.33.117 | Disable crossfade correction — devices in sync with each other at song start. |
| 0.33.128 | Grid-quantized startup sync: `playAtServerMs = ceil((serverNow+2000)/2000)*2000`. All phones start at same 2s boundary. Fixed `syncPoint` variable undefined in htmlAudio shim. |
| 0.33.129 | Fast-start + syncPoint snap + follow-up crossfade. `mediaName` added to `/api/now-playing-audio` response (was undefined, causing syncPoint filename match to always fail). Remove grid wait — snap fires immediately when syncPoint arrives. |
| 0.33.130 | Per-filename syncPoint resolver map (`window._pendingSyncPointResolvers`) replaces single global. Next-song prefetch while current song plays. |
| 0.33.131 | Re-enable PLL playbackRate correction (±0.5% max). |
| 0.33.132 | Reduce PLL rate further to prevent overshoot. |
| 0.33.133 | Remove noisy one-way clockOffset update from fppSyncPoint handler. High-jitter burst rejection: new burst rejected if best RTT > `bestRttEverMs * 3`. |
| 0.33.134 | Replace PLL with PulseMesh-style crossfade correction (50ms fade, 50ms threshold, 10s cooldown). Device-clock-free drift measurement using `snapAnchorCtxTime`/`snapAnchorPosSec` — eliminates inter-device OS clock differences from sync calculation. `snapPendingUntilMs` blocks periodic crossfade during snap+follow-up window. Crossfade only fires with fresh fppStatus (< 200ms stale). |
| 0.33.135 | Fast 5-sample calibration: measures `audioPos - fppPos` 3s after follow-up crossfade, stores median as `sp_device_offset`. Recalibrates every song. Automatically corrects speaker offset without manual `audioSyncOffsetMs` tuning. |

**Plugin version history (this session):**
| Version | Change |
|---------|--------|
| 0.13.37 | Reduce syncPoint suppression: MediaSyncStart 2000→1000ms, MediaSyncPacket song-change 1500→800ms, setTimeout 3100→1500ms. First syncPoint now arrives at ~3s instead of ~4s. |
| 0.13.38 | Further reduce: broadcast interval gate 2000→1000ms, setTimeout 1500→1000ms. First syncPoint at ~2s. |
| 0.13.39 | PID file (`/tmp/showpilot-audio.pid`) written on startup, cleaned on exit. `postStart.sh` kills via PID file first. `scripts/restart-daemon.sh` helper for post-update restarts without full fppd cycle. |

**Current versions (as of May 2026):**
- ShowPilot: v0.33.135
- FPP Plugin / Audio Daemon: v0.13.39
- rf-compat.js cache buster: v=70

---

## Architecture decisions worth knowing

**Surgical secrets restore (v0.25.2):** `lib/backup.js` extracts only `jwtSecret` and `showToken` from the backup's config.js via regex. Whole-file replacement was wrong — baked in source's port and dbPath.

**Body-size routing (v0.25.4):** Backup router mounted BEFORE global `express.json()` so backup requests hit the route-level 100MB parser first. Don't move that mount.

**Middleware ordering invariant (v0.25.5):** `cookieParser()` MUST run before any router that calls `requireAdmin`. Don't reorder.

**In-app updater (v0.33.0):** Git-in-place, no symlink reshape. Single snapshot at `data/.snapshots/previous/`. audio-cache excluded from snapshots. Docker gated to status-only.

**Web Audio over HTML5 `<audio>` (v0.33.112):** Permanent. MP3 seeking on `<audio>` causes decoder restarts with audible artifacts. PCM-decoded Web Audio is the correct architecture. Do not propose reverting.

**No playbackRate for sync (v0.33.134):** playbackRate correction was tried and abandoned. It oscillates because the drift measurement has lag, and ±0.5% causes audible pitch changes on some devices. Crossfade is the correct correction mechanism — inaudible 50ms fade between sources at the correct position.

**Device-clock-free drift (v0.33.134):** OS clocks on different devices (phone vs PC) can differ by 100-300ms even on the same LAN. Using `clockOffset`-based `fppPositionNow` as the drift reference caused each device to correct to a different position. The fix: measure drift as `htmlAudio.currentTime - (snapAnchorPosSec + audioCtxElapsed)` — purely audio-clock-relative, device-clock-independent.

**Automatic speaker calibration (v0.33.135):** Do not add a manual `audioSyncOffsetMs` setting UI or suggest users tune it manually. The 5-sample fast calibration handles the speaker offset automatically every song. The `audioSyncOffsetMs` config value still exists for edge cases but should not need to be touched in normal operation.

**`window._pendingSyncPointResolver` → map (v0.33.130):** The original single global was fine for one song at a time, but rapid song changes caused the new song's setup to overwrite the previous song's resolver, leaving it permanently unresolved (8s timeout, then no snap). The per-filename map fixes this. Do not collapse back to a single global.

---

## Will's context

- Non-coder. Runs commands, doesn't write code himself. Give him paste-able scripts.
- Halloween light show at 2200 South Old Missouri Road, Springdale, AR (Lights on Drake)
- Show season: October. Off-season testing with FPP running playlists in test mode.
- Other projects: HG Cellular (device refurb), NWAobits.com (obituaries), cal.lightsondrake.org (countdown calendar), C:\PokePricing (TCG pricing), pokedex.hgcellular.com (Amazon dashboard).
- Prefers iterative testing — risky changes on Docker first, then prod.
- Uses ShipPilot for all GitHub releases.

---

## Starting a new conversation

1. Read this primer.
2. Don't assume workspace has latest code. Clone fresh: `git clone https://github.com/ShowPilotFPP/ShowPilot.git /home/claude/showpilot`
3. Check `package.json` version to confirm starting point.
4. For continuity on a specific issue, search conversation history.
5. Don't reinvent documented decisions. If you think one is wrong, raise it explicitly.
