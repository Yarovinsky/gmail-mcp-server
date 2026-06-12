import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailSaveAttachmentsTool } from '../../src/tools/gmailSaveAttachments.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, type Config } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const PDF = Buffer.from('PDF-CONTENT');
const EXE = Buffer.from('MZ-EXE');
const TXT = Buffer.from('plain notes');
const BYTES_BY_ID: Record<string, Buffer> = { 'att-pdf': PDF, 'att-exe': EXE, 'att-txt': TXT };

const MESSAGE = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  snippet: 's',
  internalDate: '1748765700000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'Subject', value: 'Has attachments' }],
    parts: [
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        body: { attachmentId: 'att-pdf', size: PDF.length },
      },
      {
        partId: '2',
        mimeType: 'application/x-msdownload',
        filename: 'malware.exe',
        body: { attachmentId: 'att-exe', size: EXE.length },
      },
      {
        partId: '3',
        mimeType: 'text/plain',
        filename: 'notes.txt',
        body: { attachmentId: 'att-txt', size: TXT.length },
      },
    ],
  },
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-bulk-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function configWith(overrides: Record<string, unknown> = {}): Config {
  const parsed = parseConfig({ downloads: { rootDir: root }, ...overrides });
  if (!parsed.ok) throw new Error('config parse failed');
  return parsed.value;
}

function fakeSession(): GmailSession {
  const api = {
    users: {
      messages: {
        get: async () => ({ data: MESSAGE }),
        attachments: {
          get: async ({ id }: { id: string }) => ({
            data: { data: encodeBase64Url(BYTES_BY_ID[id]), size: BYTES_BY_ID[id].length },
          }),
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(config: Config): Promise<Client> {
  const session = fakeSession();
  const context: ToolContext = { config, logger: createSilentLogger(), session };
  const gate: ToolGate = buildToolGate(config, session.grantedScopes, true);
  const registry = new ToolRegistry();
  registry.register(gmailSaveAttachmentsTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface BulkResult {
  ok?: boolean;
  saved?: Array<{ attachmentId: string | null; filename: string }>;
  skipped?: Array<{ attachmentId: string | null; reason: string }>;
  failed?: Array<{ attachmentId: string | null; error: { code: string } }>;
  error?: { code: string };
}

async function saveAll(client: Client, args: Record<string, unknown>): Promise<BulkResult> {
  const result = await client.callTool({ name: 'gmail_save_attachments', arguments: args });
  return result.structuredContent as never;
}

describe('gmail_save_attachments (§12.9, §26.4)', () => {
  it('partitions results: one failing item does not abort the rest', async () => {
    const client = await connect(configWith());
    const out = await saveAll(client, {
      items: [
        { messageId: 'm1', attachmentId: 'att-pdf' },
        { messageId: 'm1', attachmentId: 'att-exe' }, // blocked extension
        { messageId: 'm1', attachmentId: 'att-txt' },
      ],
    });
    expect(out.saved).toHaveLength(2);
    expect(out.failed).toHaveLength(1);
    expect(out.failed?.[0]).toMatchObject({
      attachmentId: 'att-exe',
      error: { code: 'file_blocked' },
    });
    expect(fs.existsSync(path.join(fs.realpathSync(root), 'invoice.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(fs.realpathSync(root), 'notes.txt'))).toBe(true);
    await client.close();
  });

  it('hard-rejects over maxBulkDownloadCount before downloading anything', async () => {
    const client = await connect(configWith({ limits: { maxBulkDownloadCount: 2 } }));
    const out = await saveAll(client, {
      items: [
        { messageId: 'm1', attachmentId: 'att-pdf' },
        { messageId: 'm1', attachmentId: 'att-txt' },
        { messageId: 'm1', attachmentId: 'att-pdf' },
      ],
    });
    expect(out.error?.code).toBe('invalid_input');
    expect(fs.existsSync(path.join(fs.realpathSync(root), 'invoice.pdf'))).toBe(false);
    await client.close();
  });

  it('requires confirmation over the threshold, then proceeds with confirm:true (§26.4)', async () => {
    const client = await connect(configWith({ safety: { bulkDownloadConfirmationThreshold: 1 } }));
    const items = [
      { messageId: 'm1', attachmentId: 'att-pdf' },
      { messageId: 'm1', attachmentId: 'att-txt' },
    ];

    const blocked = await saveAll(client, { items });
    expect(blocked.error?.code).toBe('confirmation_required');

    const confirmed = await saveAll(client, { items, confirm: true });
    expect(confirmed.saved).toHaveLength(2);
    await client.close();
  });

  it('surfaces a fail-collision in failed (not skipped)', async () => {
    const client = await connect(configWith({ downloads: { collisionPolicy: 'fail' } }));
    const out = await saveAll(client, {
      items: [
        { messageId: 'm1', attachmentId: 'att-pdf' },
        { messageId: 'm1', attachmentId: 'att-pdf' },
      ],
    });
    expect(out.saved).toHaveLength(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed?.[0].error.code).toBe('invalid_input');
    await client.close();
  });

  it('surfaces a content-addressed duplicate in skipped', async () => {
    const client = await connect(
      configWith({ downloads: { collisionPolicy: 'content-addressed' } }),
    );
    const out = await saveAll(client, {
      items: [
        { messageId: 'm1', attachmentId: 'att-pdf' },
        { messageId: 'm1', attachmentId: 'att-pdf' },
      ],
    });
    expect(out.saved).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped?.[0].reason).toBe('duplicate');
    await client.close();
  });

  it('reports an item missing both ids as failed while saving the rest', async () => {
    const client = await connect(configWith());
    const out = await saveAll(client, {
      items: [{ messageId: 'm1' }, { messageId: 'm1', attachmentId: 'att-pdf' }],
    });
    expect(out.failed?.[0].error.code).toBe('invalid_input');
    expect(out.saved).toHaveLength(1);
    await client.close();
  });

  it('returns feature_disabled when downloads.enabled is false', async () => {
    const client = await connect(configWith({ downloads: { enabled: false } }));
    const out = await saveAll(client, { items: [{ messageId: 'm1', attachmentId: 'att-pdf' }] });
    expect(out.error?.code).toBe('feature_disabled');
    await client.close();
  });

  it('rejects an empty items array with invalid_input', async () => {
    const client = await connect(configWith());
    const out = await saveAll(client, { items: [] });
    expect(out.error?.code).toBe('invalid_input');
    await client.close();
  });
});
