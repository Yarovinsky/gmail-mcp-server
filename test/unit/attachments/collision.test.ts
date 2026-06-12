import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveCollision, type CollisionPolicy } from '../../../src/attachments/collision.js';

const DIR = path.join(path.sep, 'downloads');
const SHA = 'a'.repeat(64);

function existsIn(...names: string[]) {
  const set = new Set(names.map((n) => path.join(DIR, n)));
  return (p: string) => set.has(p);
}

function resolve(
  policy: CollisionPolicy,
  filename: string,
  exists: (p: string) => boolean,
  sha256 = SHA,
) {
  return resolveCollision({ dir: DIR, filename, policy, sha256, exists });
}

describe('resolveCollision (§15.3, §22.1 #13)', () => {
  describe('append-counter (default)', () => {
    it('writes the original name when nothing exists', () => {
      const out = resolve('append-counter', 'file.pdf', existsIn());
      expect(out).toEqual({
        kind: 'write',
        path: path.join(DIR, 'file.pdf'),
        filename: 'file.pdf',
      });
    });

    it('appends (1) when the original exists', () => {
      const out = resolve('append-counter', 'file.pdf', existsIn('file.pdf'));
      expect(out).toEqual({
        kind: 'write',
        path: path.join(DIR, 'file (1).pdf'),
        filename: 'file (1).pdf',
      });
    });

    it('increments past existing counters', () => {
      const out = resolve('append-counter', 'file.pdf', existsIn('file.pdf', 'file (1).pdf'));
      expect(out.kind).toBe('write');
      if (out.kind === 'write') expect(out.filename).toBe('file (2).pdf');
    });

    it('appends a counter for an extensionless name', () => {
      const out = resolve('append-counter', 'README', existsIn('README'));
      if (out.kind === 'write') expect(out.filename).toBe('README (1)');
    });
  });

  describe('overwrite', () => {
    it('writes the target path directly even when it exists', () => {
      const out = resolve('overwrite', 'file.pdf', existsIn('file.pdf'));
      expect(out).toEqual({
        kind: 'write',
        path: path.join(DIR, 'file.pdf'),
        filename: 'file.pdf',
      });
    });
  });

  describe('fail', () => {
    it('writes when the target is free', () => {
      const out = resolve('fail', 'file.pdf', existsIn());
      expect(out.kind).toBe('write');
    });

    it('fails when the target already exists', () => {
      const out = resolve('fail', 'file.pdf', existsIn('file.pdf'));
      expect(out.kind).toBe('fail');
      if (out.kind === 'fail') expect(out.reason).toContain('already exists');
    });
  });

  describe('content-addressed', () => {
    it('writes {sha256}.{ext} when the hash file does not exist', () => {
      const out = resolve('content-addressed', 'invoice.pdf', existsIn());
      expect(out).toEqual({
        kind: 'write',
        path: path.join(DIR, `${SHA}.pdf`),
        filename: `${SHA}.pdf`,
      });
    });

    it('skips when an identical hash file already exists', () => {
      const out = resolve('content-addressed', 'invoice.pdf', existsIn(`${SHA}.pdf`));
      expect(out.kind).toBe('skip');
      if (out.kind === 'skip') {
        expect(out.filename).toBe(`${SHA}.pdf`);
        expect(out.reason).toContain('content-addressed');
      }
    });

    it('uses just the sha256 when there is no extension', () => {
      const out = resolve('content-addressed', 'noext', existsIn());
      if (out.kind === 'write') expect(out.filename).toBe(SHA);
    });

    it('ignores the desired filename entirely (hash drives the name)', () => {
      const a = resolve('content-addressed', 'one.pdf', existsIn());
      const b = resolve('content-addressed', 'two.pdf', existsIn());
      if (a.kind === 'write' && b.kind === 'write') expect(a.filename).toBe(b.filename);
    });
  });
});
