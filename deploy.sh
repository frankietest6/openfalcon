#!/bin/bash
# ============================================================
# ShowPilot — Deploy Script
# Run on the server (e.g. /opt/showpilot) to update to latest.
# ============================================================
set -e

cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}→ Pulling latest from git...${NC}"
git pull

echo -e "${YELLOW}→ Installing/updating dependencies...${NC}"
npm install --omit=dev

# Install ffmpeg for audio transcoding (AAC/M4A for clean seeking)
if ! command -v ffmpeg &>/dev/null; then
  echo "Installing ffmpeg..."
  apt-get install -y ffmpeg 2>/dev/null || echo "WARN: ffmpeg install failed — audio will serve as MP3"
fi

# Reload via PM2 if it's managing the process; otherwise tell the user
if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q showpilot; then
  echo -e "${YELLOW}→ Reloading showpilot (PM2)...${NC}"
  pm2 reload showpilot
  echo
  pm2 list | grep showpilot || true
else
  echo -e "${YELLOW}⚠ PM2 not managing showpilot. Restart the server manually.${NC}"
fi

echo
echo -e "${GREEN}✓ Deploy complete.${NC}"
