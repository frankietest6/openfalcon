// ============================================================
// ShowPilot — Config Loader
// ============================================================
// Centralized config loading with graceful fallback to config.example.js.
//
// Every module that needs config requires THIS file instead of './config'
// directly. That way the fallback logic lives in exactly one place — if
// config.js doesn't exist (e.g. fresh Docker container before a config
// volume is mounted, or a smoke test), we fall back to config.example.js
// with a clear warning. If neither exists, we exit with a useful error.
//
// On top of that, this loader resolves the two security-critical secrets
// (jwtSecret and showToken) via lib/secret-store.js, which handles
// auto-generation, env-var overrides, and persistence. By the time anyone
// reads `config.jwtSecret` or `config.showToken`, they get a real value
// regardless of whether the user edited config.js.
//
// Usage:
//   const config = require('./lib/config-loader');   // from server.js
//   const config = require('./config-loader');        // from inside lib/
//   const config = require('../lib/config-loader');   // from routes/
// ============================================================

const path = require('path');
const fs = require('fs');
const { resolveSecrets } = require('./secret-store');

// We resolve config relative to the project root (one directory up from
// this file's location, since this lives in lib/).
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.js');
const examplePath = path.join(projectRoot, 'config.example.js');

let config;
let warningPrinted = false;

if (fs.existsSync(configPath)) {
  // Normal path: user has a real config.js.
  config = require(configPath);
} else if (fs.existsSync(examplePath)) {
  // Fallback path: only the example file is present. This is the common
  // first-run state for fresh Docker installs (config.js not yet written),
  // or for users who just cloned the repo and haven't done any setup.
  if (!warningPrinted) {
    console.warn('');
    console.warn('==============================================================');
    console.warn('  config.js not found — using config.example.js defaults.');
    console.warn('  ');
    console.warn('  Secrets (jwtSecret, showToken) will be auto-generated on');
    console.warn('  first run and persisted to data/secrets.json. To override,');
    console.warn('  copy config.example.js to config.js and edit it, or set');
    console.warn('  the SHOWPILOT_JWT_SECRET / SHOWPILOT_SHOW_TOKEN env vars.');
    console.warn('==============================================================');
    console.warn('');
    warningPrinted = true;
  }
  config = require(examplePath);
} else {
  console.error('FATAL: neither config.js nor config.example.js found in project root.');
  console.error('Cannot start. Restore config.example.js from the repo or create config.js.');
  process.exit(1);
}

// ============================================================
// Secret resolution — happens once, at first require()
// ============================================================
// Mutate the config object so downstream code can keep reading
// `config.jwtSecret` and `config.showToken` exactly as before. The
// secret-store module decides where each value actually comes from:
// env > real config.js value > data/secrets.json > auto-generate.
const resolved = resolveSecrets(config, projectRoot);
config.jwtSecret = resolved.jwtSecret;
config.showToken = resolved.showToken;

// One-time announcement of where secrets came from. We print this only on
// the very first require() (Node module cache ensures that), and only when
// auto-generation actually happened — otherwise the noise isn't useful.
if (resolved.generatedThisRun) {
  console.log('');
  console.log('==============================================================');
  console.log('  🔐  Auto-generated secrets on first run');
  console.log('==============================================================');
  console.log(`  Persisted to: ${resolved.secretsPath}`);
  console.log('');
  if (resolved.sources.showToken === 'generated') {
    console.log('  📋  Show Token (paste into your FPP plugin config):');
    console.log('');
    console.log(`        ${config.showToken}`);
    console.log('');
    console.log('  You can also retrieve this anytime in the admin UI');
    console.log('  under Settings → Plugin → Show Token.');
  }
  console.log('==============================================================');
  console.log('');
} else {
  // Quieter line for normal startups — useful for debugging where secrets
  // came from when something seems off (wrong jwt, plugin auth failing).
  // Nothing sensitive — just labels.
  console.log(`[secret-store] jwtSecret source: ${resolved.sources.jwtSecret}, showToken source: ${resolved.sources.showToken}`);
}

module.exports = config;
