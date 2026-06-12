import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../../src/attachments/hash.js';

describe('sha256Hex', () => {
  it('matches the known vector for the empty input', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known vector for "abc"', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns a 64-char lower-case hex digest', () => {
    const digest = sha256Hex(Buffer.from('gmail-mcp'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
