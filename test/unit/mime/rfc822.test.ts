import { describe, it, expect } from 'vitest';
import { buildRfc822 } from '../../../src/mime/rfc822.js';
import { parseHeaders, parseStructuredHeader, type RawHeader } from '../../../src/mime/headers.js';

/** Split a raw message into a header array (for the Step 4.3 parser) and its body. */
function split(raw: string): { headers: RawHeader[]; body: string } {
  const idx = raw.indexOf('\r\n\r\n');
  const headerBlock = raw.slice(0, idx);
  const body = raw.slice(idx + 4);
  const headers: RawHeader[] = headerBlock.split('\r\n').map((line) => {
    const c = line.indexOf(': ');
    return { name: line.slice(0, c), value: line.slice(c + 2) };
  });
  return { headers, body };
}

/** Decode a base64 (CRLF-wrapped) blob to UTF-8 text. */
function decodeB64(blob: string): string {
  return Buffer.from(blob.replace(/\r\n/g, '').trim(), 'base64').toString('utf8');
}

describe('buildRfc822 (§12.10, §12.13)', () => {
  it('builds a text/plain message that round-trips through the header parser', () => {
    const result = buildRfc822({ to: ['a@example.com'], subject: 'Hi', bodyText: 'Hello world' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { headers, body } = split(result.value);
    const parsed = parseHeaders(headers);
    expect(parsed.get('to')).toBe('a@example.com');
    expect(parsed.get('subject')).toBe('Hi');
    expect(parsed.get('mime-version')).toBe('1.0');
    expect(parsed.get('content-type')).toBe('text/plain; charset="UTF-8"');
    expect(parsed.get('content-transfer-encoding')).toBe('base64');
    expect(decodeB64(body)).toBe('Hello world');
  });

  it('includes Cc and Bcc when provided', () => {
    const result = buildRfc822({
      to: ['a@example.com'],
      cc: ['c1@example.com', 'c2@example.com'],
      bcc: ['b@example.com'],
      bodyText: 'x',
    });
    if (!result.ok) throw new Error('expected ok');
    const parsed = parseHeaders(split(result.value).headers);
    expect(parsed.get('cc')).toBe('c1@example.com, c2@example.com');
    expect(parsed.get('bcc')).toBe('b@example.com');
  });

  it('emits threading headers when given', () => {
    const result = buildRfc822({
      to: ['a@example.com'],
      bodyText: 'reply',
      inReplyTo: '<orig@mail.gmail.com>',
      references: '<orig@mail.gmail.com>',
    });
    if (!result.ok) throw new Error('expected ok');
    const parsed = parseHeaders(split(result.value).headers);
    expect(parsed.get('in-reply-to')).toBe('<orig@mail.gmail.com>');
    expect(parsed.get('references')).toBe('<orig@mail.gmail.com>');
  });

  it('builds multipart/alternative for text + html, both parts round-tripping', () => {
    const result = buildRfc822({
      to: ['a@example.com'],
      bodyText: 'plain body',
      bodyHtml: '<p>html body</p>',
    });
    if (!result.ok) throw new Error('expected ok');
    const { headers, body } = split(result.value);
    const parsed = parseHeaders(headers);
    const ct = parseStructuredHeader(parsed.get('content-type') ?? '');
    expect(ct.value).toBe('multipart/alternative');
    const boundary = ct.params.boundary;
    expect(boundary).toBeTruthy();

    const segments = body.split(`--${boundary}`);
    // segments[1] = text part, segments[2] = html part.
    expect(decodeB64(segments[1].slice(segments[1].indexOf('\r\n\r\n') + 4))).toBe('plain body');
    expect(decodeB64(segments[2].slice(segments[2].indexOf('\r\n\r\n') + 4))).toBe(
      '<p>html body</p>',
    );
    expect(result.value).toContain('text/plain; charset="UTF-8"');
    expect(result.value).toContain('text/html; charset="UTF-8"');
  });

  it('builds text/html when only html is provided', () => {
    const result = buildRfc822({ to: ['a@example.com'], bodyHtml: '<b>hi</b>' });
    if (!result.ok) throw new Error('expected ok');
    const { headers, body } = split(result.value);
    const parsed = parseHeaders(headers);
    expect(parsed.get('content-type')).toBe('text/html; charset="UTF-8"');
    expect(decodeB64(body)).toBe('<b>hi</b>');
  });

  it('RFC2047-encodes a non-ASCII subject', () => {
    const result = buildRfc822({ to: ['a@example.com'], subject: 'Posición €', bodyText: 'x' });
    if (!result.ok) throw new Error('expected ok');
    const parsed = parseHeaders(split(result.value).headers);
    const subject = parsed.get('subject') ?? '';
    expect(subject.startsWith('=?UTF-8?B?')).toBe(true);
    // The encoded word decodes back to the original subject.
    const b64 = subject.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Posición €');
  });

  it('rejects a non-empty attachmentsFromLocalPaths with invalid_input (§3 #9)', () => {
    const result = buildRfc822({
      to: ['a@example.com'],
      bodyText: 'x',
      attachmentsFromLocalPaths: ['/tmp/file.pdf'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });

  it('rejects a message with no recipients', () => {
    const result = buildRfc822({ to: [], bodyText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });
});
