/**
 * Path helpers for config: `~` expansion (§15.1 step 1) and the config file
 * locations (§10). Kept separate from `loadConfig` so the path-guard (Step 5.1)
 * and other modules can reuse `expandHome` without importing the loader.
 */

import os from 'node:os';
import path from 'node:path';
import type { Config } from './configSchema.js';

/**
 * Expand a leading `~` (optionally `~/` or `~\`) to the user's home directory.
 * Anything else is returned unchanged. A bare `~` maps to the home dir itself.
 */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/** Default home config path: `~/.gmail-mcp/config.json` (§10). */
export function homeConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.gmail-mcp', 'config.json');
}

/** Project-local config override path: `./.gmail-mcp.json` (§10). */
export function projectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.gmail-mcp.json');
}

/**
 * Return a copy of `config` with every path-valued key `~`-expanded (§15.1):
 * `oauth.credentialsPath`, `oauth.tokenPath`, `downloads.rootDir`, and
 * `logging.auditLogPath`.
 */
export function expandConfigPaths(config: Config, home: string = os.homedir()): Config {
  return {
    ...config,
    oauth: {
      ...config.oauth,
      credentialsPath: expandHome(config.oauth.credentialsPath, home),
      tokenPath: expandHome(config.oauth.tokenPath, home),
    },
    downloads: {
      ...config.downloads,
      rootDir: expandHome(config.downloads.rootDir, home),
    },
    logging: {
      ...config.logging,
      auditLogPath: expandHome(config.logging.auditLogPath, home),
    },
  };
}
