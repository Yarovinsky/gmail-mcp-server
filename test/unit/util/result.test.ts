import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  mapOk,
  unwrap,
  type AppError,
  type AppResult,
} from '../../../src/util/result.js';

const sampleError: AppError = {
  code: 'invalid_input',
  message: 'bad',
  retryable: false,
};

describe('AppResult ok/err construction', () => {
  it('ok() builds a success result carrying the value', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('err() builds a failure result carrying the error', () => {
    const r = err(sampleError);
    expect(r).toEqual({ ok: false, error: sampleError });
  });
});

describe('AppResult narrowing', () => {
  it('isOk narrows to the success branch', () => {
    const r: AppResult<string> = ok('hi');
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) {
      // Type-level: r.value is accessible without a cast.
      expect(r.value).toBe('hi');
    }
  });

  it('isErr narrows to the failure branch', () => {
    const r: AppResult<string> = err(sampleError);
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) {
      expect(r.error.code).toBe('invalid_input');
    }
  });
});

describe('mapOk', () => {
  it('maps the success value', () => {
    const r = mapOk(ok(2), (n) => n * 10);
    expect(r).toEqual({ ok: true, value: 20 });
  });

  it('passes failures through unchanged', () => {
    const failure = err<number>(sampleError);
    const r = mapOk(failure, (n) => n * 10);
    expect(r).toBe(failure);
  });
});

describe('unwrap', () => {
  it('returns the value for a success result', () => {
    expect(unwrap(ok('x'))).toBe('x');
  });

  it('throws with the error code/message for a failure result', () => {
    expect(() => unwrap(err(sampleError))).toThrow(/invalid_input: bad/);
  });
});
