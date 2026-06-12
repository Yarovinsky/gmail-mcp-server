import { describe, it, expect } from 'vitest';
import { sleep, backoffDelayMs } from '../../../src/util/async.js';
import { clamp, formatBytes, MIB } from '../../../src/util/size.js';
import { internalDateToIso } from '../../../src/util/date.js';
import { clampPageSize } from '../../../src/util/pagination.js';

describe('async.sleep', () => {
  it('resolves after roughly the requested delay', async () => {
    const start = Date.now();
    await sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });

  it('treats negative delays as zero', async () => {
    await expect(sleep(-100)).resolves.toBeUndefined();
  });
});

describe('async.backoffDelayMs', () => {
  it('grows exponentially and is capped', () => {
    // random() = 1 gives the upper bound of the jitter window.
    const random = () => 1;
    expect(backoffDelayMs(0, { baseMs: 100, capMs: 10_000, random })).toBe(100);
    expect(backoffDelayMs(1, { baseMs: 100, capMs: 10_000, random })).toBe(200);
    expect(backoffDelayMs(2, { baseMs: 100, capMs: 10_000, random })).toBe(400);
    expect(backoffDelayMs(20, { baseMs: 100, capMs: 10_000, random })).toBe(10_000);
  });

  it('applies jitter between 0 and the exponential bound', () => {
    expect(backoffDelayMs(3, { baseMs: 100, capMs: 10_000, random: () => 0 })).toBe(0);
  });
});

describe('size.clamp', () => {
  it('clamps into range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });

  it('returns min for NaN', () => {
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
  });
});

describe('size.formatBytes', () => {
  it('formats bytes and larger units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(MIB)).toBe('1.0 MiB');
  });
});

describe('date.internalDateToIso', () => {
  it('converts epoch-millis strings to ISO', () => {
    expect(internalDateToIso('1748769300000')).toBe('2025-06-01T09:15:00.000Z');
  });

  it('accepts numbers', () => {
    expect(internalDateToIso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns null for missing or unparseable input', () => {
    expect(internalDateToIso(null)).toBeNull();
    expect(internalDateToIso(undefined)).toBeNull();
    expect(internalDateToIso('')).toBeNull();
    expect(internalDateToIso('not-a-number')).toBeNull();
  });
});

describe('pagination.clampPageSize', () => {
  it('defaults to defaultPageSize when omitted', () => {
    expect(clampPageSize(undefined, 10, 100)).toBe(10);
    expect(clampPageSize(null, 10, 100)).toBe(10);
  });

  it('clamps a requested size into [1, maxPageSize]', () => {
    expect(clampPageSize(5, 10, 100)).toBe(5);
    expect(clampPageSize(0, 10, 100)).toBe(1);
    expect(clampPageSize(500, 10, 100)).toBe(100);
  });
});
