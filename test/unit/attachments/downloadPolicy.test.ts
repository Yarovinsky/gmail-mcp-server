import { describe, it, expect } from 'vitest';
import {
  evaluateDownloadPolicy,
  downloadPolicyError,
  assertDownloadAllowed,
  extensionOf,
  type DownloadPolicyConfig,
  type DownloadTarget,
} from '../../../src/attachments/downloadPolicy.js';

const CONFIG: DownloadPolicyConfig = {
  blockedExtensions: ['.exe', '.dll', '.js'],
  allowedMimeTypes: [],
  maxAttachmentBytes: 1000,
};

function target(overrides: Partial<DownloadTarget> = {}): DownloadTarget {
  return { filename: 'report.pdf', mimeType: 'application/pdf', size: 100, ...overrides };
}

function withConfig(overrides: Partial<DownloadPolicyConfig> = {}): DownloadPolicyConfig {
  return { ...CONFIG, ...overrides };
}

describe('extensionOf', () => {
  it('returns the lower-cased extension with its dot', () => {
    expect(extensionOf('Report.PDF')).toBe('.pdf');
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
  });

  it('returns "" for no extension or a dotfile', () => {
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});

describe('evaluateDownloadPolicy (§12.6)', () => {
  it('allows a normal in-policy attachment', () => {
    expect(evaluateDownloadPolicy(target(), CONFIG)).toEqual({ allowed: true, reason: null });
  });

  it('blocks a blocked extension → file_blocked (§22.1 #14)', () => {
    const out = evaluateDownloadPolicy(target({ filename: 'malware.exe' }), CONFIG);
    expect(out).toEqual({ allowed: false, reason: 'file_blocked' });
  });

  it('treats blocked extensions case-insensitively', () => {
    expect(evaluateDownloadPolicy(target({ filename: 'x.EXE' }), CONFIG).reason).toBe(
      'file_blocked',
    );
  });

  it('blocks a non-allowlisted MIME when an allowlist is set → mime_type_blocked (§22.1 #14)', () => {
    const config = withConfig({ allowedMimeTypes: ['application/pdf', 'image/png'] });
    const out = evaluateDownloadPolicy(target({ mimeType: 'application/zip' }), config);
    expect(out).toEqual({ allowed: false, reason: 'mime_type_blocked' });
  });

  it('allows an allowlisted MIME (case-insensitive) when an allowlist is set', () => {
    const config = withConfig({ allowedMimeTypes: ['Application/PDF'] });
    expect(evaluateDownloadPolicy(target({ mimeType: 'application/pdf' }), config).allowed).toBe(
      true,
    );
  });

  it('imposes no MIME restriction when the allowlist is empty', () => {
    expect(
      evaluateDownloadPolicy(target({ mimeType: 'application/anything' }), CONFIG).allowed,
    ).toBe(true);
  });

  it('blocks an oversize attachment → file_too_large (§22.1 #15)', () => {
    const out = evaluateDownloadPolicy(target({ size: 1001 }), CONFIG);
    expect(out).toEqual({ allowed: false, reason: 'file_too_large' });
  });

  it('allows a size exactly at the cap (boundary)', () => {
    expect(evaluateDownloadPolicy(target({ size: 1000 }), CONFIG).allowed).toBe(true);
  });

  it('prioritises a blocked extension over MIME and size failures (§12.6 order)', () => {
    const config = withConfig({ allowedMimeTypes: ['application/pdf'] });
    const out = evaluateDownloadPolicy(
      target({ filename: 'evil.exe', mimeType: 'application/zip', size: 99999 }),
      config,
    );
    expect(out.reason).toBe('file_blocked');
  });

  it('prioritises a MIME failure over a size failure', () => {
    const config = withConfig({ allowedMimeTypes: ['application/pdf'] });
    const out = evaluateDownloadPolicy(
      target({ filename: 'big.zip', mimeType: 'application/zip', size: 99999 }),
      config,
    );
    expect(out.reason).toBe('mime_type_blocked');
  });
});

describe('downloadPolicyError (§17 codes match §12.6 blockedReason)', () => {
  it('builds a file_blocked error carrying the extension and policy list', () => {
    const e = downloadPolicyError('file_blocked', target({ filename: 'm.exe' }), CONFIG);
    expect(e.code).toBe('file_blocked');
    expect(e.retryable).toBe(false);
    expect(e.details).toMatchObject({
      extension: '.exe',
      blockedExtensions: CONFIG.blockedExtensions,
    });
  });

  it('builds a mime_type_blocked error carrying the MIME and allowlist', () => {
    const config = withConfig({ allowedMimeTypes: ['application/pdf'] });
    const e = downloadPolicyError(
      'mime_type_blocked',
      target({ mimeType: 'application/zip' }),
      config,
    );
    expect(e.code).toBe('mime_type_blocked');
    expect(e.details).toMatchObject({
      mimeType: 'application/zip',
      allowedMimeTypes: ['application/pdf'],
    });
  });

  it('builds a file_too_large error carrying the size and cap', () => {
    const e = downloadPolicyError('file_too_large', target({ size: 5000 }), CONFIG);
    expect(e.code).toBe('file_too_large');
    expect(e.details).toMatchObject({ size: 5000, maxAttachmentBytes: 1000 });
  });
});

describe('assertDownloadAllowed', () => {
  it('returns ok when the attachment is allowed', () => {
    expect(assertDownloadAllowed(target(), CONFIG).ok).toBe(true);
  });

  it('returns the matching §17 error when blocked', () => {
    const blockedExt = assertDownloadAllowed(target({ filename: 'm.exe' }), CONFIG);
    expect(blockedExt.ok).toBe(false);
    if (!blockedExt.ok) expect(blockedExt.error.code).toBe('file_blocked');

    const tooLarge = assertDownloadAllowed(target({ size: 2000 }), CONFIG);
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error.code).toBe('file_too_large');
  });
});
