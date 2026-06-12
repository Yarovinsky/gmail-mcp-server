import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailGetAttachmentTool } from '../../src/tools/gmailGetAttachment.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { sha256Hex } from '../../src/attachments/hash.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const PDF_BYTES = Buffer.from('PDF-CONTENT-12');
const PNG_BYTES = Buffer.from('PNG-INLINE');

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
      { partId: '0', mimeType: 'text/plain', body: { data: encodeBase64Url('body') } },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        body: { attachmentId: 'att-pdf', size: PDF_BYTES.length },
      },
      {
        partId: '2',
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [
          { name: 'Content-Disposition', value: 'inline' },
          { name: 'Content-Id', value: '<logo>' },
        ],
        body: { data: encodeBase64Url(PNG_BYTES), size: PNG_BYTES.length },
      },
    ],
  },
};

function fakeSession(grantedScopes: string[]): GmailSession {
  const api = {
    users: {
      messages: {
        get: async () => ({ data: MESSAGE }),
        attachments: {
          get: async () => ({
            data: { data: encodeBase64Url(PDF_BYTES), size: PDF_BYTES.length },
          }),
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailGetAttachmentTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function withClient(
  config = defaultConfig(),
  grantedScopes: string[] = [Scope.GmailReadonly],
): Promise<Client> {
  const session = fakeSession(grantedScopes);
  return connect(
    { config, logger: createSilentLogger(), session },
    buildToolGate(config, session.grantedScopes, true),
  );
}

interface AttachmentResult {
  ok?: boolean;
  attachment?: {
    messageId: string;
    partId?: string;
    attachmentId?: string;
    filename: string;
    mimeType: string;
    size: number;
    sha256: string;
    dataBase64: string;
  };
  error?: { code: string };
}

async function get(client: Client, args: Record<string, unknown>): Promise<AttachmentResult> {
  const result = await client.callTool({
    name: 'gmail_get_attachment',
    arguments: { messageId: 'm1', ...args },
  });
  return result.structuredContent as never;
}

describe('gmail_get_attachment (§12.7)', () => {
  it('returns an external attachment as base64 with sha256 (§12.7 shape)', async () => {
    const client = await withClient();
    const out = await get(client, { attachmentId: 'att-pdf' });
    expect(out.attachment).toMatchObject({
      messageId: 'm1',
      partId: '1',
      attachmentId: 'att-pdf',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
      sha256: sha256Hex(PDF_BYTES),
      dataBase64: PDF_BYTES.toString('base64'),
    });
    await client.close();
  });

  it('can select by partId', async () => {
    const client = await withClient();
    const out = await get(client, { partId: '1' });
    expect(out.attachment?.attachmentId).toBe('att-pdf');
    expect(out.attachment?.dataBase64).toBe(PDF_BYTES.toString('base64'));
    await client.close();
  });

  it('returns inline part bytes directly (no separate fetch)', async () => {
    const client = await withClient();
    const out = await get(client, { partId: '2' });
    expect(out.attachment?.filename).toBe('logo.png');
    expect(out.attachment?.dataBase64).toBe(PNG_BYTES.toString('base64'));
    expect(out.attachment?.sha256).toBe(sha256Hex(PNG_BYTES));
    await client.close();
  });

  it('returns file_too_large when the declared size exceeds per-call maxBytes', async () => {
    const client = await withClient();
    const out = await get(client, { attachmentId: 'att-pdf', maxBytes: 4 });
    expect(out.error?.code).toBe('file_too_large');
    await client.close();
  });

  it('returns file_too_large when the size exceeds maxAttachmentBytes', async () => {
    const parsed = parseConfig({ limits: { maxAttachmentBytes: 4 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const client = await withClient(parsed.value);
    const out = await get(client, { attachmentId: 'att-pdf' });
    expect(out.error?.code).toBe('file_too_large');
    await client.close();
  });

  it('returns not_found for an unknown attachmentId', async () => {
    const client = await withClient();
    const out = await get(client, { attachmentId: 'nope' });
    expect(out.error?.code).toBe('not_found');
    await client.close();
  });

  it('returns invalid_input when neither attachmentId nor partId is given', async () => {
    const client = await withClient();
    const out = await get(client, {});
    expect(out.error?.code).toBe('invalid_input');
    await client.close();
  });

  it('returns feature_disabled when features.attachments is off', async () => {
    const parsed = parseConfig({ features: { attachments: false } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const client = await withClient(parsed.value);
    const result = await client.callTool({
      name: 'gmail_get_attachment',
      arguments: { messageId: 'm1', attachmentId: 'att-pdf' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'feature_disabled' },
    });
    await client.close();
  });
});
