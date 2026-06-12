/**
 * Auth CLI command logic (HLD §9.2, §9.4, §26.2). These functions orchestrate the
 * OAuth client and token store for the `auth login | status | logout | revoke`
 * subcommands wired into `cli.ts`. All collaborators (OAuth client, token store,
 * IO writers, email fetcher) are injected so the flows are unit-testable without
 * touching the network, a browser, or the real home directory.
 *
 * Invariant (§16.4, §26.2): token VALUES are never written to output or logs. The
 * commands print only the authenticated email, granted scope URIs, and metadata.
 */

import type { AppResult } from '../util/result.js';
import { parseGrantedScopes } from './oauthClient.js';
import type { StoredToken, TokenStore } from './tokenStore.js';

/** User-facing IO writers (stdout for results, stderr for status/diagnostics). */
export interface AuthIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The subset of `OAuthClient` the auth commands use. Declared structurally so
 * tests can supply a fake without a real Google client; `OAuthClient` satisfies it.
 */
export interface OAuthLike {
  loginInteractive(
    scopes: readonly string[],
    options?: {
      openBrowser?: (url: string) => Promise<unknown>;
      onUrl?: (url: string) => void;
      timeoutMs?: number;
    },
  ): Promise<AppResult<StoredToken>>;
  revoke(token: StoredToken): Promise<AppResult<void>>;
}

/** Format the granted scopes for display, or a placeholder when none are reported. */
function formatScopes(token: StoredToken): string[] {
  const scopes = parseGrantedScopes(token);
  return scopes.length > 0 ? scopes : [];
}

/**
 * `auth login [--scope-profile <name>]` (§9.2). Runs the interactive loopback
 * flow for the requested scopes, captures the mailbox email (best effort), and
 * persists the token. Prints the authenticated email and granted scopes; never
 * prints the token itself.
 */
export async function authLogin(args: {
  oauth: OAuthLike;
  store: TokenStore;
  profile: string;
  scopes: string[];
  io: AuthIo;
  /** Resolve the mailbox email from a fresh token (Gmail `users.getProfile`). */
  fetchEmail?: (token: StoredToken) => Promise<AppResult<string>>;
  openBrowser?: (url: string) => Promise<unknown>;
}): Promise<number> {
  const { oauth, store, profile, scopes, io } = args;
  io.err(`Starting OAuth login for profile "${profile}" (${scopes.length} scope(s))...`);

  const loginOptions: Parameters<OAuthLike['loginInteractive']>[1] = {
    onUrl: (url) => io.err(`If your browser did not open automatically, visit:\n${url}`),
  };
  if (args.openBrowser) loginOptions.openBrowser = args.openBrowser;

  const result = await oauth.loginInteractive(scopes, loginOptions);
  if (!result.ok) {
    io.err(`Login failed: ${result.error.message}`);
    return 1;
  }

  let token = result.value;
  if (args.fetchEmail) {
    const emailRes = await args.fetchEmail(token);
    if (emailRes.ok) {
      token = { ...token, email: emailRes.value };
    } else {
      io.err(`Note: could not fetch mailbox email (${emailRes.error.message}).`);
    }
  }

  const saved = store.save(profile, token);
  if (!saved.ok) {
    io.err(`Failed to save token: ${saved.error.message}`);
    return 1;
  }

  io.out(`Authenticated${token.email ? ` as ${token.email}` : ''} (profile "${profile}").`);
  const scopeList = formatScopes(token);
  io.out(`Granted scopes:${scopeList.length === 0 ? ' (none reported)' : ''}`);
  for (const scope of scopeList) io.out(`  - ${scope}`);
  return 0;
}

/**
 * `auth status` (§9.4, §26.2). Prints the authenticated email and granted scopes
 * from the stored token (captured at login). Offline — no network call.
 */
export function authStatus(args: { store: TokenStore; profile: string; io: AuthIo }): number {
  const { store, profile, io } = args;
  const loaded = store.load(profile);
  if (!loaded.ok) {
    io.err(loaded.error.message);
    return 1;
  }
  const token = loaded.value;

  io.out(`Profile: ${profile}`);
  io.out(`Email: ${token.email ?? '(unknown — re-run `auth login` to capture it)'}`);
  io.out(`Has refresh token: ${token.refresh_token ? 'yes' : 'no'}`);
  const scopeList = formatScopes(token);
  io.out(`Granted scopes:${scopeList.length === 0 ? ' (none reported)' : ''}`);
  for (const scope of scopeList) io.out(`  - ${scope}`);
  return 0;
}

/**
 * `auth logout` (§9.4). Deletes the locally stored token for the active profile.
 * Idempotent: succeeds even if no token is present.
 */
export function authLogout(args: { store: TokenStore; profile: string; io: AuthIo }): number {
  const { store, profile, io } = args;
  const result = store.delete(profile);
  if (!result.ok) {
    io.err(`Failed to remove token: ${result.error.message}`);
    return 1;
  }
  io.out(`Logged out: removed stored tokens for profile "${profile}".`);
  return 0;
}

/**
 * `auth revoke` (§9.4). Attempts Google token revocation, then deletes the local
 * token regardless of the revocation outcome (best effort, as the local token must
 * not be left behind). Reports a warning if Google revocation fails.
 */
export async function authRevoke(args: {
  store: TokenStore;
  oauth: OAuthLike;
  profile: string;
  io: AuthIo;
}): Promise<number> {
  const { store, oauth, profile, io } = args;
  const loaded = store.load(profile);
  if (loaded.ok) {
    const revoked = await oauth.revoke(loaded.value);
    if (revoked.ok) io.out('Revoked tokens with Google.');
    else io.err(`Warning: Google token revocation failed: ${revoked.error.message}`);
  } else {
    io.err('No stored token found; skipping Google revocation.');
  }

  const deleted = store.delete(profile);
  if (!deleted.ok) {
    io.err(`Failed to remove token: ${deleted.error.message}`);
    return 1;
  }
  io.out(`Removed stored tokens for profile "${profile}".`);
  return 0;
}
