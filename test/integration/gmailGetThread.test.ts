import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailGetThreadTool } from '../../src/tools/gmailGetThread.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { encodeBase64Url } from '../../src/mime/base64url.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

function makeMessage(id: string, bodyText: string) {
  return {
    id,
    threadId: 'thread-1',
    labelIds: ['INBOX'],
    snippet: `snippet ${id}`,
    internalDate: '1748765700000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `from-${id}@example.com` },
        { name: 'Subject', value: `Subject ${id}` },
      ],
      body: { data: encodeBase64Url(bodyText) },
    },
  };
}

const THREAD = {
  id: 'thread-1',
  messages: [
    makeMessage('m1', 'body one'),
    makeMessage('m2', 'body two'),
    makeMessage('m3', 'body three'),
  ],
};

function fakeSession(): GmailSession {
  const api = {
    users: {
      threads: {
        get: async () => ({ data: THREAD }),
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailGetThreadTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface ThreadView {
  thread: {
    id: string;
    truncated: boolean;
    messages: Array<{
      id: string;
      body: { text: string | null; html: string | null; truncated: boolean } | null;
      attachments?: unknown[];
      headers?: Record<string, unknown>;
    }>;
  };
}

async function getThread(client: Client, args: Record<string, unknown>): Promise<ThreadView> {
  const result = await client.callTool({
    name: 'gmail_get_thread',
    arguments: { threadId: 't', ...args },
  });
  return result.structuredContent as never;
}

describe('gmail_get_thread (§12.5)', () => {
  it('omits bodies by default (body null) but includes attachments array', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );
    const out = await getThread(client, {});
    expect(out.thread.messages).toHaveLength(3);
    expect(out.thread.messages[0].body).toBeNull();
    expect(out.thread.messages[0].attachments).toEqual([]);
    expect(out.thread.messages[0].headers?.subject).toBe('Subject m1');
    expect(out.thread.truncated).toBe(false);
    await client.close();
  });

  it('includes bodies when includeBodies is true', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );
    const out = await getThread(client, { includeBodies: true });
    expect(out.thread.messages[0].body).toEqual({ text: 'body one', html: null, truncated: false });
    expect(out.thread.messages[1].body?.text).toBe('body two');
    await client.close();
  });

  it('bounds messages by maxMessages and flags truncation', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );
    const out = await getThread(client, { maxMessages: 2 });
    expect(out.thread.messages).toHaveLength(2);
    expect(out.thread.truncated).toBe(true);
    await client.close();
  });

  it('omits attachments when includeAttachmentMetadata is false', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );
    const out = await getThread(client, { includeAttachmentMetadata: false });
    expect(out.thread.messages[0].attachments).toBeUndefined();
    await client.close();
  });
});
