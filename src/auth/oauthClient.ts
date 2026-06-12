/**
 * Google OAuth Desktop App client (HLD §9.1, §9.4).
 *
 * Loads desktop-app credentials from `~/.gmail-mcp/credentials.json`, runs the
 * loopback authorization flow, exchanges/refreshes tokens, and detects scope
 * changes that require re-authentication. The underlying OAuth2 client is
 * injectable so token exchange/refresh are unit-testable without network access.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';
import { google } from 'googleapis';
import { type AppResult, err, ok } from '../util/result.js';
import {
  appError,
  fromGmailApiError,
  internalError,
  notAuthenticatedError,
} from '../mcp/errors.js';
import type { Logger } from '../util/logger.js';
import type { StoredToken } from './tokenStore.js';

/** Parsed desktop-app OAuth credentials. */
export interface OAuthDesktopCredentials {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

/** The subset of the google OAuth2 client this module relies on. */
export interface OAuth2ClientLike {
  generateAuthUrl(opts: {
    access_type?: string;
    prompt?: string;
    scope?: string[] | string;
  }): string;
  getToken(code: string): Promise<{ tokens: StoredToken }>;
  setCredentials(tokens: StoredToken): void;
  getAccessToken(): Promise<{ token?: string | null }>;
  credentials: StoredToken;
  revokeToken?(token: string): Promise<unknown>;
}

export type CreateOAuth2Client = (
  credentials: OAuthDesktopCredentials,
  redirectUri: string,
) => OAuth2ClientLike;

export interface OAuthClientDeps {
  createClient?: CreateOAuth2Client;
  logger?: Logger;
}

function defaultCreateClient(
  creds: OAuthDesktopCredentials,
  redirectUri: string,
): OAuth2ClientLike {
  return new google.auth.OAuth2(
    creds.clientId,
    creds.clientSecret,
    redirectUri,
  ) as unknown as OAuth2ClientLike;
}

/** Parse a Google credentials.json object (supports `installed` and `web` keys). */
export function parseCredentialsJson(raw: unknown): AppResult<OAuthDesktopCredentials> {
  if (typeof raw !== 'object' || raw === null) {
    return err(appError('invalid_input', { message: 'credentials.json must be a JSON object.' }));
  }
  const root = raw as Record<string, unknown>;
  const node = (root.installed ?? root.web) as Record<string, unknown> | undefined;
  if (!node || typeof node !== 'object') {
    return err(
      appError('invalid_input', {
        message: 'credentials.json must contain an "installed" (desktop app) or "web" object.',
      }),
    );
  }
  const clientId = node.client_id;
  const clientSecret = node.client_secret;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    return err(
      appError('invalid_input', {
        message: 'credentials.json is missing client_id or client_secret.',
      }),
    );
  }
  const redirectUris = Array.isArray(node.redirect_uris)
    ? node.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  return ok({ clientId, clientSecret, redirectUris });
}

