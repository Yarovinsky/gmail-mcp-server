/**
 * OAuth token persistence (HLD §9.1, §16.4). Tokens are stored per profile at
 * `<tokensDir>/<profile>.json` with restrictive permissions (0600 file / 0700
 * dir where the platform supports it). Token VALUES are never logged — only
 * metadata (profile, path, whether a refresh token is present). A token file with
 * group/other-readable POSIX permissions triggers a warning.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type AppResult, ok } from '../util/result.js';
import { appError, notAuthenticatedError } from '../mcp/errors.js';
import type { Logger } from '../util/logger.js';

/**
 * Stored OAuth credentials (mirrors google-auth-library `Credentials`), plus an
 * optional `email` we capture at login time so `auth status` can show the
 * authenticated mailbox offline. Unknown fields are ignored by the google client.
 */
export interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  id_token?: string;
  /** Authenticated mailbox address, captured at login (not a Google field). */
  email?: string;
}

export interface TokenStoreOptions {
  tokensDir: string;
  logger?: Logger;
}

/** A POSIX mode is "too permissive" if any group or other bit is set. */
export function isPermissivePosixMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Emit a warning (and return true) when `mode` grants group/other access. Pure
 * and platform-independent so the decision is testable everywhere; the FS-backed
 * caller only invokes it on non-Windows where POSIX modes are meaningful.
 */
export function permissionWarning(mode: number, file: string, logger?: Logger): boolean {
  if (!isPermissivePosixMode(mode)) return false;
  logger?.warn(
    { path: file, mode: (mode & 0o777).toString(8) },
    'Token file permissions are too permissive; tighten to 0600.',
  );
  return true;
}

/** Derive the tokens directory from a configured token file path (§9.1). */
export function tokensDirFromTokenPath(tokenPath: string): string {
  return path.dirname(tokenPath);
}

export class TokenStore {
  private readonly tokensDir: string;
  private readonly logger: Logger | undefined;

  constructor(options: TokenStoreOptions) {
    this.tokensDir = options.tokensDir;
    this.logger = options.logger;
  }

  tokenPath(profile: string): string {
    return path.join(this.tokensDir, `${profile}.json`);
  }

  exists(profile: string): boolean {
    return fs.existsSync(this.tokenPath(profile));
  }

  /** Load a profile's token, or a clear `not_authenticated` error if missing. */
  load(profile: string): AppResult<StoredToken> {
    const file = this.tokenPath(profile);
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        error: notAuthenticatedError(
          `No saved token for profile "${profile}". Run \`gmail-mcp-server auth login\` first.`,
        ),
      };
    }
    this.warnIfPermissive(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return {
        ok: false,
        error: appError('internal_error', {
          message: `Failed to read token file: ${String(error)}`,
        }),
      };
    }
    try {
      return ok(JSON.parse(text) as StoredToken);
    } catch (error) {
      return {
        ok: false,
        error: appError('invalid_input', {
          message: `Token file ${file} is corrupt: ${String(error)}`,
        }),
      };
    }
  }

  /** Persist a profile's token with restrictive permissions. */
  save(profile: string, token: StoredToken): AppResult<void> {
    const file = this.tokenPath(profile);
    try {
      fs.mkdirSync(this.tokensDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best effort: Windows and some filesystems ignore POSIX modes
      }
      // Never log token values — only non-sensitive metadata.
      this.logger?.info(
        { profile, path: file, hasRefreshToken: Boolean(token.refresh_token) },
        'Saved OAuth token.',
      );
      return ok(undefined);
    } catch (error) {
      return {
        ok: false,
        error: appError('internal_error', {
          message: `Failed to write token file: ${String(error)}`,
        }),
      };
    }
  }

  /** Delete a profile's token (no error if it does not exist). */
  delete(profile: string): AppResult<void> {
    const file = this.tokenPath(profile);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return ok(undefined);
    } catch (error) {
      return {
        ok: false,
        error: appError('internal_error', {
          message: `Failed to delete token file: ${String(error)}`,
        }),
      };
    }
  }

  private warnIfPermissive(file: string): void {
    if (process.platform === 'win32') return; // POSIX modes are not meaningful on Windows
    try {
      permissionWarning(fs.statSync(file).mode, file, this.logger);
    } catch {
      // ignore stat failures
    }
  }
}
