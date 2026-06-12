import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  redactString,
  redactSecrets,
  containsTokenShape,
} from '../../../src/safety/redaction.js';

describe('redactString', () => {
  it('scrubs Google access tokens (ya29.…)', () => {
    const out = redactString('token is ya29.A0ARrdaM-fakefake_123 end');
    expect(out).not.toContain('ya29.A0ARrdaM-fakefake_123');
    expect(out).toContain(REDACTED);
  });

  it('scrubs Google refresh tokens (1//…)', () => {
    const out = redactString('refresh 1//0gFAKErefreshTOKENvalue123 done');
    expect(out).not.toContain('1//0gFAKErefreshTOKENvalue123');
    expect(out).toContain(REDACTED);
  });

  it('scrubs OAuth client secrets and JWTs', () => {
    expect(redactString('GOCSPX-abc123FAKEsecret')).toBe(REDACTED);
    const jwt = 'eyJhbGciOi.eyJzdWIiOiAxMjM0.sIgNeDvALUE';
    expect(redactString(`auth ${jwt}`)).not.toContain(jwt);
  });

  it('scrubs Bearer tokens but keeps the scheme word', () => {
    const out = redactString('Authorization: Bearer ya29.SECRETtoken');
    expect(out).toContain('Bearer');
    expect(out).not.toContain('ya29.SECRETtoken');
  });

  it('leaves ordinary strings untouched', () => {
    expect(redactString('hello world pageToken=abc123')).toBe('hello world pageToken=abc123');
  });
});

describe('redactSecrets (objects)', () => {
  it('redacts values under sensitive keys (snake/camel) wholesale', () => {
    const input = {
      access_token: 'literally-anything',
      refreshToken: 'another-secret',
      client_secret: 'GOCSPX-xyz',
      nested: { id_token: 'jwt.value.here' },
    };
    const out = redactSecrets(input);
    expect(out.access_token).toBe(REDACTED);
    expect(out.refreshToken).toBe(REDACTED);
    expect(out.client_secret).toBe(REDACTED);
    expect(out.nested.id_token).toBe(REDACTED);
  });

  it('keeps non-sensitive fields, including pagination tokens', () => {
    const out = redactSecrets({ pageToken: 'safe-123', nextPageToken: 'safe-456', count: 7 });
    expect(out.pageToken).toBe('safe-123');
    expect(out.nextPageToken).toBe('safe-456');
    expect(out.count).toBe(7);
  });

  it('scrubs token-shaped strings inside ordinary values', () => {
    const out = redactSecrets({ note: 'see ya29.LEAKEDtoken in here' });
    expect(out.note).not.toContain('ya29.LEAKEDtoken');
  });

  it('preserves Error objects while scrubbing their message', () => {
    const err = new Error('failed with ya29.SECRETtoken');
    const out = redactSecrets(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).not.toContain('ya29.SECRETtoken');
  });

  it('does not crash on circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => redactSecrets(obj)).not.toThrow();
  });
});

describe('containsTokenShape', () => {
  it('detects token-shaped strings', () => {
    expect(containsTokenShape('ya29.abc')).toBe(true);
    expect(containsTokenShape('Bearer abc.def')).toBe(true);
    expect(containsTokenShape('nothing here')).toBe(false);
  });
});
