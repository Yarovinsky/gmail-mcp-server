import { describe, it, expect } from 'vitest';
import {
  decodeBase64Url,
  decodeBase64UrlToString,
  encodeBase64Url,
} from '../../../src/mime/base64url.js';

describe('decodeBase64Url (§14.8, §22.1 #10)', () => {
  it('decodes valid unpadded base64url (Gmail style)', () => {
    const { bytes, warning } = decodeBase64Url('SGVsbG8sIHdvcmxkIQ');
    expect(warning).toBeUndefined();
    expect(bytes.toString('utf8')).toBe('Hello, world!');
  });

  it('decodes the url-safe `-` and `_` characters', () => {
    const { bytes, warning } = decodeBase64Url('-_-_');
    expect(warning).toBeUndefined();
    expect([...bytes]).toEqual([0xfb, 0xff, 0xbf]);
  });

  it('round-trips arbitrary bytes through url-safe encoding', () => {
    const original = Buffer.from([0x00, 0xfb, 0xff, 0xbf, 0x10, 0x3f]);
    const encoded = encodeBase64Url(original);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(encoded).not.toContain('=');
    const { bytes, warning } = decodeBase64Url(encoded);
    expect(warning).toBeUndefined();
    expect(Buffer.compare(bytes, original)).toBe(0);
  });

  it('tolerates embedded whitespace and newlines without warning', () => {
    const { bytes, warning } = decodeBase64Url('SGVs bG8s\nIHdv cmxk IQ');
    expect(warning).toBeUndefined();
    expect(bytes.toString('utf8')).toBe('Hello, world!');
  });

  it('returns an empty buffer for empty or nullish input', () => {
    expect(decodeBase64Url('').bytes.length).toBe(0);
    expect(decodeBase64Url('').warning).toBeUndefined();
    expect(decodeBase64Url(undefined).bytes.length).toBe(0);
    expect(decodeBase64Url(null).bytes.length).toBe(0);
  });

  it('does not throw on malformed input and returns a warning (§22.2 #6)', () => {
    const result = decodeBase64Url('@@@ not base64 @@@');
    expect(Buffer.isBuffer(result.bytes)).toBe(true);
    expect(result.warning).toBeDefined();
  });
});

describe('decodeBase64UrlToString', () => {
  it('decodes to a UTF-8 string', () => {
    expect(decodeBase64UrlToString(encodeBase64Url('café ☕')).text).toBe('café ☕');
  });

  it('propagates the warning for malformed input', () => {
    expect(decodeBase64UrlToString('%%%').warning).toBeDefined();
  });
});

describe('encodeBase64Url', () => {
  it('produces unpadded url-safe output for strings and buffers', () => {
    const encoded = encodeBase64Url('Hello, world!');
    expect(encoded).toBe('SGVsbG8sIHdvcmxkIQ');
    expect(encodeBase64Url(Buffer.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });
});
