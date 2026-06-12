import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authLogin,
  authLogout,
  authRevoke,
  authStatus,
  type AuthIo,
  type OAuthLike,
} from '../../../src/auth/authCommands.js';
import { TokenStore, type StoredToken } from '../../../src/auth/tokenStore.js';
import { ok, err, type AppResult } from '../../../src/util/result.js';
import { appError } from '../../../src/mcp/errors.js';

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

/** Secret token values that must NEVER appear in any output. */
const ACCESS = 'ya29.SUPERSECRET-ACCESS';
const REFRESH = '1//0gSUPERSECRET-REFRESH';

function makeToken(extra: Partial<StoredToken> = {}): StoredToken {
  return {
    access_token: ACCESS,
    refresh_token: REFRESH,
    scope: READONLY,
    token_type: 'Bearer',
    expiry_date: 123456789,
    ...extra,
  };
}

/** Capture out/err lines and expose helpers to assert on the combined text. */
function makeIo(): AuthIo & { all: () => string; outText: () => string } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
    all: () => [...outLines, ...errLines].join('\n'),
    outText: () => outLines.join('\n'),
  };
}

/** A fake OAuth client recording calls; returns a fixed login token. */
function makeOAuth(overrides: Partial<OAuthLike> = {}): OAuthLike & {
  loginCalls: number;
  revokeCalls: number;
} {
  const state = { loginCalls: 0, revokeCalls: 0 };
  const fake: OAuthLike & { loginCalls: number; revokeCalls: number } = {
    get loginCalls() {
      return state.loginCalls;
    },
    get revokeCalls() {
      return state.revokeCalls;
    },
    loginInteractive: async () => {
      state.loginCalls += 1;
      return ok(makeToken());
    },
    revoke: async () => {
      state.revokeCalls += 1;
      return ok(undefined);
    },
    ...overrides,
  };
  return fake;
}

let tokensDir: string;
let store: TokenStore;

beforeEach(() => {
  tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-authcmd-'));
  store = new TokenStore({ tokensDir });
});

afterEach(() => {
  fs.rmSync(tokensDir, { recursive: true, force: true });
});

describe('authLogin', () => {
  it('persists the token, captures the email, and prints email + scopes', async () => {
    const io = makeIo();
    const oauth = makeOAuth();
    const code = await authLogin({
      oauth,
      store,
      profile: 'default',
      scopes: [READONLY],
      io,
      fetchEmail: async () => ok('user@example.com'),
    });

    expect(code).toBe(0);
    expect(oauth.loginCalls).toBe(1);

    const loaded = store.load('default');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.email).toBe('user@example.com');
      expect(loaded.value.refresh_token).toBe(REFRESH);
    }

    const out = io.outText();
    expect(out).toContain('user@example.com');
    expect(out).toContain(READONLY);
  });

  it('never prints token values', async () => {
    const io = makeIo();
    const code = await authLogin({
      oauth: makeOAuth(),
      store,
      profile: 'default',
      scopes: [READONLY],
      io,
      fetchEmail: async () => ok('user@example.com'),
    });
    expect(code).toBe(0);
    const all = io.all();
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
  });

  it('still succeeds (without email) when the email fetch fails', async () => {
    const io = makeIo();
    const code = await authLogin({
      oauth: makeOAuth(),
      store,
      profile: 'default',
      scopes: [READONLY],
      io,
      fetchEmail: async () => err(appError('gmail_api_error', { message: 'no profile' })),
    });
    expect(code).toBe(0);
    const loaded = store.load('default');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.email).toBeUndefined();
    expect(io.all()).toContain('could not fetch mailbox email');
  });

  it('returns 1 and saves nothing when the login flow fails', async () => {
    const io = makeIo();
    const oauth = makeOAuth({
      loginInteractive: async (): Promise<AppResult<StoredToken>> =>
        err(appError('not_authenticated', { message: 'user cancelled' })),
    });
    const code = await authLogin({
      oauth,
      store,
      profile: 'default',
      scopes: [READONLY],
      io,
    });
    expect(code).toBe(1);
    expect(store.exists('default')).toBe(false);
    expect(io.all()).toContain('Login failed');
  });
});

describe('authStatus', () => {
  it('prints the authenticated email and granted scopes (§26.2)', () => {
    store.save('default', makeToken({ email: 'user@example.com' }));
    const io = makeIo();
    const code = authStatus({ store, profile: 'default', io });
    expect(code).toBe(0);
    const out = io.outText();
    expect(out).toContain('user@example.com');
    expect(out).toContain(READONLY);
  });

  it('never prints token values', () => {
    store.save('default', makeToken({ email: 'user@example.com' }));
    const io = makeIo();
    authStatus({ store, profile: 'default', io });
    const all = io.all();
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
  });

  it('returns 1 with not_authenticated when no token is stored', () => {
    const io = makeIo();
    const code = authStatus({ store, profile: 'default', io });
    expect(code).toBe(1);
    expect(io.all()).toMatch(/auth login/);
  });
});

describe('authLogout', () => {
  it('removes the stored token and is idempotent', () => {
    store.save('default', makeToken());
    expect(store.exists('default')).toBe(true);

    const io = makeIo();
    expect(authLogout({ store, profile: 'default', io })).toBe(0);
    expect(store.exists('default')).toBe(false);

    // No token left: still succeeds.
    expect(authLogout({ store, profile: 'default', io })).toBe(0);
    expect(io.outText()).toContain('Logged out');
  });
});

describe('authRevoke', () => {
  it('attempts Google revocation, then removes the local token', async () => {
    store.save('default', makeToken());
    const io = makeIo();
    const oauth = makeOAuth();

    const code = await authRevoke({ store, oauth, profile: 'default', io });
    expect(code).toBe(0);
    expect(oauth.revokeCalls).toBe(1);
    expect(store.exists('default')).toBe(false);
    expect(io.outText()).toContain('Revoked tokens with Google');
  });

  it('still removes the local token when Google revocation fails', async () => {
    store.save('default', makeToken());
    const io = makeIo();
    const oauth = makeOAuth({
      revoke: async (): Promise<AppResult<void>> =>
        err(appError('network_error', { message: 'offline' })),
    });

    const code = await authRevoke({ store, oauth, profile: 'default', io });
    expect(code).toBe(0);
    expect(store.exists('default')).toBe(false);
    expect(io.all()).toContain('revocation failed');
  });

  it('skips revocation when there is no stored token but still succeeds', async () => {
    const io = makeIo();
    const oauth = makeOAuth();
    const code = await authRevoke({ store, oauth, profile: 'default', io });
    expect(code).toBe(0);
    expect(oauth.revokeCalls).toBe(0);
    expect(io.all()).toContain('No stored token');
  });

  it('never prints token values', async () => {
    store.save('default', makeToken());
    const io = makeIo();
    await authRevoke({ store, oauth: makeOAuth(), profile: 'default', io });
    const all = io.all();
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
  });
});
