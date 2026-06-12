import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailGetHistoryTool } from '../../src/tools/gmailGetHistory.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

interface Captured {
  params?: Record<string, unknown>;
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      history: {
        list: async (params: Record<string, unknown>) => {
          captured.params = params;
          return { data: { history: [{ id: 'h1' }], historyId: '123999' } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

function configWithHistory(history: boolean): Config {
  const base = defaultConfig();
  return { ...base, features: { ...base.features, history } };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailGetHistoryTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function clientFor(config: Config, captured: Captured): Promise<Client> {
  const session = fakeSession(captured);
  return connect(
    { config, logger: createSilentLogger(), session },
    buildToolGate(config, session.grantedScopes, true),
  );
}

describe('gmail_get_history (§12.17, §18)', () => {
  it('returns feature_disabled when features.history is off (default)', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithHistory(false), captured);
    const result = await client.callTool({
      name: 'gmail_get_history',
      arguments: { startHistoryId: '123456' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
    await client.close();
  });

  it('returns history with historyId and a null nextPageToken, clamping maxResults', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithHistory(true), captured);
    const result = await client.callTool({
      name: 'gmail_get_history',
      arguments: { startHistoryId: '123456', maxResults: 9999 },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.params?.maxResults).toBe(100); // clamped to maxPageSize
    expect(result.structuredContent).toMatchObject({
      ok: true,
      history: [{ id: 'h1' }],
      nextPageToken: null,
      historyId: '123999',
    });
    await client.close();
  });
});
