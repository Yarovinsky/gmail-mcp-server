import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TokenStore,
  isPermissivePosixMode,
  permissionWarning,
  tokensDirFromTokenPath,
  type StoredToken,
} from '../../../src/auth/tokenStore.js';
import { createLogger } from '../../../src/util/logger.js';

let tokensDir: string;

function collector(): { write: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { write: (s) => lines.push(s), text: () => lines.join('') };
}

beforeEach(() => {
  tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-tokens-'));
});

afterEach(() => {
  fs.rmSync(tokensDir, { recursive: true, force: true });
});

describe('TokenStore round-trip', () => {
  it('saves and loads a token per profile', () => {
    const store = new TokenStore({ tokensDir });
    const token: StoredToken = {
      access_token: 'ya29.fake',
      refresh_token: '1//fake',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      expiry_date: 123456789,
    };
    expect(store.save('default', token).ok).toBe(true);
    expect(store.save('work', { refresh_token: '1//work' }).ok).toBe(true);

    const loaded = store.load('default');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(token);

    const work = store.load('work');
    expect(work.ok).toBe(true);
    if (work.ok) expect(work.value.refresh_token).toBe('1//work');
  });

  it('reports not_authenticated for a missing token', () => {
    const store = new TokenStore({ tokensDir });
    const r = store.load('absent');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not_authenticated');
      expect(r.error.message).toMatch(/auth login/);
    }
  });

  it('delete removes the token and is idempotent', () => {
    const store = new TokenStore({ tokensDir });
    store.save('default', { refresh_token: '1//x' });
    expect(store.exists('default')).toBe(true);
    expect(store.delete('default').ok).toBe(true);
    expect(store.exists('default')).toBe(false);
    expect(store.delete('default').ok).toBe(true); // no error when already gone
  });
});

describe('permission hygiene', () => {
  it('classifies POSIX modes correctly', () => {
    expect(isPermissivePosixMode(0o600)).toBe(false);
    expect(isPermissivePosixMode(0o700)).toBe(false);
    expect(isPermissivePosixMode(0o644)).toBe(true);
    expect(isPermissivePosixMode(0o660)).toBe(true);
  });

  it('permissionWarning warns only for permissive modes', () => {
    const sink = collector();
    const logger = createLogger({ level: 'warn', destination: sink });
    expect(permissionWarning(0o644, '/tmp/t.json', logger)).toBe(true);
    expect(permissionWarning(0o600, '/tmp/t.json', logger)).toBe(false);
    const out = sink.text();
    expect(out).toContain('too permissive');
    expect(out).toContain('644');
  });
});

describe('token values are never logged', () => {
  it('save logs only metadata, not the token value', () => {
    const sink = collector();
    const logger = createLogger({ level: 'info', destination: sink });
    const store = new TokenStore({ tokensDir, logger });
    store.save('default', {
      access_token: 'ya29.SUPERSECRET',
      refresh_token: '1//0gREFRESHSECRET',
    });
    const out = sink.text();
    expect(out).not.toContain('ya29.SUPERSECRET');
    expect(out).not.toContain('1//0gREFRESHSECRET');
    expect(out).toContain('hasRefreshToken');
  });
});

describe('tokensDirFromTokenPath', () => {
  it('returns the directory of the token path', () => {
    expect(tokensDirFromTokenPath(path.join('a', 'b', 'tokens', 'default.json'))).toBe(
      path.join('a', 'b', 'tokens'),
    );
  });
});
