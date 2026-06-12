import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveAttachment,
  type SaveAttachmentInput,
  type SaveAttachmentPolicy,
} from '../../../src/attachments/saveAttachment.js';
import { sha256Hex } from '../../../src/attachments/hash.js';

let root: string;
let realRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-save-'));
  // The path guard realpaths the root; compare resolved paths against the real root.
  realRoot = fs.realpathSync(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const BYTES = Buffer.from('PDF-CONTENT');

function policy(overrides: Partial<SaveAttachmentPolicy> = {}): SaveAttachmentPolicy {
  return {
    preserveOriginalFilenames: true,
    blockedExtensions: ['.exe'],
    allowedMimeTypes: [],
    collisionPolicy: 'append-counter',
    maxAttachmentBytes: 1000,
    ...overrides,
  };
}

function input(overrides: Partial<SaveAttachmentInput> = {}): SaveAttachmentInput {
  return {
    rootDir: root,
    targetDirectory: '2026/06',
    originalFilename: 'invoice.pdf',
    messageId: 'm1',
    partId: '2',
    mimeType: 'application/pdf',
    bytes: BYTES,
    policy: policy(),
    ...overrides,
  };
}

describe('saveAttachment (§12.8, §15) — end to end', () => {
  it('writes the bytes under the resolved path and returns the §12.8 object', () => {
    const out = saveAttachment(input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.status).toBe('saved');
    if (out.value.status !== 'saved') return;
    const saved = out.value.saved;
    expect(saved.path).toBe(path.join(realRoot, '2026', '06', 'invoice.pdf'));
    expect(saved.filename).toBe('invoice.pdf');
    expect(saved.mimeType).toBe('application/pdf');
    expect(saved.size).toBe(BYTES.length);
    expect(saved.sha256).toBe(sha256Hex(BYTES));
    expect(saved.collisionPolicyApplied).toBe('append-counter');
    expect(fs.readFileSync(saved.path)).toEqual(BYTES);
  });

  it('honors a caller-supplied filename (still sanitized)', () => {
    const out = saveAttachment(input({ requestedFilename: 'custom name.pdf' }));
    if (out.ok && out.value.status === 'saved') {
      expect(path.basename(out.value.saved.path)).toBe('custom name.pdf');
    } else {
      expect.fail('expected a saved outcome');
    }
  });

  it('rejects a blocked extension with file_blocked and writes nothing', () => {
    const out = saveAttachment(input({ originalFilename: 'malware.exe' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('file_blocked');
    expect(fs.existsSync(path.join(root, '2026', '06', 'malware.exe'))).toBe(false);
  });

  it('rejects a non-allowlisted MIME with mime_type_blocked', () => {
    const out = saveAttachment(
      input({
        mimeType: 'application/zip',
        policy: policy({ allowedMimeTypes: ['application/pdf'] }),
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('mime_type_blocked');
  });

  it('rejects an oversize attachment with file_too_large', () => {
    const out = saveAttachment(input({ policy: policy({ maxAttachmentBytes: 5 }) }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('file_too_large');
  });

  it('rejects a traversal targetDirectory with path_not_allowed', () => {
    const out = saveAttachment(input({ targetDirectory: '../escape' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('path_not_allowed');
  });

  it('append-counter resolves a collision to "name (1).ext"', () => {
    const first = saveAttachment(input());
    const second = saveAttachment(input());
    expect(first.ok && second.ok).toBe(true);
    if (second.ok && second.value.status === 'saved') {
      expect(second.value.saved.filename).toBe('invoice (1).pdf');
      expect(fs.existsSync(path.join(root, '2026', '06', 'invoice (1).pdf'))).toBe(true);
    }
  });

  it('fail collision policy returns an error (mapped to failed in bulk)', () => {
    const config = policy({ collisionPolicy: 'fail' });
    saveAttachment(input({ policy: config }));
    const second = saveAttachment(input({ policy: config }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invalid_input');
      expect(second.error.details).toMatchObject({ reason: 'file_exists' });
    }
  });

  it('overwrite policy rewrites the same path', () => {
    const config = policy({ collisionPolicy: 'overwrite' });
    const first = saveAttachment(input({ policy: config, bytes: Buffer.from('one') }));
    const second = saveAttachment(input({ policy: config, bytes: Buffer.from('two') }));
    if (first.ok && second.ok && second.value.status === 'saved') {
      expect(second.value.saved.path).toBe(path.join(root, '2026', '06', 'invoice.pdf'));
      expect(fs.readFileSync(second.value.saved.path).toString()).toBe('two');
    }
  });

  it('per-call overwrite override beats the configured policy', () => {
    saveAttachment(input({ bytes: Buffer.from('one') }));
    const second = saveAttachment(input({ overwrite: true, bytes: Buffer.from('two') }));
    if (second.ok && second.value.status === 'saved') {
      expect(second.value.saved.collisionPolicyApplied).toBe('overwrite');
      expect(fs.readFileSync(second.value.saved.path).toString()).toBe('two');
    }
  });

  it('content-addressed writes {sha256}.ext then skips a duplicate', () => {
    const config = policy({ collisionPolicy: 'content-addressed' });
    const first = saveAttachment(input({ policy: config }));
    const hashName = `${sha256Hex(BYTES)}.pdf`;
    if (first.ok && first.value.status === 'saved') {
      expect(first.value.saved.filename).toBe(hashName);
    }
    const second = saveAttachment(input({ policy: config }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.status).toBe('skipped');
      if (second.value.status === 'skipped') expect(second.value.reason).toBe('duplicate');
    }
  });

  it('generates a name when the original is empty', () => {
    const out = saveAttachment(input({ originalFilename: '' }));
    if (out.ok && out.value.status === 'saved') {
      expect(out.value.saved.filename).toBe('gmail-attachment-m1-2.pdf');
    } else {
      expect.fail('expected a saved outcome');
    }
  });

  it('saves into the root itself when targetDirectory is empty', () => {
    const out = saveAttachment(input({ targetDirectory: '' }));
    if (out.ok && out.value.status === 'saved') {
      expect(out.value.saved.path).toBe(path.join(fs.realpathSync(root), 'invoice.pdf'));
    } else {
      expect.fail('expected a saved outcome');
    }
  });
});
