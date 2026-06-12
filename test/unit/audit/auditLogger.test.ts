import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileAuditLogger } from '../../../src/audit/auditLogger.js';
import { toAuditRecord, AUDIT_FIELDS, type AuditEvent } from '../../../src/audit/auditEvents.js';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-audit-'));
  logPath = path.join(dir, 'nested', 'audit.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLines(): Record<string, unknown>[] {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SAVE_EVENT: AuditEvent = {
  timestamp: '2026-06-13T00:00:00.000Z',
  tool: 'gmail_save_attachment',
  status: 'saved',
  messageId: 'm1',
  filenames: ['invoice.pdf'],
  paths: ['/root/2026/06/invoice.pdf'],
  sha256: ['abc123'],
  size: 1234,
};

describe('toAuditRecord (§16.5, §22.1 #16)', () => {
  it('keeps only allowlisted, defined fields', () => {
    const record = toAuditRecord(SAVE_EVENT);
    expect(Object.keys(record).sort()).toEqual(
      ['filenames', 'messageId', 'paths', 'sha256', 'size', 'status', 'timestamp', 'tool'].sort(),
    );
  });

  it('drops any non-allowlisted keys (token/body/bytes/raw can never leak)', () => {
    const tainted = {
      ...SAVE_EVENT,
      accessToken: 'ya29.SECRET',
      refreshToken: '1//SECRET',
      body: 'full message body text',
      dataBase64: 'QUJD',
      raw: 'From: ...full MIME...',
    } as unknown as AuditEvent;
    const record = toAuditRecord(tainted);
    for (const key of Object.keys(record)) {
      expect(AUDIT_FIELDS).toContain(key);
    }
    expect(record).not.toHaveProperty('accessToken');
    expect(record).not.toHaveProperty('refreshToken');
    expect(record).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('dataBase64');
    expect(record).not.toHaveProperty('raw');
  });
});

describe('createFileAuditLogger (§16.5)', () => {
  it('appends JSONL records, creating the parent directory', () => {
    const logger = createFileAuditLogger(logPath);
    logger.record(SAVE_EVENT);
    logger.record({ ...SAVE_EVENT, status: 'skipped' });

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tool: 'gmail_save_attachment', status: 'saved', size: 1234 });
    expect(lines[1]).toMatchObject({ status: 'skipped' });
  });

  it('never writes a token, body, attachment bytes, or raw MIME', () => {
    const logger = createFileAuditLogger(logPath);
    logger.record({
      ...SAVE_EVENT,
      accessToken: 'ya29.SECRET',
      dataBase64: 'QUJDREVG',
      body: 'secret body',
    } as unknown as AuditEvent);

    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).not.toContain('ya29.SECRET');
    expect(raw).not.toContain('QUJDREVG');
    expect(raw).not.toContain('secret body');
    // Allowlisted fields are present.
    expect(raw).toContain('invoice.pdf');
    expect(raw).toContain('"sha256"');
  });

  it('does not throw when the path is unwritable (best-effort)', () => {
    // A directory where the log path itself is an existing directory → append fails.
    fs.mkdirSync(logPath, { recursive: true });
    const logger = createFileAuditLogger(logPath);
    expect(() => logger.record(SAVE_EVENT)).not.toThrow();
  });
});
