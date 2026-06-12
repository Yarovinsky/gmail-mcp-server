import { describe, it, expect } from 'vitest';
import { parseHeaders, parseStructuredHeader, type RawHeader } from '../../../src/mime/headers.js';

const RAW: RawHeader[] = [
  { name: 'Content-Type', value: 'text/plain; charset="utf-8"' },
  { name: 'CONTENT-DISPOSITION', value: 'attachment; filename="a.pdf"' },
  { name: 'X-Dup', value: 'first' },
  { name: 'x-dup', value: 'second' },
  { name: '', value: 'ignored-empty-name' },
  { value: 'ignored-no-name' },
  { name: 'X-Empty' },
];

describe('ParsedHeaders case-insensitivity (§14.1, §22.1 #4)', () => {
  it('looks up headers case-insensitively', () => {
    const h = parseHeaders(RAW);
    expect(h.get('content-type')).toBe('text/plain; charset="utf-8"');
    expect(h.get('CONTENT-TYPE')).toBe('text/plain; charset="utf-8"');
    expect(h.get('Content-Type')).toBe('text/plain; charset="utf-8"');
    expect(h.has('content-disposition')).toBe(true);
    expect(h.has('CONTENT-DISPOSITION')).toBe(true);
  });

  it('returns undefined / empty for absent headers', () => {
    const h = parseHeaders(RAW);
    expect(h.get('x-missing')).toBeUndefined();
    expect(h.getAll('x-missing')).toEqual([]);
    expect(h.has('x-missing')).toBe(false);
  });

  it('preserves all values for duplicated headers, first value via get()', () => {
    const h = parseHeaders(RAW);
    expect(h.getAll('x-dup')).toEqual(['first', 'second']);
    expect(h.get('X-DUP')).toBe('first');
  });

  it('ignores headers with empty or missing names', () => {
    const h = parseHeaders(RAW);
    expect(h.has('')).toBe(false);
    // The two unnamed entries must not leak into the record.
    const record = h.toRecord();
    expect(Object.values(record)).not.toContain('ignored-empty-name');
    expect(Object.values(record)).not.toContain('ignored-no-name');
  });

  it('treats a present-but-valueless header as an empty string', () => {
    const h = parseHeaders(RAW);
    expect(h.has('x-empty')).toBe(true);
    expect(h.get('x-empty')).toBe('');
  });

  it('toRecord preserves the first-seen original name casing', () => {
    const record = parseHeaders(RAW).toRecord();
    expect(record['Content-Type']).toBe('text/plain; charset="utf-8"');
    expect(record['CONTENT-DISPOSITION']).toBe('attachment; filename="a.pdf"');
    expect(record['X-Dup']).toBe('first');
    expect(record['x-dup']).toBeUndefined(); // duplicate folded into 'X-Dup'
  });

  it('handles empty/undefined input', () => {
    expect(parseHeaders(undefined).get('anything')).toBeUndefined();
    expect(parseHeaders(null).toRecord()).toEqual({});
    expect(parseHeaders([]).has('x')).toBe(false);
  });
});

describe('parseStructuredHeader', () => {
  it('splits the primary value from its parameters', () => {
    const r = parseStructuredHeader('multipart/mixed; boundary="--abc"; charset=UTF-8');
    expect(r.value).toBe('multipart/mixed');
    expect(r.params.boundary).toBe('--abc');
    expect(r.params.charset).toBe('UTF-8'); // param VALUE casing preserved
  });

  it('lowercases the primary value and param names', () => {
    const r = parseStructuredHeader('TEXT/HTML; CharSet=US-ASCII');
    expect(r.value).toBe('text/html');
    expect(r.params.charset).toBe('US-ASCII');
  });

  it('does not split on semicolons inside quoted values', () => {
    const r = parseStructuredHeader('inline; filename="a;b.txt"');
    expect(r.value).toBe('inline');
    expect(r.params.filename).toBe('a;b.txt');
  });

  it('returns an empty value with no params for empty/undefined input', () => {
    expect(parseStructuredHeader('')).toEqual({ value: '', params: {} });
    expect(parseStructuredHeader(undefined)).toEqual({ value: '', params: {} });
    expect(parseStructuredHeader('   ')).toEqual({ value: '', params: {} });
  });
});
