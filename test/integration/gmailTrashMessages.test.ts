import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailTrashMessagesTool } from '../../src/tools/gmailTrashMessages.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';
import { CONFIRMATION_STRINGS } from '../../src/safety/confirmation.js';

interface Captured {
  trashIds: string[];
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      messages: {
        trash: async (params: { id: string }) => {
          captured.trashIds.push(params.id);
          return { data: { id: params.id, labelIds: ['TRASH'] } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailModify] };
}

/** Trash confirmation is unconditional, so the only relevant toggle is features.modify. */
function configWithModify(modify: boolean, overrides: Partial<Config['safety']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    features: { ...base.features, modify },
    safety: { ...base.safety, ...overrides },
  };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailTrashMessagesTool);
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

function errorCode(result: { structuredContent?: unknown }): string {
  return (result.structuredContent as { error: { code: string } }).error.code;
}

describe('gmail_trash_messages (§12.15, §16.3)', () => {
  it('returns feature_disabled when features.modify is off (default)', async () => {
    const captured: Captured = { trashIds: [] };
    const client = await clientFor(configWithModify(false), captured);
    const result = await client.callTool({
      name: 'gmail_trash_messages',
      arguments: { messageIds: ['m1'], confirmation: CONFIRMATION_STRINGS.trash },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('feature_disabled');
    await client.close();
  });

  it('always requires confirmation, even with requireConfirmationForModify off (§12.15)', async () => {
    const captured: Captured = { trashIds: [] };
    const client = await clientFor(
      configWithModify(true, { requireConfirmationForModify: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_trash_messages',
      arguments: { messageIds: ['m1'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('confirmation_required');
    expect(captured.trashIds).toEqual([]);
    await client.close();
  });

  it('trashes messages with the exact confirmation string', async () => {
    const captured: Captured = { trashIds: [] };
    const client = await clientFor(configWithModify(true), captured);
    const result = await client.callTool({
      name: 'gmail_trash_messages',
      arguments: { messageIds: ['m1', 'm2'], confirmation: CONFIRMATION_STRINGS.trash },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, trashed: ['m1', 'm2'], failed: [] });
    expect(captured.trashIds).toEqual(['m1', 'm2']);
    await client.close();
  });

  it('rejects an incorrect confirmation string', async () => {
    const captured: Captured = { trashIds: [] };
    const client = await clientFor(configWithModify(true), captured);
    const result = await client.callTool({
      name: 'gmail_trash_messages',
      arguments: { messageIds: ['m1'], confirmation: 'please trash it' },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('confirmation_required');
    expect(captured.trashIds).toEqual([]);
    await client.close();
  });

  it('rejects an empty messageIds list with invalid_input', async () => {
    const captured: Captured = { trashIds: [] };
    const client = await clientFor(configWithModify(true), captured);
    const result = await client.callTool({
      name: 'gmail_trash_messages',
      arguments: { messageIds: [], confirmation: CONFIRMATION_STRINGS.trash },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('invalid_input');
    await client.close();
  });
});
