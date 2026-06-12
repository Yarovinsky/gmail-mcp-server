import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailSaveAttachmentTool } from '../../src/tools/gmailSaveAttachment.js';
import { gmailGetAttachmentTool } from '../../src/tools/gmailGetAttachment.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, type Config } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { sha256Hex } from '../../src/attachments/hash.js';
import type { AuditEvent } from '../../src/audit/auditEvents.js';
import type { AuditLogger } from '../../src/audit/auditLogger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const PDF = Buffer.from('PDF-CONTENT');

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
    ],
  },
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-audit-int-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function config(): Config {
  const parsed = parseConfig({ downloads: { rootDir: root } });
  if (!parsed.ok) throw new Error('config parse failed');
  return parsed.value;
}

function fakeSession(): GmailSession {
  const api = {
    users: {
      messages: {
        get: async () => ({ data: MESSAGE }),
        attachments: {
          get: async () => ({ data: { data: encodeBase64Url(PDF), size: PDF.length } }),
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(events: AuditEvent[]): Promise<Client> {
  const cfg = config();
  const session = fakeSession();
  const audit: AuditLogger = { record: (e) => events.push(e) };
  const context: ToolContext = { config: cfg, logger: createSilentLogger(), session, audit };
  const gate: ToolGate = buildToolGate(cfg, session.grantedScopes, true);
  const registry = new ToolRegistry();
  registry.register(gmailSaveAttachmentTool);
  registry.register(gmailGetAttachmentTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('attachment audit wiring (§16.5)', () => {
  it('gmail_save_attachment emits a saved audit record with allowlisted fields', async () => {
    const events: AuditEvent[] = [];
    const client = await connect(events);
    await client.callTool({
      name: 'gmail_save_attachment',
      arguments: { messageId: 'm1', attachmentId: 'att-pdf' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'gmail_save_attachment',
      status: 'saved',
      messageId: 'm1',
      filenames: ['invoice.pdf'],
      sha256: [sha256Hex(PDF)],
      size: PDF.length,
    });
    // The bytes themselves are never in the audit event.
    expect(JSON.stringify(events[0])).not.toContain(PDF.toString('base64'));
    await client.close();
  });

  it('gmail_get_attachment emits an audit record without the bytes', async () => {
    const events: AuditEvent[] = [];
    const client = await connect(events);
    await client.callTool({
      name: 'gmail_get_attachment',
      arguments: { messageId: 'm1', attachmentId: 'att-pdf' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'gmail_get_attachment',
      status: 'ok',
      sha256: [sha256Hex(PDF)],
      size: PDF.length,
    });
    expect(JSON.stringify(events[0])).not.toContain(PDF.toString('base64'));
    await client.close();
  });

  it('emits a failed audit record (with error code) for a blocked save', async () => {
    const events: AuditEvent[] = [];
    const client = await connect(events);
    // Use the configured root but a blocked extension via a requested filename.
    await client.callTool({
      name: 'gmail_save_attachment',
      arguments: { messageId: 'm1', attachmentId: 'att-pdf', filename: 'evil.exe' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'gmail_save_attachment',
      status: 'failed',
      errorCode: 'file_blocked',
    });
    await client.close();
  });
});
