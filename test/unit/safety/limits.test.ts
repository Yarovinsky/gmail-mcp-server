import { describe, it, expect } from 'vitest';
import { boundToolResponse } from '../../../src/safety/limits.js';

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
