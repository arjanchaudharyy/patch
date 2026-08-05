/**
 * Bridge configuration: a persistent port + pairing token stored under the user's
 * home directory with locked-down permissions. The token is the shared secret the
 * browser extension must present to talk to the bridge.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

const DIR = join(homedir(), '.pagepatch');
const FILE = join(DIR, 'bridge.json');
const DEFAULT_PORT = 8787;

/** Load existing config or create a fresh one with a new random token. */
export function loadConfig() {
  const envPort = Number(process.env.PAGEPATCH_PORT);
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }

  let cfg = null;
  if (existsSync(FILE)) {
    try { cfg = JSON.parse(readFileSync(FILE, 'utf8')); } catch { cfg = null; }
  }
  if (!cfg || typeof cfg.token !== 'string' || cfg.token.length < 32) {
    cfg = { token: randomBytes(32).toString('hex'), port: DEFAULT_PORT, createdAt: new Date().toISOString() };
    save(cfg);
  }
  if (Number.isInteger(envPort) && envPort > 0) cfg.port = envPort;
  if (!Number.isInteger(cfg.port)) cfg.port = DEFAULT_PORT;
  return cfg;
}

function save(cfg) {
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch { /* ignore */ }
}

/** Persist config changes (e.g. a newly chosen free port). */
export function saveConfig(cfg) { save(cfg); }

/** Regenerate the token (invalidates any previously paired extension). */
export function rotateToken() {
  const cfg = loadConfig();
  cfg.token = randomBytes(32).toString('hex');
  save(cfg);
  return cfg;
}

export const CONFIG_PATH = FILE;
