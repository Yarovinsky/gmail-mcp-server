import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinRoot, resolveDownloadRoot } from '../../../src/attachments/pathGuard.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-root-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveWithinRoot (§12.8, §15.1, §22.1 #12)', () => {
  it('accepts an in-root relative path and returns it normalized', () => {
    const result = resolveWithinRoot(root, 'sub/dir/file.pdf');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(resolveDownloadRoot(root), 'sub', 'dir', 'file.pdf'));
    }
  });

  it('accepts the empty / "." path as the root itself', () => {
    expect(resolveWithinRoot(root, '').ok).toBe(true);
    const dot = resolveWithinRoot(root, '.');
    expect(dot.ok).toBe(true);
    if (dot.ok) expect(dot.value).toBe(resolveDownloadRoot(root));
  });

  it('normalizes redundant "./" segments', () => {
    const result = resolveWithinRoot(root, 'a/./b/../c/file.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(resolveDownloadRoot(root), 'a', 'c', 'file.txt'));
    }
  });

  it('rejects a parent-traversal escape with path_not_allowed', () => {
    const result = resolveWithinRoot(root, '../evil.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_not_allowed');
  });

  it('rejects a deep traversal that escapes the root', () => {
    const result = resolveWithinRoot(root, 'a/b/../../../evil.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_not_allowed');
  });

  it('rejects an absolute path', () => {
    const result = resolveWithinRoot(root, '/etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_not_allowed');
  });

  it('rejects a symlink that points outside the root', () => {
    // Create a sibling "outside" directory and a symlink inside root pointing to it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-outside-'));
    const linkPath = path.join(root, 'link');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outside, linkPath, 'dir');
      symlinkCreated = true;
    } catch {
      // Symlink creation can require privileges (e.g. Windows without dev mode); skip.
    }

    try {
      if (symlinkCreated) {
        const result = resolveWithinRoot(root, 'link/secret.txt');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('path_not_allowed');
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
