import { describe, it, expect } from 'vitest';
import { parseMessage, type MessagePart } from '../../../src/mime/parseMessage.js';
import { encodeBase64Url } from '../../../src/mime/base64url.js';

const MSG_ID = 'msg-123';

/** Encode text as Gmail-style base64url body data. */
function data(text: string): string {
  return encodeBase64Url(text);
}

/** Fixture §22.2 #1: a simple plain-text email. */
const fixturePlain: MessagePart = {
  partId: '',
  mimeType: 'text/plain',
  body: { data: data('Hello plain world') },
};

/** Fixture §22.2 #2: multipart/alternative with text + html. */
const fixtureAlt: MessagePart = {
  partId: '',
  mimeType: 'multipart/alternative',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('the plain body') } },
    { partId: '1', mimeType: 'text/html', body: { data: data('<p>the html body</p>') } },
  ],
};

/** Fixture §22.2 #3: a PDF attachment alongside a text body. */
const fixturePdf: MessagePart = {
  partId: '',
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('see attached') } },
    {
      partId: '1',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
      body: { attachmentId: 'att-pdf-1', size: 4096 },
    },
  ],
};

/** Fixture §22.2 #4: an inline image referenced by Content-ID (external bytes). */
const fixtureInlineImage: MessagePart = {
  partId: '',
  mimeType: 'multipart/related',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('image below') } },
    {
      partId: '1',
      mimeType: 'image/png',
      headers: [
        { name: 'Content-Disposition', value: 'inline' },
        { name: 'Content-ID', value: '<logo@cid>' },
      ],
      body: { attachmentId: 'att-img-1', size: 2048 },
    },
  ],
};

/** Variant of #4 with the inline image bytes carried INLINE (body.data, no attachmentId). */
const fixtureInlineImageData: MessagePart = {
  partId: '',
  mimeType: 'multipart/related',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('image below') } },
    {
      partId: '1',
      mimeType: 'image/png',
      headers: [{ name: 'Content-Disposition', value: 'inline' }],
      body: { data: data('PNGBYTES') },
    },
  ],
};

/** Fixture §22.2 #5: a nested message/rfc822 with its own body + attachment. */
const fixtureNestedRfc822: MessagePart = {
  partId: '',
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('outer body') } },
    {
      partId: '1',
      mimeType: 'message/rfc822',
      parts: [
        { partId: '1.0', mimeType: 'text/plain', body: { data: data('inner body') } },
        {
          partId: '1.1',
          mimeType: 'application/pdf',
          filename: 'inner.pdf',
          body: { attachmentId: 'att-inner', size: 10 },
        },
      ],
    },
  ],
};

/** Fixture §22.2 #6: a text body with malformed base64. */
const fixtureMalformed: MessagePart = {
  partId: '',
  mimeType: 'text/plain',
  body: { data: '@@@ not valid base64 @@@' },
};

/** Fixture §22.2 #7: an attachment with no filename. */
const fixtureMissingFilename: MessagePart = {
  partId: '',
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('body') } },
    {
      partId: '1',
      mimeType: 'application/octet-stream',
      body: { attachmentId: 'att-noname', size: 100 },
    },
  ],
};

/** Fixture §22.2 #8: an attachment with huge declared metadata. */
const fixtureHugeMetadata: MessagePart = {
  partId: '',
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { data: data('body') } },
    {
      partId: '1',
      mimeType: 'application/octet-stream',
      filename: 'huge.bin',
      body: { attachmentId: 'att-huge', size: 9_999_999_999 },
    },
  ],
};

