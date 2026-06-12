import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  appError,
  errorResult,
  toErrorResponse,
  insufficientScopeError,
  featureDisabledError,
  notAuthenticatedError,
  internalError,
  isRetryableHttpStatus,
  mapHttpStatusToCode,
  fromGmailApiError,
} from '../../../src/mcp/errors.js';

const ALL_CODES = [
  'invalid_input',
  'not_authenticated',
  'insufficient_scope',
  'feature_disabled',
  'gmail_api_error',
  'rate_limited',
  'not_found',
  'permission_denied',
  'confirmation_required',
  'path_not_allowed',
  'file_blocked',
  'file_too_large',
  'mime_type_blocked',
  'decode_failed',
  'network_error',
  'internal_error',
];

describe('ERROR_CODES', () => {
  it('lists all 16 §17 codes exactly', () => {
    expect(ERROR_CODES).toHaveLength(16);
    expect(new Set(ERROR_CODES)).toEqual(new Set(ALL_CODES));
  });

  it('every code is representable by the factory', () => {
    for (const code of ALL_CODES) {
      const e = appError(code as (typeof ERROR_CODES)[number], { message: 'x' });
      expect(e.code).toBe(code);
      expect(typeof e.retryable).toBe('boolean');
    }
  });
});

describe('appError factory', () => {
  it('produces the exact §17 shape including retryable', () => {
    const e = appError('file_too_large', {
      message: 'Attachment exceeds configured maxAttachmentBytes.',
      details: { size: 104857600, maxAttachmentBytes: 52428800 },
      retryable: false,
    });
    expect(toErrorResponse(e)).toEqual({
      ok: false,
      error: {
        code: 'file_too_large',
        message: 'Attachment exceeds configured maxAttachmentBytes.',
        details: { size: 104857600, maxAttachmentBytes: 52428800 },
        retryable: false,
      },
    });
  });

  it('omits details when not provided', () => {
    const e = appError('not_found', { message: 'nope' });
    expect(e).toEqual({ code: 'not_found', message: 'nope', retryable: false });
    expect('details' in e).toBe(false);
  });

  it('applies per-code default retryability, overridable per call', () => {
    expect(appError('rate_limited', { message: 'slow down' }).retryable).toBe(true);
    expect(appError('network_error', { message: 'oops' }).retryable).toBe(true);
    expect(appError('invalid_input', { message: 'bad' }).retryable).toBe(false);
    expect(appError('rate_limited', { message: 'x', retryable: false }).retryable).toBe(false);
  });

  it('errorResult wraps the error in a failed AppResult', () => {
    const r = errorResult('invalid_input', { message: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

describe('insufficientScopeError', () => {
  it('matches the §11.1 example shape with requiredAnyOf/granted', () => {
    const requiredAnyOf = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
    ];
    const granted = ['https://www.googleapis.com/auth/gmail.send'];
    const e = insufficientScopeError(requiredAnyOf, granted);
    expect(e.code).toBe('insufficient_scope');
    expect(e.retryable).toBe(false);
    expect(e.details).toEqual({ requiredAnyOf, granted });
    expect(e.message).toContain('gmail.readonly');
  });
});

describe('feature/auth/internal helpers', () => {
  it('featureDisabledError names the feature', () => {
    const e = featureDisabledError('drafts');
    expect(e.code).toBe('feature_disabled');
    expect(e.details).toEqual({ feature: 'drafts' });
    expect(e.retryable).toBe(false);
  });

  it('notAuthenticatedError suggests auth login', () => {
    const e = notAuthenticatedError();
    expect(e.code).toBe('not_authenticated');
    expect(e.message).toMatch(/auth login/);
  });

  it('internalError captures the cause', () => {
    const e = internalError('boom', new Error('root cause'));
    expect(e.code).toBe('internal_error');
    expect(e.details).toEqual({ cause: 'Error: root cause' });
  });
});

describe('HTTP/network mapping', () => {
  it('maps statuses to codes', () => {
    expect(mapHttpStatusToCode(400)).toBe('invalid_input');
    expect(mapHttpStatusToCode(401)).toBe('not_authenticated');
    expect(mapHttpStatusToCode(403)).toBe('permission_denied');
    expect(mapHttpStatusToCode(404)).toBe('not_found');
    expect(mapHttpStatusToCode(429)).toBe('rate_limited');
    expect(mapHttpStatusToCode(500)).toBe('gmail_api_error');
    expect(mapHttpStatusToCode(503)).toBe('gmail_api_error');
  });

  it('flags only transient statuses as retryable', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableHttpStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(isRetryableHttpStatus(s)).toBe(false);
    expect(isRetryableHttpStatus(undefined)).toBe(false);
  });

  it('maps a Gmail 429 to rate_limited (retryable)', () => {
    const e = fromGmailApiError({ response: { status: 429 }, message: 'Rate Limit Exceeded' });
    expect(e.code).toBe('rate_limited');
    expect(e.retryable).toBe(true);
    expect(e.details).toEqual({ status: 429 });
  });

  it('maps a 500 to gmail_api_error (retryable) and a 404 to not_found (terminal)', () => {
    expect(fromGmailApiError({ response: { status: 500 } }).retryable).toBe(true);
    const nf = fromGmailApiError({ response: { status: 404 }, message: 'Not Found' });
    expect(nf.code).toBe('not_found');
    expect(nf.retryable).toBe(false);
  });

  it('maps a bare network error to network_error (retryable)', () => {
    const e = fromGmailApiError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' });
    expect(e.code).toBe('network_error');
    expect(e.retryable).toBe(true);
    expect(e.details).toEqual({ cause: 'ENOTFOUND' });
  });

  it('maps an unknown thrown value to internal_error (terminal)', () => {
    const e = fromGmailApiError(new Error('weird'));
    expect(e.code).toBe('internal_error');
    expect(e.retryable).toBe(false);
  });
});
