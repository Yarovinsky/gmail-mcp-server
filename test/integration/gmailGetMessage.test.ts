import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailGetMessageTool } from '../../src/tools/gmailGetMessage.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { Scope } from '../../src/auth/scopeProfiles.js';
import type { Config } from '../../src/config/config.js';

const RAW_RFC822 = encodeBase64Url('From: a@b.com\r\nSubject: Hello\r\n\r\nplain body text');

const FULL_MESSAGE = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  snippet: 'a snippet',
  internalDate: '1748765700000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'a@b.com' },
      { name: 'To', value: 'u@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Date', value: 'Mon, 1 Jun 2026 12:15:00 +0300' },
      { name: 'Message-ID', value: '<abc@x>' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          {
            partId: '0.0',
            mimeType: 'text/plain',
            body: { data: encodeBase64Url('plain body text') },
          },
          {
            partId: '0.1',
            mimeType: 'text/html',
            body: { data: encodeBase64Url('<p>html body</p>') },
          },
        ],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'doc.pdf',
        body: { attachmentId: 'att1', size: 2048 },
      },
    ],
  },
};

function fakeSession(): GmailSession {
  const api = {
    users: {
      messages: {
        get: async ({ format }: { format?: string }) => {
          if (format === 'raw') {
            return {
              data: {
                id: 'm1',
                threadId: 't1',
                labelIds: ['INBOX'],
                snippet: 'a snippet',
                internalDate: '1748765700000',
                raw: RAW_RFC822,
              },
            };
          }
          if (format === 'metadata') {
            return {
              data: {
                id: 'm1',
                threadId: 't1',
                labelIds: ['INBOX'],
                snippet: 'a snippet',
                internalDate: '1748765700000',
                payload: { headers: FULL_MESSAGE.payload.headers },
              },
            };
          }
          return { data: FULL_MESSAGE };
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
  registry.register(gmailGetMessageTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function allowRawConfig(): Config {
  const parsed = parseConfig({ safety: { allowRawMessage: true } });
  if (!parsed.ok) throw new Error('config');
  return parsed.value;
}

interface MessageView {
  body: { text: string | null; html: string | null; truncated: boolean } | null;
  attachments?: Array<Record<string, unknown>>;
  parts?: Array<Record<string, unknown>>;
  raw?: string | null;
  headers?: Record<string, unknown>;
}

async function getMessage(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message?: MessageView; error?: { code: string } }> {
  const result = await client.callTool({ name: 'gmail_get_message', arguments: args });
  return result.structuredContent as never;
}

describe('gmail_get_message (§12.4)', () => {
  it('parsed/text: returns the text body (html null), attachments, headers', async () => {
    const client = await connect(defaultConfig());
    const out = await getMessage(client, { messageId: 'm1' });
    expect(out.ok).toBe(true);
    expect(out.message?.body).toEqual({ text: 'plain body text', html: null, truncated: false });
    expect(out.message?.headers?.messageId).toBe('<abc@x>');
    expect(out.message?.attachments).toHaveLength(1);
    expect(out.message?.attachments?.[0]).toMatchObject({
      partId: '1',
      attachmentId: 'att1',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      disposition: 'attachment',
      inline: false,
    });
    await client.close();
  });

  it('bodyFormat html returns html (text null); both returns both', async () => {
    const client = await connect(defaultConfig());
    const htmlOut = await getMessage(client, { messageId: 'm1', bodyFormat: 'html' });
    expect(htmlOut.message?.body).toEqual({
      text: null,
      html: '<p>html body</p>',
      truncated: false,
    });

    const bothOut = await getMessage(client, { messageId: 'm1', bodyFormat: 'both' });
    expect(bothOut.message?.body).toEqual({
      text: 'plain body text',
      html: '<p>html body</p>',
      truncated: false,
    });
    await client.close();
  });

  it('flags truncation when maxBodyCharsPerMessage caps the body', async () => {
    const client = await connect(defaultConfig());
    const out = await getMessage(client, { messageId: 'm1', maxBodyCharsPerMessage: 4 });
    expect(out.message?.body).toEqual({ text: 'plai', html: null, truncated: true });
    await client.close();
  });

  it('includeBody:false returns a null body but keeps attachments', async () => {
    const client = await connect(defaultConfig());
    const out = await getMessage(client, { messageId: 'm1', includeBody: false });
    expect(out.message?.body).toBeNull();
    expect(out.message?.attachments).toHaveLength(1);
    await client.close();
  });

  it('metadata format returns headers + snippet but no body/attachments', async () => {
    const client = await connect(defaultConfig());
    const out = await getMessage(client, { messageId: 'm1', format: 'metadata' });
    expect(out.message?.body).toBeNull();
    expect(out.message?.attachments).toBeUndefined();
    expect(out.message?.headers?.subject).toBe('Hello');
    await client.close();
  });

  it('full format includes the flat parts list', async () => {
    const client = await connect(defaultConfig());
    const out = await getMessage(client, { messageId: 'm1', format: 'full' });
    expect(Array.isArray(out.message?.parts)).toBe(true);
    const partIds = out.message?.parts?.map((p) => p.partId);
    expect(partIds).toContain('1');
    await client.close();
  });

  it('format:raw requires safety.allowRawMessage (feature_disabled otherwise)', async () => {
    const blocked = await getMessage(await connect(defaultConfig()), {
      messageId: 'm1',
      format: 'raw',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('feature_disabled');

    const allowed = await getMessage(await connect(allowRawConfig()), {
      messageId: 'm1',
      format: 'raw',
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.message?.raw).toBe(RAW_RFC822);
    expect(allowed.message?.body).toBeUndefined();
  });

  it('includeRaw:true with allowRawMessage:false → feature_disabled', async () => {
    const out = await getMessage(await connect(defaultConfig()), {
      messageId: 'm1',
      includeRaw: true,
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('feature_disabled');
  });

  it('includeRaw:true with allowRawMessage:true adds raw alongside the parsed body', async () => {
    const out = await getMessage(await connect(allowRawConfig()), {
      messageId: 'm1',
      includeRaw: true,
    });
    expect(out.ok).toBe(true);
    expect(out.message?.raw).toBe(RAW_RFC822);
    expect(out.message?.body?.text).toBe('plain body text');
  });
});