describe('parseMessage tree + body extraction (§14, §22.1 #5–#9, §22.2 #1–#8)', () => {
  it('#1 extracts plain text from a simple message', () => {
    const result = parseMessage(fixturePlain, MSG_ID);
    expect(result.text).toBe('Hello plain world');
    expect(result.html).toBeUndefined();
    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('#2 returns plain text but NOT html by default (§14.3, §22.1 #7)', () => {
    const result = parseMessage(fixtureAlt, MSG_ID);
    expect(result.text).toBe('the plain body');
    expect(result.html).toBeUndefined();
  });

  it('#2 returns html only when explicitly requested', () => {
    const result = parseMessage(fixtureAlt, MSG_ID, { includeHtml: true });
    expect(result.text).toBe('the plain body');
    expect(result.html).toBe('<p>the html body</p>');
  });

  it('#3 discovers a PDF attachment from body.attachmentId (§22.1 #8)', () => {
    const result = parseMessage(fixturePdf, MSG_ID);
    expect(result.text).toBe('see attached');
    expect(result.attachments).toHaveLength(1);
    const att = result.attachments[0];
    expect(att.filename).toBe('report.pdf');
    expect(att.attachmentId).toBe('att-pdf-1');
    expect(att.mimeType).toBe('application/pdf');
    expect(att.size).toBe(4096);
    expect(att.source).toBe('external-attachment');
    expect(att.inline).toBe(false);
    expect(att.partId).toBe('1');
    expect(att.messageId).toBe(MSG_ID);
  });

  it('#4 excludes inline attachments by default, includes them on request (§14.6)', () => {
    expect(parseMessage(fixtureInlineImage, MSG_ID).attachments).toEqual([]);

    const withInline = parseMessage(fixtureInlineImage, MSG_ID, { includeInline: true });
    expect(withInline.attachments).toHaveLength(1);
    const img = withInline.attachments[0];
    expect(img.inline).toBe(true);
    expect(img.disposition).toBe('inline');
    expect(img.contentId).toBe('logo@cid');
    expect(img.attachmentId).toBe('att-img-1');
    expect(img.source).toBe('external-attachment');
  });

  it('#4b discovers an inline attachment from inline body.data (§5.3, §22.1 #9)', () => {
    const result = parseMessage(fixtureInlineImageData, MSG_ID, { includeInline: true });
    expect(result.attachments).toHaveLength(1);
    const img = result.attachments[0];
    expect(img.source).toBe('inline-body-data');
    expect(img.attachmentId).toBeUndefined();
    expect(img.dataBase64).toBe(encodeBase64Url('PNGBYTES'));
    expect(img.size).toBeGreaterThan(0);
  });

  it('#5 recurses into message/rfc822, collecting nested body + attachment (§14.7)', () => {
    const result = parseMessage(fixtureNestedRfc822, MSG_ID);
    expect(result.text).toContain('outer body');
    expect(result.text).toContain('inner body');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('inner.pdf');
    expect(result.attachments[0].attachmentId).toBe('att-inner');
  });

  it('#6 does not crash on malformed base64; surfaces a warning (§14.9, §22.2 #6)', () => {
    const result = parseMessage(fixtureMalformed, MSG_ID);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.attachments).toEqual([]);
  });

  it('#7 produces a descriptor for an attachment with no filename (§22.2 #7)', () => {
    const result = parseMessage(fixtureMissingFilename, MSG_ID);
    expect(result.attachments).toHaveLength(1);
    const att = result.attachments[0];
    expect(att.filename).toBe('');
    expect(att.attachmentId).toBe('att-noname');
    expect(att.source).toBe('external-attachment');
  });

  it('#8 records huge declared metadata without decoding/allocating (§22.2 #8)', () => {
    const result = parseMessage(fixtureHugeMetadata, MSG_ID);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].size).toBe(9_999_999_999);
    expect(result.attachments[0].filename).toBe('huge.bin');
  });

  it('treats a text/plain part WITH a filename as an attachment, not a body (§14.4)', () => {
    const part: MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: data('real body') } },
        {
          partId: '1',
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { attachmentId: 'att-notes', size: 12 },
        },
      ],
    };
    const result = parseMessage(part, MSG_ID);
    expect(result.text).toBe('real body');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('notes.txt');
  });

  it('does not crash on null/empty payloads', () => {
    expect(parseMessage(null, MSG_ID)).toEqual({ attachments: [], warnings: [] });
    expect(parseMessage(undefined, MSG_ID)).toEqual({ attachments: [], warnings: [] });
    expect(parseMessage({}, MSG_ID)).toEqual({ attachments: [], warnings: [] });
  });

  it('bails out with a warning on pathologically deep nesting', () => {
    // Build a chain deeper than the default maxDepth.
    let deep: MessagePart = { mimeType: 'text/plain', body: { data: data('bottom') } };
    for (let i = 0; i < 60; i += 1) {
      deep = { mimeType: 'multipart/mixed', parts: [deep] };
    }
    const result = parseMessage(deep, MSG_ID, { maxDepth: 50 });
    expect(result.warnings.some((w) => w.includes('depth'))).toBe(true);
  });
});
