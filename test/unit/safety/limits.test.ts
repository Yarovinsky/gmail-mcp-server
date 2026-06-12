import { describe, it, expect } from 'vitest';
import {
  boundToolResponse,
  capMessageBody,
  resolveBodyCharLimit,
} from '../../../src/safety/limits.js';

describe('boundToolResponse', () => {
  it('returns small responses unchanged', () => {
    const small = { ok: true, n: 1 };
    const r = boundToolResponse(small, 1000);
    expect(r.truncated).toBe(false);
    expect(r.result).toBe(small);
    expect(r.serialized).toBe(JSON.stringify(small));
  });

  it('truncates and flags an oversized ok response, staying within the limit', () => {
    const big = { ok: true, data: 'x'.repeat(5000) };
    const limit = 1000;
    const r = boundToolResponse(big, limit);
    expect(r.truncated).toBe(true);
    expect(r.result.ok).toBe(true);
    expect(r.result.truncated).toBe(true);
    expect(r.serialized.length).toBeLessThanOrEqual(limit);
    expect(JSON.stringify(r.result).length).toBeLessThanOrEqual(limit);
    expect(r.result.originalLength).toBe(JSON.stringify(big).length);
  });

  it('preserves ok:false and the error code when truncating an oversized error', () => {
    const errBig = {
      ok: false,
      error: { code: 'gmail_api_error', message: 'y'.repeat(5000), retryable: true },
    };
    const limit = 500;
    const r = boundToolResponse(errBig, limit);
    expect(r.truncated).toBe(true);
    expect(r.result.ok).toBe(false);
    expect((r.result.error as { code: string }).code).toBe('gmail_api_error');
    expect(r.serialized.length).toBeLessThanOrEqual(limit);
  });

  it('includes a preview of the original payload when space allows', () => {
    const big = { ok: true, marker: 'FINDME', data: 'z'.repeat(3000) };
    const r = boundToolResponse(big, 800);
    expect(typeof r.result.preview).toBe('string');
    expect(r.result.preview as string).toContain('FINDME');
  });
});

describe('resolveBodyCharLimit (§12.4, §22.1 #19)', () => {
  it('caps the per-call request at the configured maximum', () => {
    expect(resolveBodyCharLimit(50_000, 20_000)).toBe(20_000);
  });

  it('honors a smaller per-call request', () => {
    expect(resolveBodyCharLimit(5_000, 20_000)).toBe(5_000);
  });

  it('falls back to the config maximum for missing or invalid requests', () => {
    expect(resolveBodyCharLimit(undefined, 20_000)).toBe(20_000);
    expect(resolveBodyCharLimit(0, 20_000)).toBe(20_000);
    expect(resolveBodyCharLimit(-10, 20_000)).toBe(20_000);
    expect(resolveBodyCharLimit(Number.NaN, 20_000)).toBe(20_000);
  });

  it('floors fractional requests', () => {
    expect(resolveBodyCharLimit(1234.9, 20_000)).toBe(1234);
  });
});

describe('capMessageBody (§12.4)', () => {
  it('truncates an over-limit text body and flags it (not silently cut)', () => {
    const body = capMessageBody({ text: 'a'.repeat(100), html: null }, 10);
    expect(body.text).toBe('a'.repeat(10));
    expect(body.text?.length).toBe(10);
    expect(body.html).toBeNull();
    expect(body.truncated).toBe(true);
  });

  it('leaves a within-limit body unchanged and unflagged', () => {
    const body = capMessageBody({ text: 'short', html: null }, 10);
    expect(body.text).toBe('short');
    expect(body.truncated).toBe(false);
  });

  it('caps both text and html and flags if either overflows', () => {
    const body = capMessageBody({ text: 'ok', html: 'b'.repeat(50) }, 10);
    expect(body.text).toBe('ok');
    expect(body.html).toBe('b'.repeat(10));
    expect(body.truncated).toBe(true);
  });

  it('preserves null/absent bodies as null (e.g. the unrequested format)', () => {
    const body = capMessageBody({ text: 'hi' }, 10);
    expect(body.text).toBe('hi');
    expect(body.html).toBeNull();
    expect(body.truncated).toBe(false);
  });
});
