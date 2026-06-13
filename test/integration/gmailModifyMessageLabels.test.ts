import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailModifyMessageLabelsTool } from '../../src/tools/gmailModifyMessageLabels.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';
import { CONFIRMATION_STRINGS } from '../../src/safety/confirmation.js';

interface Captured {
  modifyIds: string[];
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      messages: {
        modify: async (params: { id: string }) => {
          captured.modifyIds.push(params.id);
          return { data: { id: params.id } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailModify] };
}

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
  registry.register(gmailModifyMessageLabelsTool);
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

function errorCode(result: unknown): string {
  return (result as { structuredContent: { error: { code: string } } }).structuredContent.error
    .code;
}

describe('gmail_modify_message_labels (§12.14, §16.3)', () => {
  it('returns feature_disabled when features.modify is off (default)', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(configWithModify(false), captured);
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: ['m1'], addLabelIds: ['Label_1'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('feature_disabled');
    await client.close();
  });

  it('requires confirmation for a single message when the flag is on (default)', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(configWithModify(true), captured);
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: ['m1'], addLabelIds: ['Label_1'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('confirmation_required');
    expect(captured.modifyIds).toEqual([]);
    await client.close();
  });

  it('requires confirmation for multiple messages even when the flag is off (§12.14)', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(
      configWithModify(true, { requireConfirmationForModify: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: ['m1', 'm2'], removeLabelIds: ['INBOX'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('confirmation_required');
    await client.close();
  });

  it('modifies a single message without confirmation when the flag is off', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(
      configWithModify(true, { requireConfirmationForModify: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: ['m1'], removeLabelIds: ['INBOX'] },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, modified: ['m1'], failed: [] });
    expect(captured.modifyIds).toEqual(['m1']);
    await client.close();
  });

  it('modifies multiple messages with the exact confirmation string', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(configWithModify(true), captured);
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: {
        messageIds: ['m1', 'm2'],
        addLabelIds: ['Label_1'],
        confirmation: CONFIRMATION_STRINGS.modify,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, modified: ['m1', 'm2'] });
    await client.close();
  });

  it('rejects an empty messageIds list with invalid_input', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(
      configWithModify(true, { requireConfirmationForModify: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: [], addLabelIds: ['Label_1'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('invalid_input');
    await client.close();
  });

  it('rejects a modify with no labels to add or remove with invalid_input', async () => {
    const captured: Captured = { modifyIds: [] };
    const client = await clientFor(
      configWithModify(true, { requireConfirmationForModify: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_modify_message_labels',
      arguments: { messageIds: ['m1'] },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('invalid_input');
    await client.close();
  });
});
