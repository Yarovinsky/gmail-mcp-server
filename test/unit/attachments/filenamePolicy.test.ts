import { describe, it, expect } from 'vitest';
import { resolveFilename, MAX_BASE_LENGTH } from '../../../src/attachments/filenamePolicy.js';

const DEFAULT_BLOCKED = [
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.js',
  '.scr',
  '.com',
  '.jar',
  '.msi',
];

function resolve(overrides: Partial<Parameters<typeof resolveFilename>[0]> = {}) {
  return resolveFilename({
    originalFilename: 'report.pdf',
    messageId: 'msg1',
    partId: '2',
    mimeType: 'application/pdf',
    preserveOriginal: true,
    blockedExtensions: DEFAULT_BLOCKED,
    ...overrides,
  });
}

describe('resolveFilename (section 15.2)', () => {
  it('preserves the original filename when preserveOriginal is true and present', () => {
    const out = resolve({ originalFilename: 'invoice-2026.pdf' });
    expect(out.filename).toBe('invoice-2026.pdf');
    expect(out.extension).toBe('.pdf');
    expect(out.generated).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  it('generates gmail-attachment-{messageId}-{partId} when preserveOriginal is false', () => {
    const out = resolve({ preserveOriginal: false, originalFilename: 'ignored.pdf' });
    expect(out.generated).toBe(true);
    expect(out.filename).toBe('gmail-attachment-msg1-2.pdf');
    expect(out.extension).toBe('.pdf');
  });

  it('generates a fallback name when the original is empty (preserveOriginal true)', () => {
    const out = resolve({ originalFilename: '' });
    expect(out.generated).toBe(true);
    expect(out.filename).toBe('gmail-attachment-msg1-2.pdf');
  });

  it('uses "unknown" for a missing partId in the generated name', () => {
    const out = resolve({ preserveOriginal: false, partId: undefined, mimeType: 'text/plain' });
    expect(out.filename).toBe('gmail-attachment-msg1-unknown.txt');
  });

  it('derives the generated extension from the MIME type, or omits it when unknown', () => {
    const png = resolve({ originalFilename: '', mimeType: 'image/png' });
    expect(png.filename).toBe('gmail-attachment-msg1-2.png');
    const unknown = resolve({ originalFilename: '', mimeType: 'application/x-totally-unknown' });
    expect(unknown.filename).toBe('gmail-attachment-msg1-2');
    expect(unknown.extension).toBe('');
  });

  it('sanitizes path separators, control characters, and reserved characters', () => {
    const control = String.fromCharCode(1, 7, 31);
    const out = resolve({
      originalFilename: `we/ir\\d:na*me?<>|"${control} .txt`,
      mimeType: 'text/plain',
    });
    const forbidden = ['/', '\\', ':', '*', '?', '<', '>', '|', '"', ' '];
    for (const ch of forbidden) {
      expect(out.filename).not.toContain(ch);
    }
    for (const code of out.filename.split('').map((c) => c.charCodeAt(0))) {
      expect(code).toBeGreaterThanOrEqual(0x20); // no control characters survive
    }
    expect(out.filename.endsWith('.txt')).toBe(true);
    expect(out.generated).toBe(false);
  });

  it('strips leading dots so a dotfile / traversal token cannot be produced', () => {
    const out = resolve({ originalFilename: '...hidden.txt', mimeType: 'text/plain' });
    expect(out.filename.startsWith('.')).toBe(false);
    expect(out.filename).toBe('hidden.txt');
  });

  it('falls back to a generated name when the original sanitizes away (e.g. "..")', () => {
    const out = resolve({ originalFilename: '..', mimeType: 'application/pdf' });
    expect(out.generated).toBe(true);
    expect(out.filename).toBe('gmail-attachment-msg1-2.pdf');
  });

  it('trims the base to MAX_BASE_LENGTH while preserving the extension (section 15.2 #4-#5)', () => {
    const longBase = 'a'.repeat(300);
    const out = resolve({ originalFilename: `${longBase}.pdf` });
    expect(out.filename.endsWith('.pdf')).toBe(true);
    expect(out.filename.length).toBe(MAX_BASE_LENGTH + '.pdf'.length);
    expect(out.extension).toBe('.pdf');
  });

  it('preserves the original extension casing in the name, normalizing the extension field (section 22.1 #11)', () => {
    const out = resolve({ originalFilename: 'Report.PDF' });
    expect(out.filename).toBe('Report.PDF');
    expect(out.extension).toBe('.pdf');
    expect(out.warnings).toEqual([]);
  });

  it('preserves a compound extension as its final segment', () => {
    const out = resolve({
      originalFilename: 'archive.tar.gz',
      mimeType: 'application/gzip',
    });
    expect(out.filename).toBe('archive.tar.gz');
    expect(out.extension).toBe('.gz');
  });

  it('flags a blocked extension without throwing (section 15.2 #6)', () => {
    const out = resolve({ originalFilename: 'malware.exe', mimeType: 'application/x-msdownload' });
    expect(out.blocked).toBe(true);
    expect(out.filename).toBe('malware.exe');
  });

  it('does not flag an allowed extension as blocked', () => {
    expect(resolve({ originalFilename: 'doc.pdf' }).blocked).toBe(false);
  });

  it('treats blocked extensions case-insensitively', () => {
    const out = resolve({ originalFilename: 'malware.EXE', mimeType: 'application/x-msdownload' });
    expect(out.blocked).toBe(true);
  });

  it('warns (does not fail) when the extension does not match the MIME type (section 15.2 #7)', () => {
    const out = resolve({ originalFilename: 'photo.pdf', mimeType: 'image/png' });
    expect(out.blocked).toBe(false);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('.pdf');
    expect(out.warnings[0]).toContain('image/png');
  });

  it('does not warn when the extension matches the MIME type', () => {
    expect(resolve({ originalFilename: 'doc.pdf', mimeType: 'application/pdf' }).warnings).toEqual(
      [],
    );
  });

  it('treats jpg and jpeg as matching image/jpeg (no spurious mismatch warning)', () => {
    expect(resolve({ originalFilename: 'pic.jpg', mimeType: 'image/jpeg' }).warnings).toEqual([]);
    expect(resolve({ originalFilename: 'pic.jpeg', mimeType: 'image/jpeg' }).warnings).toEqual([]);
  });

  it('does not warn when the declared type is the generic octet-stream fallback', () => {
    expect(
      resolve({ originalFilename: 'doc.pdf', mimeType: 'application/octet-stream' }).warnings,
    ).toEqual([]);
  });

  it('suppresses the mismatch warning when the extension is blocked', () => {
    const out = resolve({ originalFilename: 'invoice.exe', mimeType: 'application/pdf' });
    expect(out.blocked).toBe(true);
    expect(out.warnings).toEqual([]);
  });
});
