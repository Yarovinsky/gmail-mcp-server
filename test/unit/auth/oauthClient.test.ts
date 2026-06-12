import { describe, it, expect } from 'vitest';
import {
  OAuthClient,
  parseCredentialsJson,
  parseGrantedScopes,
  type OAuth2ClientLike,
  type OAuthDesktopCredentials,
} from '../../../src/auth/oauthClient.js';
import type { StoredToken } from '../../../src/auth/tokenStore.js';

const CREDS: OAuthDesktopCredentials = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUris: ['http://127.0.0.1'],
};

/** A fake OAuth2 client capturing calls and simulating refresh. */
function fakeFactory() {
  const created: OAuth2ClientLike[] = [];
  const factory = (_creds: OAuthDesktopCredentials, redirectUri: string): OAuth2ClientLike => {
    const client: OAuth2ClientLike = {
      credentials: {},
      generateAuthUrl: (opts) =>
        `https://auth.example/?redirect=${encodeURIComponent(redirectUri)}&scope=${(
          opts.scope as string[]
        ).join('+')}`,
      getToken: async (code) => ({
        tokens: {
          access_token: `AT-${code}`,
          refresh_token: 'RT',
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
          token_type: 'Bearer',
          expiry_date: 1000,
        },
      }),
      setCredentials(tokens) {
        this.credentials = { ...tokens };
      },
      getAccessToken: async function () {
        this.credentials = {
          ...this.credentials,
          access_token: 'AT-refreshed',
          expiry_date: 99999,
        };
        return { token: 'AT-refreshed' };
      },
      revokeToken: async () => ({}),
    };
    created.push(client);
    return client;
  };
  return { factory, created };
}

describe('parseCredentialsJson', () => {
  it('parses an installed (desktop) credentials object', () => {
    const r = parseCredentialsJson({
      installed: { client_id: 'a', client_secret: 'b', redirect_uris: ['http://127.0.0.1'] },
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        clientId: 'a',
        clientSecret: 'b',
        redirectUris: ['http://127.0.0.1'],
      });
  });

  it('parses a web credentials object', () => {
    const r = parseCredentialsJson({ web: { client_id: 'a', client_secret: 'b' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.clientId).toBe('a');
  });

  it('rejects missing client_id/secret with invalid_input', () => {
    expect(parseCredentialsJson({ installed: {} }).ok).toBe(false);
    expect(parseCredentialsJson(null).ok).toBe(false);
  });
});

describe('OAuthClient.requiresReauth (§9.4)', () => {
  it('forces re-auth when a newly requested scope is not granted', () => {
    const stored = 'https://www.googleapis.com/auth/gmail.readonly';
    expect(
      OAuthClient.requiresReauth(stored, ['https://www.googleapis.com/auth/gmail.readonly']),
    ).toBe(false);
    expect(
      OAuthClient.requiresReauth(stored, [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
      ]),
    ).toBe(true);
  });

  it('treats a missing stored scope as requiring re-auth', () => {
    expect(OAuthClient.requiresReauth(undefined, ['https://mail.google.com/'])).toBe(true);
  });
});

describe('OAuthClient token exchange and refresh (mocked)', () => {
  it('exchangeCode returns tokens from the client', async () => {
    const { factory } = fakeFactory();
    const client = new OAuthClient(CREDS, { createClient: factory });
    const r = await client.exchangeCode('CODE', 'http://127.0.0.1/cb');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.access_token).toBe('AT-CODE');
      expect(r.value.refresh_token).toBe('RT');
    }
  });

  it('refresh updates the access token and preserves the refresh token', async () => {
    const { factory } = fakeFactory();
    const client = new OAuthClient(CREDS, { createClient: factory });
    const stored: StoredToken = { refresh_token: 'RT', access_token: 'old', expiry_date: 1 };
    const r = await client.refresh(stored);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.access_token).toBe('AT-refreshed');
      expect(r.value.expiry_date).toBe(99999);
      expect(r.value.refresh_token).toBe('RT');
    }
  });

  it('refresh fails clearly when there is no refresh token', async () => {
    const { factory } = fakeFactory();
    const client = new OAuthClient(CREDS, { createClient: factory });
    const r = await client.refresh({ access_token: 'only-access' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_authenticated');
  });

  it('generateAuthUrl embeds the scopes and redirect URI', () => {
    const { factory } = fakeFactory();
    const client = new OAuthClient(CREDS, { createClient: factory });
    const url = client.generateAuthUrl(
      ['https://www.googleapis.com/auth/gmail.readonly'],
      'http://127.0.0.1:5/cb',
    );
    expect(url).toContain('gmail.readonly');
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:5/cb'));
  });
});

describe('parseGrantedScopes', () => {
  it('splits the space-separated scope string', () => {
    expect(parseGrantedScopes({ scope: 'a b  c' })).toEqual(['a', 'b', 'c']);
    expect(parseGrantedScopes({})).toEqual([]);
  });
});