/** Load and parse desktop-app credentials from a file path (§9.1). */
export function loadCredentials(credentialsPath: string): AppResult<OAuthDesktopCredentials> {
  if (!fs.existsSync(credentialsPath)) {
    return err(
      appError('invalid_input', {
        message:
          `Google OAuth credentials not found at ${credentialsPath}. Create a Desktop App ` +
          'OAuth client in Google Cloud Console and save its credentials.json there.',
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (error) {
    return err(
      appError('invalid_input', {
        message: `credentials.json is not valid JSON: ${String(error)}`,
      }),
    );
  }
  return parseCredentialsJson(parsed);
}

/** Split a stored token's space-separated `scope` string into granted scope URIs. */
export function parseGrantedScopes(token: StoredToken): string[] {
  return (token.scope ?? '').split(/\s+/).filter((s) => s.length > 0);
}

export class OAuthClient {
  private readonly credentials: OAuthDesktopCredentials;
  private readonly deps: OAuthClientDeps;

  constructor(credentials: OAuthDesktopCredentials, deps: OAuthClientDeps = {}) {
    this.credentials = credentials;
    this.deps = deps;
  }

  private make(redirectUri: string): OAuth2ClientLike {
    return (this.deps.createClient ?? defaultCreateClient)(this.credentials, redirectUri);
  }

  private defaultRedirectUri(): string {
    return this.credentials.redirectUris[0] ?? 'http://127.0.0.1';
  }

  /**
   * Re-authentication is required when the requested scopes are not all covered
   * by the token's granted scopes (e.g. the user added a scope). Narrowing the
   * requested set does not force re-auth, since the token remains sufficient.
   */
  static requiresReauth(
    storedScope: string | undefined,
    requestedScopes: readonly string[],
  ): boolean {
    const granted = new Set((storedScope ?? '').split(/\s+/).filter((s) => s.length > 0));
    return requestedScopes.some((scope) => !granted.has(scope));
  }

  /** Build the consent URL (offline access + consent prompt to obtain a refresh token). */
  generateAuthUrl(scopes: readonly string[], redirectUri: string): string {
    return this.make(redirectUri).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...scopes],
    });
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<AppResult<StoredToken>> {
    try {
      const { tokens } = await this.make(redirectUri).getToken(code);
      return ok(tokens);
    } catch (error) {
      return err(fromGmailApiError(error));
    }
  }

  /** Refresh the access token using the stored refresh token. */
  async refresh(stored: StoredToken): Promise<AppResult<StoredToken>> {
    if (!stored.refresh_token) {
      return err(notAuthenticatedError('No refresh token available; re-authenticate.'));
    }
    try {
      const client = this.make(this.defaultRedirectUri());
      client.setCredentials(stored);
      await client.getAccessToken(); // refreshes if expired
      const merged: StoredToken = { ...stored, ...client.credentials };
      if (!merged.refresh_token) merged.refresh_token = stored.refresh_token;
      return ok(merged);
    } catch (error) {
      return err(fromGmailApiError(error));
    }
  }

  /**
   * Fetch the authenticated mailbox's email address via Gmail `users.getProfile`.
   * Used by `auth login` to capture the email for `auth status`. Only meaningful
   * with the real google client; tests inject the email fetcher instead.
   */
  async getProfileEmail(token: StoredToken): Promise<AppResult<string>> {
    try {
      const client = this.make(this.defaultRedirectUri());
      client.setCredentials(token);
      const gmail = google.gmail({
        version: 'v1',
        auth: client as unknown as InstanceType<typeof google.auth.OAuth2>,
      });
      const response = await gmail.users.getProfile({ userId: 'me' });
      const email = response.data.emailAddress;
      if (!email) {
        return err(
          appError('gmail_api_error', { message: 'Gmail profile returned no email address.' }),
        );
      }
      return ok(email);
    } catch (error) {
      return err(fromGmailApiError(error));
    }
  }

  /** Revoke a token with Google (best effort). */
  async revoke(token: StoredToken): Promise<AppResult<void>> {
    const value = token.access_token ?? token.refresh_token;
    if (!value) return ok(undefined);
    try {
      const client = this.make(this.defaultRedirectUri());
      if (client.revokeToken) await client.revokeToken(value);
      return ok(undefined);
    } catch (error) {
      return err(fromGmailApiError(error));
    }
  }

  /**
   * Run the interactive loopback login: start a localhost server on a random
   * port, open the consent URL in the browser, capture the redirect's code, and
   * exchange it for tokens. Used by `auth login` (Step 3.5).
   */
  async loginInteractive(
    scopes: readonly string[],
    options: {
      openBrowser?: (url: string) => Promise<unknown>;
      timeoutMs?: number;
      onUrl?: (url: string) => void;
    } = {},
  ): Promise<AppResult<StoredToken>> {
    const openBrowser = options.openBrowser ?? ((url: string) => open(url));
    const timeoutMs = options.timeoutMs ?? 300_000;
    const logger = this.deps.logger;

    return new Promise<AppResult<StoredToken>>((resolve) => {
      let settled = false;
      let port = 0;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/oauth2callback')) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const errorParam = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (errorParam) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<p>Authorization failed: ${errorParam}. You can close this window.</p>`);
          finish(
            err(appError('not_authenticated', { message: `Authorization failed: ${errorParam}` })),
          );
          return;
        }
        if (!code) {
          res.writeHead(400);
          res.end('Missing authorization code');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<p>Authentication complete. You can close this window and return to the terminal.</p>',
        );
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        this.exchangeCode(code, redirectUri)
          .then(finish)
          .catch((e) => {
            finish(err(internalError('Token exchange failed.', e)));
          });
      });

      const timer = setTimeout(() => {
        finish(
          err(appError('internal_error', { message: 'Timed out waiting for the OAuth redirect.' })),
        );
      }, timeoutMs);
      timer.unref?.();

      function finish(result: AppResult<StoredToken>): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve(result);
      }

      server.on('error', (e) => finish(err(internalError('Loopback server error.', e))));
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const authUrl = this.generateAuthUrl(scopes, redirectUri);
        logger?.info({ port }, 'Waiting for OAuth redirect on loopback.');
        if (options.onUrl) options.onUrl(authUrl);
        void openBrowser(authUrl).catch(() => {
          // The user can open the URL manually if the browser does not launch.
        });
      });
    });
  }
}
