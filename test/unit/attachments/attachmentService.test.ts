import { describe, it, expect } from 'vitest';
import { listAttachments, selectAttachment } from '../../../src/attachments/attachmentService.js';
import type { GmailAttachmentDescriptor } from '../../../src/mime/attachmentExtractor.js';
import type { DownloadPolicyConfig } from '../../../src/attachments/downloadPolicy.js';

const CONFIG: DownloadPolicyConfig = {
  blockedExtensions: ['.exe'],
  allowedMimeTypes: [],
  maxAttachmentBytes: 1000,
};

function descriptor(overrides: Partial<GmailAttachmentDescriptor> = {}): GmailAttachmentDescriptor {
  return {
    messageId: 'm1',
    partId: '2',
    attachmentId: 'att-1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 100,
    disposition: 'attachment',
    inline: false,
    headers: {},
    source: 'external-attachment',
    ...overrides,
  };
}

describe('listAttachments (§12.6)', () => {
  it('shapes descriptors and marks an allowed attachment downloadable', () => {
    const out = listAttachments([descriptor()], CONFIG);
    expect(out).toEqual([
      {
        messageId: 'm1',
        partId: '2',
        attachmentId: 'att-1',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 100,
        disposition: 'attachment',
        inline: false,
        downloadAllowed: true,
        blockedReason: null,
      },
    ]);
  });

  it('annotates a blocked extension with downloadAllowed=false and a reason', () => {
    const out = listAttachments([descriptor({ filename: 'virus.exe' })], CONFIG);
    expect(out[0].downloadAllowed).toBe(false);
    expect(out[0].blockedReason).toBe('file_blocked');
  });

  it('annotates an oversize attachment as file_too_large', () => {
    const out = listAttachments([descriptor({ size: 5000 })], CONFIG);
    expect(out[0].blockedReason).toBe('file_too_large');
  });

  it('omits optional fields that are absent on the descriptor', () => {
    const out = listAttachments(
      [descriptor({ partId: undefined, attachmentId: undefined, disposition: undefined })],
      CONFIG,
    );
    expect(out[0]).not.toHaveProperty('partId');
    expect(out[0]).not.toHaveProperty('attachmentId');
    expect(out[0]).not.toHaveProperty('disposition');
  });
});

describe('selectAttachment (§12.8)', () => {
  const descriptors = [
    descriptor({ attachmentId: 'a1', partId: '1' }),
    descriptor({ attachmentId: 'a2', partId: '2' }),
  ];

  it('finds by attachmentId', () => {
    const out = selectAttachment(descriptors, { attachmentId: 'a2' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.partId).toBe('2');
  });

  it('finds by partId', () => {
    const out = selectAttachment(descriptors, { partId: '1' });
    if (out.ok) expect(out.value.attachmentId).toBe('a1');
  });

  it('requires both to match when both are given', () => {
    const mismatch = selectAttachment(descriptors, { attachmentId: 'a1', partId: '2' });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('not_found');
  });

  it('returns not_found when nothing matches', () => {
    const out = selectAttachment(descriptors, { attachmentId: 'nope' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not_found');
  });

  it('returns invalid_input when no selector is given', () => {
    const out = selectAttachment(descriptors, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_input');
  });
});
