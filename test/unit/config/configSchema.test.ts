import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  parseConfig,
  defaultConfig,
  type Config,
} from '../../../src/config/configSchema.js';

/** The literal HLD §10 example config. */
const EXAMPLE_CONFIG = {
  activeProfile: 'default',
  transport: 'stdio',
  oauth: {
    credentialsPath: '~/.gmail-mcp/credentials.json',
    tokenPath: '~/.gmail-mcp/tokens/default.json',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  features: {
    profile: true,
    labels: true,
    labelsWrite: false,
    search: true,
    readMessages: true,
    readThreads: true,
    attachments: true,
    drafts: false,
    send: false,
    modify: false,
    history: false,
  },
  limits: {
    defaultPageSize: 10,
    maxPageSize: 100,
    maxMessageBodyChars: 20000,
    maxAttachmentBytes: 52428800,
    maxBulkDownloadCount: 50,
    toolResponseBodyCharLimit: 50000,
  },
  downloads: {
    enabled: true,
    rootDir: '~/Downloads/gmail-mcp',
    preserveOriginalFilenames: true,
    collisionPolicy: 'append-counter',
    allowedMimeTypes: [],
    blockedExtensions: [
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
    ],
    includeInlineAttachmentsByDefault: false,
  },
  safety: {
    requireConfirmationForSend: true,
    requireConfirmationForModify: true,
    requireConfirmationForBulkDownload: true,
    bulkDownloadConfirmationThreshold: 10,
    redactAccessTokensInLogs: true,
    disableRawHtmlBodyByDefault: true,
    allowRawMessage: false,
  },
  logging: {
    level: 'info',
    auditLogPath: '~/.gmail-mcp/audit.jsonl',
  },
} as const;

describe('ConfigSchema round-trip', () => {
  it('parses the literal §10 example and round-trips it unchanged', () => {
    const parsed = ConfigSchema.parse(EXAMPLE_CONFIG);
    expect(parsed).toEqual(EXAMPLE_CONFIG);
  });
});

describe('ConfigSchema defaults (§9.3 / §10)', () => {
  it('an empty object fills in every §10 default', () => {
    expect(defaultConfig()).toEqual(EXAMPLE_CONFIG);
  });

  it('applies the §9.3 feature defaults (read true, write/optional false)', () => {
    const features = defaultConfig().features;
    expect(features.search).toBe(true);
    expect(features.readMessages).toBe(true);
    expect(features.attachments).toBe(true);
    expect(features.drafts).toBe(false);
    expect(features.send).toBe(false);
    expect(features.modify).toBe(false);
    expect(features.labelsWrite).toBe(false);
    expect(features.history).toBe(false);
  });

  it('deep-merges partial input over defaults', () => {
    const cfg = ConfigSchema.parse({ features: { drafts: true } });
    expect(cfg.features.drafts).toBe(true);
    expect(cfg.features.search).toBe(true); // untouched default
    expect(cfg.transport).toBe('stdio'); // untouched default
  });
});

describe('ConfigSchema rejects invalid values', () => {
  it('rejects an unknown feature key', () => {
    const r = parseConfig({ features: { notAFeature: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('rejects a negative maxPageSize', () => {
    const r = parseConfig({ limits: { maxPageSize: -5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('rejects a non-enum collisionPolicy', () => {
    const r = parseConfig({ downloads: { collisionPolicy: 'nope' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(Array.isArray((r.error.details as { issues: unknown[] }).issues)).toBe(true);
    }
  });

  it('rejects an unknown transport', () => {
    expect(parseConfig({ transport: 'ftp' }).ok).toBe(false);
  });
});

describe('parseConfig success', () => {
  it('returns ok with the effective config', () => {
    const r = parseConfig(EXAMPLE_CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cfg: Config = r.value;
      expect(cfg.activeProfile).toBe('default');
    }
  });
});
