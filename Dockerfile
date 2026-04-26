# ============================================================
# ShowPilot — Server Dockerfile
# ============================================================
# Two-stage build:
#   Stage 1 (builder) — installs build tools, compiles native deps
#                       (better-sqlite3, bcrypt). Heavy.
#   Stage 2 (runtime) — Alpine + Node + the compiled node_modules. Lean.
#
# Final image is roughly 130-150 MB. better-sqlite3 needs python3 + make +
# g++ at build time; we don't include them in the runtime image.
# ============================================================

# ---------- Stage 1: build native dependencies ----------
FROM node:20-alpine AS builder

# Build tools for better-sqlite3 / bcrypt native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Copy only manifests first so this layer caches across rebuilds when
# package.json hasn't changed. (Big deal — recompiling better-sqlite3 takes 30s+)
COPY package.json package-lock.json* ./

# Production install only — no devDependencies, no audit noise
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Stage 2: runtime ----------
FROM node:20-alpine

# Minimal runtime deps. tini is a tiny init that handles signals correctly —
# without it, SIGTERM from `docker stop` doesn't reach the Node process
# cleanly, and the container takes 10s to die instead of 1s.
RUN apk add --no-cache tini

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /build/node_modules ./node_modules

# Copy the application source
COPY . .

# Don't ship the example config or any local config that snuck in
RUN rm -f config.js config.example.js

# Data directory for SQLite + cover art uploads.
# Mark as a volume so users remember to mount it.
RUN mkdir -p /app/data /app/data/covers
VOLUME ["/app/data"]

# Run as non-root for safety. node:20-alpine ships a `node` user (UID 1000).
RUN chown -R node:node /app
USER node

# Default port — override with PORT env var in compose if needed
EXPOSE 3100

# Healthcheck — hits the /health endpoint which returns 200 OK once Node is
# accepting connections. The path is /health (not /api/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3100/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
