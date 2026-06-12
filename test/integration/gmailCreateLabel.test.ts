import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailCreateLabelTool } from '../../src/tools/gmailCreateLabel.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

interface Captured {
  body?: { name?: string; labelListVisibility?: string; messageListVisibility?: string };
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      labels: {
        create: async (params: { requestBody?: Captured['body'] }) => {
          captured.body = params.requestBody;
          return { data: { id: 'Label_42', name: params.requestBody?.name } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailLabels] };
}

/** Toggle only labelsWrite; labels stays at its default (true) to prove the distinction. */
function configWithLabelsWrite(labelsWrite: boolean): Config {
  const base = defaultConfig();
  return { ...base, features: { ...base.features, labelsWrite } };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailCreateLabelTool);
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

describe('gmail_create_label (§12.16)', () => {
  it('is gated by features.labelsWrite, not features.labels (default off → feature_disabled)', async () => {
    const captured: Captured = {};
    // Default config: labels=true, labelsWrite=false — must still be disabled.
    const client = await clientFor(configWithLabelsWrite(false), captured);
    const result = await client.callTool({
      name: 'gmail_create_label',
      arguments: { name: 'Projects/Example' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
    expect(captured.body).toBeUndefined();
    await client.close();
  });

  it('creates a label with default visibilities when labelsWrite is enabled', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithLabelsWrite(true), captured);
    const result = await client.callTool({
      name: 'gmail_create_label',
      arguments: { name: 'Projects/Example' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      label: { id: 'Label_42', name: 'Projects/Example' },
    });
    // §12.16 defaults applied.
    expect(captured.body).toEqual({
      name: 'Projects/Example',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    await client.close();
  });

  it('passes through explicit visibility settings', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithLabelsWrite(true), captured);
    const result = await client.callTool({
      name: 'gmail_create_label',
      arguments: {
        name: 'Hidden',
        labelListVisibility: 'labelHide',
        messageListVisibility: 'hide',
      },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.body).toMatchObject({
      labelListVisibility: 'labelHide',
      messageListVisibility: 'hide',
    });
    await client.close();
  });
});
