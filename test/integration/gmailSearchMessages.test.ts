import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailSearchMessagesTool } from '../../src/tools/gmailSearchMessages.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

interface Captured {
  listParams?: Record<string, unknown>;
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      messages: {
        list: async (params: Record<string, unknown>) => {
          captured.listParams = params;
          return { data: { messages: [{ id: 'm1', threadId: 't1' }] } };
        },
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            threadId: 't1',
            labelIds: ['INBOX'],
            snippet: 's',
            internalDate: '1748765700000',
            payload: {
              mimeType: 'text/plain',
              headers: [{ name: 'From', value: 'a@b.com' }],
              body: {},
            },
          },
        }),
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailSearchMessagesTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('gmail_search_messages (§12.3, §22.1 #17)', () => {
  it('clamps maxResults to maxPageSize and defaults format to metadata', async () => {
    const config = defaultConfig(); // maxPageSize 100
    const captured: Captured = {};
    const session = fakeSession(captured);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({
      name: 'gmail_search_messages',
      arguments: { query: 'test', maxResults: 9999 },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.listParams?.maxResults).toBe(100); // clamped

    const structured = result.structuredContent as { messages: Array<{ headers: object }> };
    // Default format metadata → headers object present (with the `to` key).
    expect(structured.messages[0]).toHaveProperty('headers');
    expect(structured.messages[0].headers).toHaveProperty('to');
    await client.close();
  });

  it('defaults maxResults to defaultPageSize when omitted', async () => {
    const config = defaultConfig(); // defaultPageSize 10
    const captured: Captured = {};
    const session = fakeSession(captured);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    await client.callTool({ name: 'gmail_search_messages', arguments: { query: 'x' } });
    expect(captured.listParams?.maxResults).toBe(10);
    await client.close();
  });
});
