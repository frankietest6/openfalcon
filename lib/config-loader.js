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
// Usage:
//   const config = require('./lib/config-loader');   // from server.js
//   const config = require('./config-loader');        // from inside lib/
//   const config = require('../lib/config-loader');   // from routes/
// ============================================================

const path = require('path');
const fs = require('fs');

// We resolve config relative to the project root (one directory up from
// this file's location, since this lives in lib/).
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.js');
const examplePath = path.join(projectRoot, 'config.example.js');

let config;
let warningPrinted = false;

if (fs.existsSync(configPath)) {
  // Normal path: user has a real config.js with their secrets.
  config = require(configPath);
} else if (fs.existsSync(examplePath)) {
  // Fallback path: only the example file is present.
  // Print warning ONCE per process (not once per require) — multiple
  // modules will load this file via Node's module cache, but the very
  // first import is the one that gets here.
  if (!warningPrinted) {
    console.warn('');
    console.warn('==============================================================');
    console.warn('  WARNING: config.js not found — using config.example.js');
    console.warn('  ');
    console.warn('  This is fine for a quick test, but the server is running');
    console.warn('  with DEFAULT secrets that anyone with the source code knows.');
    console.warn('  ');
    console.warn('  Before exposing this to real users:');
    console.warn('    cp config.example.js config.js');
    console.warn('    edit config.js — change jwtSecret and showToken to');
    console.warn('    long random strings (try `openssl rand -hex 32`)');
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

module.exports = config;
