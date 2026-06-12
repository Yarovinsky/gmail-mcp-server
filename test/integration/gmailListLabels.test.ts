import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailListLabelsTool } from '../../src/tools/gmailListLabels.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

function fakeSession(): GmailSession {
  const api = {
    users: {
      labels: {
        list: async () => ({
          data: {
            labels: [
              { id: 'INBOX', name: 'INBOX', type: 'system' },
              { id: 'Label_1', name: 'Work', type: 'user' },
            ],
          },
        }),
        get: async ({ id }: { id: string }) => ({
          data: { id, messagesTotal: 1, messagesUnread: 0, threadsTotal: 1, threadsUnread: 0 },
        }),
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailListLabelsTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('gmail_list_labels (§12.2)', () => {
  it('returns all labels by default (defaults applied by the SDK)', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({ name: 'gmail_list_labels', arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      ok: boolean;
      labels: Array<{ id: string; type: string; messagesTotal: number }>;
    };
    expect(structured.ok).toBe(true);
    expect(structured.labels.map((l) => l.id).sort()).toEqual(['INBOX', 'Label_1']);
    // No pagination token in the response (§18).
    expect(structured).not.toHaveProperty('nextPageToken');
    await client.close();
  });

  it('respects includeSystemLabels=false', async () => {
    const config = defaultConfig();
    const session = fakeSession();
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({
      name: 'gmail_list_labels',
      arguments: { includeSystemLabels: false },
    });
    const structured = result.structuredContent as { labels: Array<{ id: string }> };
    expect(structured.labels.map((l) => l.id)).toEqual(['Label_1']);
    await client.close();
  });
});
