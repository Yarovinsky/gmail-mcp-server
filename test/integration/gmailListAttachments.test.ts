import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailListAttachmentsTool } from '../../src/tools/gmailListAttachments.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const MESSAGE = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  snippet: 'has attachments',
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
        body: { attachmentId: 'att-pdf', size: 1234 },
      },
      {
        partId: '2',
        mimeType: 'application/x-msdownload',
        filename: 'malware.exe',
        body: { attachmentId: 'att-exe', size: 10 },
      },
      {
        partId: '3',
        mimeType: 'application/zip',
        filename: 'big.zip',
        body: { attachmentId: 'att-zip', size: 99_000_000 },
      },
      {
        partId: '4',
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [
          { name: 'Content-Disposition', value: 'inline' },
          { name: 'Content-Id', value: '<logo>' },
        ],
        body: { attachmentId: 'att-png', size: 50 },
      },
    ],
  },
};

function fakeSession(grantedScopes: string[]): GmailSession {
  const api = {
    users: { messages: { get: async () => ({ data: MESSAGE }) } },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailListAttachmentsTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface Listing {
  ok: boolean;
  attachments: Array<{
    messageId: string;
    partId?: string;
    attachmentId?: string;
    filename: string;
    mimeType: string;
    size: number;
    inline: boolean;
    downloadAllowed: boolean;
    blockedReason: string | null;
  }>;
}

async function list(client: Client, args: Record<string, unknown> = {}): Promise<Listing> {
  const result = await client.callTool({
    name: 'gmail_list_attachments',
    arguments: { messageId: 'm1', ...args },
  });
  return result.structuredContent as never;
}

describe('gmail_list_attachments (§12.6)', () => {
  it('lists non-inline attachments with advisory downloadAllowed / blockedReason', async () => {
    const config = defaultConfig();
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const out = await list(client);
    // Inline logo.png excluded by default; 3 real attachments remain.
    expect(out.attachments).toHaveLength(3);
    const byName = Object.fromEntries(out.attachments.map((a) => [a.filename, a]));

    expect(byName['report.pdf']).toMatchObject({
      messageId: 'm1',
      partId: '1',
      attachmentId: 'att-pdf',
      mimeType: 'application/pdf',
      size: 1234,
      inline: false,
      downloadAllowed: true,
      blockedReason: null,
    });
    expect(byName['malware.exe']).toMatchObject({
      downloadAllowed: false,
      blockedReason: 'file_blocked',
    });
    expect(byName['big.zip']).toMatchObject({
      downloadAllowed: false,
      blockedReason: 'file_too_large',
    });
    await client.close();
  });

  it('includes inline attachments when includeInline is true', async () => {
    const config = defaultConfig();
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const out = await list(client, { includeInline: true });
    expect(out.attachments).toHaveLength(4);
    const logo = out.attachments.find((a) => a.filename === 'logo.png');
    expect(logo?.inline).toBe(true);
    await client.close();
  });

  it('respects downloads.includeInlineAttachmentsByDefault for the default', async () => {
    const parsed = parseConfig({ downloads: { includeInlineAttachmentsByDefault: true } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = parsed.value;
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const out = await list(client); // no includeInline → uses the config default (true)
    expect(out.attachments).toHaveLength(4);
    await client.close();
  });

  it('returns feature_disabled when features.attachments is off', async () => {
    const parsed = parseConfig({ features: { attachments: false } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = parsed.value;
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({
      name: 'gmail_list_attachments',
      arguments: { messageId: 'm1' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'feature_disabled' },
    });
    await client.close();
  });

  it('returns insufficient_scope when only send/compose is granted', async () => {
    const config = defaultConfig();
    const session = fakeSession([Scope.GmailSend]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({
      name: 'gmail_list_attachments',
      arguments: { messageId: 'm1' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'insufficient_scope' },
    });
    await client.close();
  });
});
