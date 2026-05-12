# ShowPilot Deployment Guide

End-to-end setup for running ShowPilot under git + PM2 with a one-command update flow.

## Initial install (one-time)

On the server (Linux LXC, VM, or bare metal):

```bash
# 1. Install Node.js 18+ if not present
# (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Install PM2 globally
sudo npm install -g pm2

# 3. Clone ShowPilot
sudo git clone https://github.com/ShowPilotFPP/ShowPilot.git /opt/showpilot
sudo chown -R $USER:$USER /opt/showpilot
cd /opt/showpilot

# 4. Install deps
npm install --omit=dev

# 5. Configure
cp config.example.js config.js
# Edit config.js. At minimum:
#   - Generate a random jwtSecret:   openssl rand -hex 32
#   - Generate a random showToken:   openssl rand -hex 24
nano config.js

# 6. Start with PM2
pm2 start server.js --name showpilot
pm2 save

# 7. Survive reboots
pm2 startup
# Run the command it prints (likely starts with `sudo env PATH=...`)
```

ShowPilot should now be reachable at `http://your-server:3100/admin/`.

## Migrating an existing install to git

If you already had ShowPilot installed via tarballs:

```bash
# Back it up first — paranoia
sudo mv /opt/showpilot /opt/showpilot.pre-git

# Stop existing
pkill -f "node server.js" 2>/dev/null

# Clone
sudo git clone https://github.com/ShowPilotFPP/ShowPilot.git /opt/showpilot
sudo chown -R $USER:$USER /opt/showpilot
cd /opt/showpilot
npm install --omit=dev

# Restore your config + database
cp /opt/showpilot.pre-git/config.js .
cp -r /opt/showpilot.pre-git/data .

# Start under PM2
pm2 start server.js --name showpilot
pm2 save
pm2 startup    # run the printed command
```

## Day-to-day deploys

After the initial setup, every update is:

```bash
cd /opt/showpilot
./deploy.sh
```

The script pulls, installs new deps if `package.json` changed, and reloads PM2 (zero downtime).

If you have SSH set up:
```bash
# From your dev machine, one-liner:
ssh user@showpilot-host 'cd /opt/showpilot && ./deploy.sh'
```

## Rolling back

If a deploy breaks something:

```bash
cd /opt/showpilot
git log --oneline -10           # find a good commit
git checkout <commit-sha>       # detached HEAD — fine for emergencies
npm install --omit=dev
pm2 reload showpilot
```

To get back to latest later: `git checkout main && ./deploy.sh`.

## Backing up

The two things you must back up:

```bash
# Config (contains your secrets)
cp /opt/showpilot/config.js ~/showpilot-backups/config.js.$(date +%F)

# Database
cp /opt/showpilot/data/showpilot.db ~/showpilot-backups/showpilot.db.$(date +%F)
```

Drop these into a cron job or your existing backup tooling. Recommended: nightly during show season.

## Logs

PM2 captures stdout/stderr automatically:

```bash
pm2 logs showpilot
pm2 logs showpilot --lines 200
pm2 logs showpilot --err           # errors only
```

## Stopping / starting

```bash
pm2 stop showpilot
pm2 start showpilot
pm2 restart showpilot       # full restart (~1s downtime)
pm2 reload showpilot        # zero-downtime reload (preferred)
pm2 delete showpilot        # remove from PM2 entirely
```
