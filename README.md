# ShowPilot

[![Website](https://img.shields.io/badge/Website-showpilot.dev-ffb155?logo=googlechrome&logoColor=white)](https://showpilot.dev) [![Discord](https://img.shields.io/badge/Discord-Join%20the%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/UpmcXmWfN9) [![Facebook](https://img.shields.io/badge/Facebook-Join%20the%20group-1877F2?logo=facebook&logoColor=white)](https://www.facebook.com/groups/showpilot)

**Self-hosted light show viewer control server.** A drop-in alternative to Remote Falcon for hobbyists who want to run their own infrastructure without relying on a cloud service.

ShowPilot pairs with a Falcon Player (FPP) plugin to let your visitors:
- 🎵 Vote for sequences (Voting mode) or queue them up (Jukebox mode)
- 📱 Listen to your show audio on their phone via a built-in web player — no app required
- 🎄 See what's playing now and what's coming up next on a customizable viewer page

You get an admin dashboard with stats, queue management, sequence configuration, viewer-page editor, theming, and multi-user authentication.

> **Migrating from Remote Falcon?** ShowPilot's viewer page renderer is **fully compatible with Remote Falcon templates**. All the standard placeholders (`{PLAYLISTS}`, `{NOW_PLAYING}`, `{JUKEBOX_QUEUE}`, `{NEXT_PLAYLIST}`, `{QUEUE_DEPTH}`, `{LOCATION_CODE}`, etc.) and mode containers (`{playlist-voting-dynamic-container}`, `{jukebox-dynamic-container}`, `{after-hours-message}`, `{location-code-dynamic-container}`) work identically. Paste your existing Remote Falcon viewer HTML into ShowPilot's editor and it just works — no template rewrite needed.

---

## Features

### Visitor experience

- **Voting & Jukebox modes** — switch between letting viewers vote for the next sequence or queue songs to play in order
- **Listen-on-Phone audio player** — built-in web audio streaming directly from FPP. Visitors hear synchronized show audio on their phones with no native app, no extra service, no Icecast setup. Works on iOS Safari, Android Chrome, and desktop browsers
- **Mobile-first viewer page** — designed for cold winter hands tapping with gloves. Large hit targets, high-contrast cards, marquee-scrolling long titles, optional snow effects, optional themed player decorations (Christmas, Halloween, Easter, St. Patrick's, Independence Day, Valentine's, Hanukkah, Thanksgiving, generic snow)
- **Cover art support** — automatic MusicBrainz/iTunes cover lookup per sequence with admin override, displayed inline on song cards
- **Now Playing + Up Next** — real-time updates pushed via Socket.io, plus polled fallback for slower connections

### Visual page designer

- **Three editing modes** — pick what fits your comfort level:
  - **Settings mode**: form-based editor for show name, colors, fonts, hours, social links, FM frequency. No HTML knowledge required
  - **Blocks mode**: drag-and-drop sections onto a canvas — 12 block types covering Hero, Text, Divider, Show Hours, Now Playing, Queue, Voting Instructions, Jukebox Instructions, Song List, Location Code, Social Links, and Custom HTML. Reorder by dragging or with arrow buttons
  - **Code mode**: full Monaco editor for hand-written HTML. Standard Remote Falcon placeholders supported
- **Live preview iframe** — see your changes update next to the editor as you type, before committing
- **Drafts** — edits save as drafts automatically (debounced 500ms). Visitors keep seeing the live page until you click Save Changes
- **Multiple templates** — create as many templates as you want and switch active ones with one click. Build separate looks for different seasons or events
- **Default template included** — fresh installs get a working mobile-friendly template seeded automatically; customize from there

### Audio & copyright safeguards

- **GPS audio gate (optional)** — restrict audio playback to listeners physically present at your show. Tapping the 🎧 button forces a fresh GPS check (cached location won't bypass it). Re-verifies every 15 minutes during playback to catch listeners who walked away
- **Refresh-to-recover latch** — once the gate trips, audio stays blocked until the page is refreshed. Prevents auto-resume when admin toggles control modes
- **External audio access** — set your public domain so listeners on cellular can stream the audio without VPN. Local listeners still use the direct path for best performance

### Location tools

- **Address-to-coordinates lookup** — type any address ("1234 Main St, Branson MO"), click Find Coordinates, lat/lng auto-fill. Powered by OpenStreetMap Nominatim
- **Detect-my-location button** — uses browser GPS to set show coordinates if you're at the venue
- **Visual map preview** — embedded OpenStreetMap shows exactly where your coordinates point, scales to your radius. Verify your config without leaving admin

### FPP integration

- **Companion FPP plugin** — install the ShowPilot plugin from FPP's Plugin Manager, point it at your ShowPilot server URL, and it stays connected. Plugin handles sequence sync, playing-status reporting, and viewer request handoff to FPP's playlist
- **Sequence sync** — sequences imported from FPP into the admin, where you can reorder, rename for display, set artists, hide individual sequences, and toggle votable/jukeboxable per sequence
- **Mid-track resume** — when a viewer-requested song interrupts the original, resuming the original picks up at the correct elapsed position (not the start)
- **PSA injection** — auto-inject PSAs (sponsor messages, holiday greetings) every N interactions
- **Real-time plugin status** — admin header shows whether FPP plugin is connected and last sync time, updated live via Socket.io

### Admin & operations

- **Multi-user authentication** — username + password, bcrypt hashed, JWT session cookies. Per-user "remember me" (30-day cookie or session-only). Force-password-change flag for new accounts
- **User management** — add/edit/disable/delete users. Self-protection: can't disable yourself, can't delete the last user
- **Themes** — Stage·Dark and Stage·Light core themes for the admin UI, plus seasonal variants (Christmas, Halloween, Easter, St. Patrick's, Independence Day, Valentine's) you can switch between
- **Sequence snapshots** — save your current playlist configuration (display names, artists, sort order, visibility) as a named snapshot. Restore later when switching seasons. Non-destructive: preserves play history, vote stats, queue state
- **Live stats dashboard** — votes per round, jukebox queue depth, plays per sequence, last-played times, viewer count
- **IP blocking** — block individual IPs or CIDR ranges. Useful when one user gets too enthusiastic with the request button
- **Per-sequence visibility/votability/jukeboxability** — fine-grained control over what shows up where
- **Auto-fill song info** — looks up sequence titles online to populate display name + artist automatically (no more "JinglePopXmas2019_v3.fseq" shown to viewers)
- **GPS proximity check** — separate from the audio gate; restricts who can vote/queue based on their physical location
- **Configurable request limits** — per-viewer cap on jukebox requests per session (1-20)

### Self-hosted, owned, free

- **No cloud dependency** — runs on a Pi, a NAS, a VM, anywhere with Node.js
- **SQLite database** — single file, easy backup, no separate database server
- **Open source** — MIT-licensed, hackable, no vendor lock-in
- **No telemetry** — your data stays on your hardware

---

## ⚠️ Important: HTTPS is required for geolocation features

The viewer page uses browser geolocation APIs for the **GPS audio gate** and **GPS proximity check**. **Browsers refuse to expose location data on insecure (`http://`) origins** — this is a hardcoded security restriction, not something ShowPilot controls.

If you plan to use any location-based feature, you **must** serve ShowPilot over HTTPS. Options:

- **Nginx Proxy Manager** (easiest) with a Let's Encrypt cert — point it at ShowPilot on port 3100
- **Caddy** with automatic HTTPS — single-line reverse proxy config
- **Cloudflare Tunnel** — free TLS without opening ports
- **Standalone reverse proxy** (Nginx/Apache) with your own cert

Localhost (`http://localhost:3100` or `http://127.0.0.1:3100`) is also exempt from this restriction, so local development works without HTTPS. But anything visitors hit needs a cert.

If you don't use any location features, plain HTTP is fine.

---

## Quick links

- [Features](#features)
- [Requirements](#requirements)
- [Install on Linux (Debian/Ubuntu/Raspberry Pi OS)](#install--linux-debian--ubuntu--raspberry-pi-os)
- [Install on Linux (RHEL/Fedora/Rocky/Alma)](#install--linux-rhel--fedora--rocky--alma)
- [Install on macOS](#install--macos)
- [Install on Windows](#install--windows)
- [Install with Docker](#install--docker)
- [First-run setup](#first-run-setup)
- [Install the FPP plugin](#install-the-fpp-plugin)
- [Configuration reference](#configuration-reference)
- [Running as a service](#running-as-a-service)
- [Updating](#updating)
- [Backups](#backups)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Node.js   | 18.x    | 20.x or 22.x LTS |
| RAM       | 256 MB  | 512 MB+ |
| Disk      | 100 MB for app + your data | 1 GB+ if storing many cover art images |
| OS        | any modern Linux, macOS 11+, Windows 10+ | Linux for production |
| FPP       | 7.0+ on a separate device (Pi, BeagleBone, etc.) | latest stable |

**Network:** ShowPilot listens on TCP port 3100 by default. The FPP plugin needs to reach this port. Visitors hit the same port (or whatever you front it with).

---

## Install — Linux (Debian / Ubuntu / Raspberry Pi OS)

These instructions cover Debian 11+, Ubuntu 22.04+, Raspberry Pi OS Bookworm+. The exact same commands work on a Raspberry Pi 4/5 if you want to colocate ShowPilot with FPP on a single Pi (4GB+ RAM recommended).

### 1. Install Node.js 20 LTS

The Node.js version in your distro repos is usually too old. Use the official NodeSource installer:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
```

Verify:

```bash
node --version    # should print v20.x.x or higher
npm --version
```

### 2. Install ShowPilot

```bash
# Pick a location. /opt is conventional for self-hosted apps.
sudo mkdir -p /opt/showpilot
sudo chown $USER:$USER /opt/showpilot
cd /opt/showpilot

# Download the latest release tarball
wget https://github.com/ShowPilotFPP/ShowPilot/releases/latest/download/showpilot.tar.gz
tar -xzf showpilot.tar.gz --strip-components=1
rm showpilot.tar.gz

# Or clone via git if you prefer:
# git clone https://github.com/ShowPilotFPP/ShowPilot.git .

# Install Node dependencies
npm install --omit=dev
```

### 3. (Optional) Customize the config

ShowPilot works out of the box with no configuration — secrets are auto-generated on first run and persisted to `data/secrets.json`. If you want to tweak ports, paths, or other settings:

```bash
cp config.example.js config.js
nano config.js
```

The most useful setting to think about is `trustProxy`:
- **Direct exposure (port forward, no proxy):** keep `trustProxy: false` (the default)
- **Behind a reverse proxy (Nginx Proxy Manager, Caddy, Cloudflare Tunnel, etc.):** set `trustProxy: 1`

For environments where you'd rather inject secrets at runtime (Kubernetes, Docker secrets, etc.), set the `SHOWPILOT_JWT_SECRET` and `SHOWPILOT_SHOW_TOKEN` environment variables — they take precedence over both `config.js` and auto-generation.

### 4. Start it up

```bash
npm start
```

On the very first run, you'll see a one-time announcement with your auto-generated **show token** — that's the value you'll paste into the FPP plugin config. You can also retrieve it anytime in the admin UI under **Settings → Plugin → Show Token**.

You should see `ShowPilot listening on http://0.0.0.0:3100`. Open `http://<your-server-ip>:3100/admin` in a browser.

Default login: **`admin` / `admin`** — you'll be forced to change the password on first login.

For production, see [Running as a service](#running-as-a-service) below to keep ShowPilot running on boot.

---

## Install — Linux (RHEL / Fedora / Rocky / Alma)

### 1. Install Node.js 20 LTS

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs gcc-c++ make
```

Verify:

```bash
node --version
npm --version
```

### 2. Install ShowPilot

```bash
sudo mkdir -p /opt/showpilot
sudo chown $USER:$USER /opt/showpilot
cd /opt/showpilot

curl -L https://github.com/ShowPilotFPP/ShowPilot/releases/latest/download/showpilot.tar.gz \
     -o showpilot.tar.gz
tar -xzf showpilot.tar.gz --strip-components=1
rm showpilot.tar.gz

npm install --omit=dev
```

### 3. Configure & run

Same as Debian/Ubuntu (sections 3 and 4 above).

If firewalld is enabled, you'll need to open port 3100:

```bash
sudo firewall-cmd --permanent --add-port=3100/tcp
sudo firewall-cmd --reload
```

---

## Install — macOS

Useful for development and testing on a Mac mini or laptop. Production typically runs on a Pi or VPS, but macOS works fine.

### 1. Install Node.js

The easiest path is [Homebrew](https://brew.sh):

```bash
brew install node@20
```

Or download the official installer from [nodejs.org](https://nodejs.org/en/download).

### 2. Install ShowPilot

```bash
mkdir -p ~/showpilot
cd ~/showpilot

curl -L https://github.com/ShowPilotFPP/ShowPilot/releases/latest/download/showpilot.tar.gz \
     -o showpilot.tar.gz
tar -xzf showpilot.tar.gz --strip-components=1
rm showpilot.tar.gz

npm install --omit=dev
```

### 3. Run it

```bash
npm start
```

Secrets auto-generate on first run. Optional: copy `config.example.js` to `config.js` if you want to customize ports, paths, or `trustProxy`.

Open `http://localhost:3100/admin`. Default login `admin` / `admin`.

To run as a background service, use `launchd` — see [Running as a service](#running-as-a-service) below.

---

## Install — Windows

Tested on Windows 10 and 11.

### 1. Install Node.js

Download the **LTS** installer from [nodejs.org](https://nodejs.org/en/download) and run it. Accept defaults — make sure "Automatically install the necessary tools" is checked (it installs build tools needed by `better-sqlite3`).

Open PowerShell and verify:

```powershell
node --version
npm --version
```

### 2. Install ShowPilot

Pick a folder (e.g. `C:\ShowPilot`):

```powershell
New-Item -ItemType Directory -Force -Path C:\ShowPilot
Set-Location C:\ShowPilot

# Download the latest release
Invoke-WebRequest -Uri https://github.com/ShowPilotFPP/ShowPilot/releases/latest/download/showpilot.tar.gz -OutFile showpilot.tar.gz

# Extract (Windows 10 1803+ has tar built in)
tar -xzf showpilot.tar.gz --strip-components=1
Remove-Item showpilot.tar.gz

npm install --omit=dev
```

### 3. Start it

```powershell
npm start
```

Secrets auto-generate on first run. Optional: `Copy-Item config.example.js config.js` if you want to customize ports, paths, or `trustProxy`.

Open `http://localhost:3100/admin`. Default login `admin` / `admin`.

If Windows Firewall prompts you, allow the Node.js process to communicate. To run as a Windows service, use [NSSM](https://nssm.cc/) — see [Running as a service](#running-as-a-service).

---

## Install — Docker

Multi-architecture images (amd64 + arm64) are published to GitHub Container Registry. Pull, configure, run — no build step required.

**Image:** `ghcr.io/showpilotfpp/showpilot:latest`
**Tags:** [browse all available tags](https://github.com/ShowPilotFPP/ShowPilot/pkgs/container/showpilot)

```bash
# Make a working directory
mkdir showpilot && cd showpilot

# Pull the image (this is what `docker compose up` will do automatically,
# but pulling explicitly first lets you confirm connectivity to GHCR)
docker pull ghcr.io/showpilotfpp/showpilot:latest

# Set up data directory (config.js is OPTIONAL — see below)
mkdir showpilot-data

# Download the compose file
curl -O https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot/main/docker-compose.yml.example
mv docker-compose.yml.example docker-compose.yml
# Edit if you need to change the port mapping
nano docker-compose.yml

# Start it
docker compose up -d

# Watch the logs as it boots — your auto-generated show token will be
# printed here on first run (you'll need it to configure the FPP plugin).
docker compose logs -f
```

Then open `http://<your-host>:3100/admin` and continue with [First-run setup](#first-run-setup).

**Optional: customize config.** ShowPilot works out of the box with default settings + auto-generated secrets. If you want to change ports, paths, or `trustProxy`:

```bash
mkdir showpilot-config
curl -O https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot/main/config.example.js
mv config.example.js showpilot-config/config.js
nano showpilot-config/config.js
# Then uncomment the config volume in docker-compose.yml
```

For Docker secrets / Kubernetes environments, you can inject `SHOWPILOT_JWT_SECRET` and `SHOWPILOT_SHOW_TOKEN` as environment variables and skip both `config.js` and the auto-generated secrets file entirely.

**Notes for Docker users:**

- The container runs as a non-root `node` user (UID 1000). If you bind-mount the data directory, make sure your host directory is writable by UID 1000 — `chown -R 1000:1000 showpilot-data` if needed.
- The data volume holds the SQLite database (`showpilot.db`) and cover-art uploads (`covers/`). Back this up regularly.
- For HTTPS, put the container behind your existing reverse proxy (Nginx Proxy Manager, Traefik, Caddy). HTTPS termination at the proxy is the supported pattern — no built-in TLS in the container.
- Updating: `docker compose pull && docker compose up -d`. Schema migrations run automatically on container start.
- Pin to a specific version by editing `image:` in `docker-compose.yml` from `:latest` to a specific tag like `:0.18.5`. See available tags at [ghcr.io/ShowPilotFPP/ShowPilot](https://github.com/ShowPilotFPP/ShowPilot/pkgs/container/showpilot).
- Want to build the image yourself instead of pulling? See the alternative `build:` block in `docker-compose.yml.example`.

---

## First-run setup

1. Open `http://<your-server-ip>:3100/admin`
2. Log in with `admin` / `admin`
3. **Change the default password** (you'll be prompted)
4. Go to **Plugin** tab → copy the **Show Token** (you'll paste this into FPP)
5. Optionally go to **Users** tab and add accounts for anyone else who needs admin access
6. Go to **Settings** tab → review jukebox/voting safeguards and configure **External Audio Access** if you want listeners outside your network to be able to hear the show
7. Configure your viewer page on the **Viewer Page** tab (use the default ShowPilot template or import the example template provided)

---

## Install the FPP plugin

The FPP plugin is what reports playback to ShowPilot, hands off requested sequences, and serves audio to viewers.

1. SSH into your FPP device (or open the FPP web UI's shell)
2. In FPP web UI, go to **Content Setup → Plugin Manager**
3. Click **Manual Install** (or follow the github URL flow)
4. Use the ShowPilot plugin URL: `https://github.com/ShowPilotFPP/ShowPilot-plugin`
5. After install, click **Configure** on the plugin in the plugin list
6. Fill in:
   - **ShowPilot URL**: `http://<your-showpilot-server-ip>:3100`
   - **Show token**: paste the token you copied from ShowPilot's Plugin tab
   - **Remote playlist**: the FPP playlist that contains your show sequences
   - **Interrupt schedule**: enable if you want viewer requests to interrupt the schedule
7. Click **Save**, then **Restart Listener**
8. Back in ShowPilot → **Plugin** tab, you should see the plugin go online (green dot in header) within ~30 seconds

If it doesn't connect, check the plugin log via FPP UI → Status → Logs → `showpilot_listener`.

---

## Configuration reference

`config.js` (created from `config.example.js`):

| Key | Default | Notes |
|-----|---------|-------|
| `port` | `3100` | TCP port to listen on |
| `host` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost only |
| `dbPath` | `./data/showpilot.db` | SQLite DB path. Created automatically. |
| `jwtSecret` | _CHANGE_ME_ | Used to sign session cookies. **Must be set to a random value.** |
| `sessionCookieName` | `showpilot_session` | Browser cookie name |
| `sessionDurationHours` | `720` (30 days) | Default session length when "remember me" is off; remember-me always extends to 30d |
| `showToken` | _CHANGE_ME_ | Shared secret between ShowPilot and FPP plugin |
| `viewer.activeWindowSeconds` | `30` | How recently a viewer must have heartbeat'd to count as "active" |
| `viewer.pollIntervalMs` | `5000` | Viewer page state poll fallback (when socket disconnects) |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

Most operational settings (jukebox depth, vote rules, viewer-page HTML, theme, snow effect, etc.) live in the **admin panel UI**, not in `config.js`.

---

## Running as a service

### Linux — systemd (recommended)

Create `/etc/systemd/system/showpilot.service`:

```ini
[Unit]
Description=ShowPilot
After=network.target

[Service]
Type=simple
User=showpilot
WorkingDirectory=/opt/showpilot
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Note:** `Restart=always` is required (not `Restart=on-failure`). ShowPilot's in-app updater exits cleanly (code 0) after downloading an update so the new code is picked up on restart — `on-failure` won't restart on a clean exit, leaving ShowPilot stopped after an update. If you have an existing install with `Restart=on-failure`, fix it with:
> ```bash
> sudo sed -i 's/Restart=on-failure/Restart=always/' /etc/systemd/system/showpilot.service
> sudo systemctl daemon-reload
> ```

Then:

```bash
# Create the service user
sudo useradd -r -s /bin/false -d /opt/showpilot showpilot
sudo chown -R showpilot:showpilot /opt/showpilot

sudo systemctl daemon-reload
sudo systemctl enable --now showpilot
sudo systemctl status showpilot

# View logs
sudo journalctl -u showpilot -f
```

### Linux — pm2 (alternative)

```bash
sudo npm install -g pm2
cd /opt/showpilot
pm2 start server.js --name showpilot
pm2 startup    # follow the printed instructions
pm2 save
```

### macOS — launchd

Create `~/Library/LaunchAgents/com.showpilot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.showpilot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOURNAME/showpilot/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOURNAME/showpilot</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOURNAME/showpilot/showpilot.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOURNAME/showpilot/showpilot.log</string>
</dict>
</plist>
```

Replace `YOURNAME` and the `node` path (find with `which node`). Then:

```bash
launchctl load ~/Library/LaunchAgents/com.showpilot.plist
```

### Windows — NSSM

[NSSM](https://nssm.cc/download) wraps any program as a Windows service.

```powershell
# Download and extract NSSM, then:
.\nssm.exe install ShowPilot
```

In the GUI that opens:
- **Path:** `C:\Program Files\nodejs\node.exe`
- **Startup directory:** `C:\ShowPilot`
- **Arguments:** `server.js`

Click **Install service**, then start it:

```powershell
nssm start ShowPilot
# Or in services.msc, find "ShowPilot" and start it
```

---

## Updating

### From a release tarball

```bash
cd /opt/showpilot
sudo systemctl stop showpilot    # or pm2 stop showpilot

# Backup first
cp -r data data.backup-$(date +%F)

# Get the new version
wget -O showpilot.tar.gz https://github.com/ShowPilotFPP/ShowPilot/releases/latest/download/showpilot.tar.gz
tar -xzf showpilot.tar.gz --strip-components=1
rm showpilot.tar.gz
npm install --omit=dev

sudo systemctl start showpilot
```

Database migrations run automatically on startup. Your config and data are preserved.

### From git

```bash
cd /opt/showpilot
git pull
npm install --omit=dev
sudo systemctl restart showpilot
```

---

## Backups

The whole application state lives in two places:
- `config.js` — your secrets and bind config
- `data/` directory — SQLite database, cover art images, viewer page templates

Back both up:

```bash
# Full backup
tar -czf showpilot-backup-$(date +%F).tar.gz config.js data/
```

Restore is just extracting the backup back into the install directory.

To dump just the SQLite DB for inspection or migration:

```bash
sqlite3 data/showpilot.db .dump > showpilot.sql
```

---

## Troubleshooting

### "Cannot connect to FPP plugin" / plugin shows offline

- Verify the `showToken` in `config.js` exactly matches what you entered in the FPP plugin config
- Check FPP can reach ShowPilot: `curl http://<showpilot-ip>:3100/api/plugin/state -H "remotetoken: YOUR_TOKEN"`
- Check the plugin log on FPP: web UI → **Status → Logs → showpilot_listener**
- Restart the plugin listener via the FPP web UI

### "Audio doesn't play for cellular listeners"

ShowPilot needs to be reachable from the public internet for off-network audio. Either:
- Set up a reverse proxy with a public domain, then enter that domain in **Settings → External Audio Access**
- Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for a domain without exposing your home IP

### "I forgot my admin password"

Reset directly in the database:

```bash
cd /opt/showpilot
sqlite3 data/showpilot.db "DELETE FROM users WHERE username='admin';"
# Then restart ShowPilot — it'll re-seed the default admin/admin user.
```

If you have a working admin account, just use the **Users** tab → **Reset PW** for any other user.

### "Port 3100 already in use"

Edit `config.js`, change `port` to something free (e.g. `3101`), restart.

### "permission denied" on `/opt/showpilot`

The service user (`showpilot` if following systemd setup) needs write access to `data/` for SQLite:

```bash
sudo chown -R showpilot:showpilot /opt/showpilot/data
```

### "Cover art doesn't show" / "wrong covers"

In admin → **Sequences**, click **Fetch Covers** to re-pull all sequence covers from iTunes. If a specific cover is wrong, click on it directly to upload or replace.

### Logs

```bash
# systemd
sudo journalctl -u showpilot -f --since "10 minutes ago"

# pm2
pm2 logs showpilot
```

---

## Project structure (for the curious)

```
showpilot/
├── server.js                # Express app + Socket.io server
├── config.js                # Your config (gitignored)
├── config.example.js        # Template config
├── package.json
├── lib/
│   ├── db.js                # SQLite schema, migrations, helpers
│   ├── viewer-renderer.js   # Server-side template rendering for the viewer page
│   ├── cover-art.js         # iTunes cover lookup, cache-busting
│   └── ...
├── routes/
│   ├── admin.js             # /api/admin/* endpoints
│   ├── viewer.js            # /api/viewer/* + audio streaming
│   └── plugin.js            # /api/plugin/* (FPP plugin talks here)
├── public/
│   ├── admin/               # Admin SPA
│   ├── viewer.html          # Default viewer page template
│   └── rf-compat.js         # Viewer-side audio player + visual effects
└── data/                    # SQLite + cover art (gitignored)
```

---

## License

MIT. Use it however you like — just don't blame me if your show breaks on Halloween night.

## Contributing

Issues and PRs welcome at https://github.com/ShowPilotFPP/ShowPilot

If you have ideas, find bugs, or want to share what your show looks like running on ShowPilot — please post in the xLights forum or open a GitHub issue.

---

**Have fun, and Merry Christmas / Happy Halloween / etc!** 🎄🎃🎆
