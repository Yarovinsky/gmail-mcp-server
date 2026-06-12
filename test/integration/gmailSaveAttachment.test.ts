import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailSaveAttachmentTool } from '../../src/tools/gmailSaveAttachment.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, type Config } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { sha256Hex } from '../../src/attachments/hash.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const PDF_BYTES = Buffer.from('PDF-CONTENT');
const EXE_BYTES = Buffer.from('MZ-EXE');
const BYTES_BY_ID: Record<string, Buffer> = { 'att-pdf': PDF_BYTES, 'att-exe': EXE_BYTES };

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
        body: { attachmentId: 'att-pdf', size: PDF_BYTES.length },
      },
      {
        partId: '2',
        mimeType: 'application/x-msdownload',
        filename: 'malware.exe',
        body: { attachmentId: 'att-exe', size: EXE_BYTES.length },
      },
    ],
  },
};

let root: string;
let realRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-dl-'));
  realRoot = fs.realpathSync(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function configWith(overrides: Record<string, unknown> = {}): Config {
  const parsed = parseConfig({ downloads: { rootDir: root, ...overrides } });
  if (!parsed.ok) throw new Error('config parse failed');
  return parsed.value;
}

function fakeSession(grantedScopes: string[]): GmailSession {
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
  return { gmail, grantedScopes };
}

async function connect(config: Config, grantedScopes = [Scope.GmailReadonly]): Promise<Client> {
  const session = fakeSession(grantedScopes);
  const context: ToolContext = { config, logger: createSilentLogger(), session };
  const gate: ToolGate = buildToolGate(config, session.grantedScopes, true);
  const registry = new ToolRegistry();
  registry.register(gmailSaveAttachmentTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface SaveResult {
  ok?: boolean;
  savedAttachment?: {
    path: string;
    filename: string;
    mimeType: string;
    size: number;
    sha256: string;
    collisionPolicyApplied: string;
  };
  skipped?: boolean;
  reason?: string;
  error?: { code: string };
}

async function save(client: Client, args: Record<string, unknown>): Promise<SaveResult> {
  const result = await client.callTool({
    name: 'gmail_save_attachment',
    arguments: { messageId: 'm1', ...args },
  });
  return result.structuredContent as never;
}

describe('gmail_save_attachment (§12.8, §26.4)', () => {
  it('saves a PDF under the download root and returns the §12.8 object', async () => {
    const client = await connect(configWith());
    const out = await save(client, { attachmentId: 'att-pdf', targetDirectory: '2026/06' });
    expect(out.savedAttachment).toMatchObject({
      path: path.join(realRoot, '2026', '06', 'invoice.pdf'),
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
      sha256: sha256Hex(PDF_BYTES),
      collisionPolicyApplied: 'append-counter',
    });
    expect(fs.readFileSync(path.join(realRoot, '2026', '06', 'invoice.pdf'))).toEqual(PDF_BYTES);
    await client.close();
  });

  it('rejects a path-traversal targetDirectory (§26.4)', async () => {
    const client = await connect(configWith());
    const out = await save(client, { attachmentId: 'att-pdf', targetDirectory: '../escape' });
    expect(out.error?.code).toBe('path_not_allowed');
    await client.close();
  });

  it('rejects a blocked-extension attachment (§26.4)', async () => {
    const client = await connect(configWith());
    const out = await save(client, { attachmentId: 'att-exe' });
    expect(out.error?.code).toBe('file_blocked');
    await client.close();
  });

  it('returns feature_disabled when features.attachments is off', async () => {
    const parsed = parseConfig({ features: { attachments: false }, downloads: { rootDir: root } });
    if (!parsed.ok) throw new Error('config parse failed');
    const client = await connect(parsed.value);
    const result = await client.callTool({
      name: 'gmail_save_attachment',
      arguments: { messageId: 'm1', attachmentId: 'att-pdf' },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'feature_disabled' },
    });
    await client.close();
  });

  it('returns feature_disabled when downloads.enabled is false', async () => {
    const client = await connect(configWith({ enabled: false }));
    const out = await save(client, { attachmentId: 'att-pdf' });
    expect(out.error?.code).toBe('feature_disabled');
    await client.close();
  });

  it('returns invalid_input when neither attachmentId nor partId is given', async () => {
    const client = await connect(configWith());
    const out = await save(client, {});
    expect(out.error?.code).toBe('invalid_input');
    await client.close();
  });

  it('skips a content-addressed duplicate on the second save', async () => {
    const client = await connect(configWith({ collisionPolicy: 'content-addressed' }));
    const first = await save(client, { attachmentId: 'att-pdf' });
    expect(first.savedAttachment?.filename).toBe(`${sha256Hex(PDF_BYTES)}.pdf`);
    const second = await save(client, { attachmentId: 'att-pdf' });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('duplicate');
    await client.close();
  });
});
