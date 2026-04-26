// ============================================================
// ShowPilot — Configuration
// All config values live at the top for easy editing.
// ============================================================

module.exports = {
  // Server
  port: 3100,
  host: '0.0.0.0',

  // ============================================================
  // Reverse proxy / "trust proxy"
  // ============================================================
  // ShowPilot uses the client IP for several things: rate limiting login
  // attempts, blocking abusive viewers, and recording visitor analytics.
  // It's important the IP is real, not spoofed.
  //
  // - If you run ShowPilot directly exposed (port-forward, no proxy):
  //     trustProxy: false
  //   This makes Express ignore X-Forwarded-For headers entirely, so an
  //   attacker can't fake their IP by setting that header.
  //
  // - If you run ShowPilot behind a reverse proxy you control (Nginx
  //   Proxy Manager, Caddy, Traefik, Cloudflare Tunnel, etc.):
  //     trustProxy: 1
  //   This trusts X-Forwarded-For from exactly one upstream hop. Almost
  //   always correct for typical deployments — your proxy is the only thing
  //   that should be setting that header.
  //
  // - If you have a chain of proxies (CDN → load balancer → app):
  //     trustProxy: 2     // trust 2 hops
  //
  // - For CIDR-based trust (rarely needed):
  //     trustProxy: 'loopback, 192.168.0.0/16'
  //
  // Default: false (most secure — assume direct exposure).
  trustProxy: false,

  // Database
  dbPath: './data/showpilot.db',

  // Auth
  jwtSecret: 'CHANGE_ME_BEFORE_RUNNING_IN_PROD',
  sessionCookieName: 'showpilot_session',
  sessionDurationHours: 24 * 30, // 30 days

  // Show token — what the FPP plugin uses in its `remotetoken` header.
  // You paste this value into the plugin config on FPP.
  // Generate a random one on first run if not set.
  showToken: 'CHANGE_ME_TO_A_RANDOM_STRING',

  // Viewer behavior
  viewer: {
    // How long a viewer heartbeat is considered "active" (seconds)
    activeWindowSeconds: 30,
    // How often viewer page polls for state updates (ms) as a fallback if socket fails
    pollIntervalMs: 5000,
    // Max jukebox requests per viewer token per night
    maxJukeboxRequestsPerViewer: 1,
    // Max votes per viewer per voting round
    maxVotesPerRound: 1,
  },

  // Voting round behavior
  voting: {
    // Auto-reset votes after the winner plays? (typical setup)
    resetAfterWinnerPlays: true,
  },

  // Logging
  logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
};
