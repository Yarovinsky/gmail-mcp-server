import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailGetProfileTool } from '../../src/tools/gmailGetProfile.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { parseConfig, defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

const PROFILE_DATA = {
  emailAddress: 'user@example.com',
  messagesTotal: 12345,
  threadsTotal: 6789,
  historyId: '123456',
};

/** A GmailClient backed by a fake API returning a fixed profile (no retries needed). */
function fakeSession(grantedScopes: string[]): GmailSession {
  const api = {
    users: {
      getProfile: async () => ({ data: PROFILE_DATA }),
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailGetProfileTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('gmail_get_profile (§12.1)', () => {
  it('returns the profile, granted scopes, and enabled features', async () => {
    const config = defaultConfig();
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({ name: 'gmail_get_profile', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      profile: PROFILE_DATA,
      grantedScopes: [Scope.GmailReadonly],
    });
    const structured = result.structuredContent as { enabledFeatures: string[] };
    expect(structured.enabledFeatures).toContain('profile');
    await client.close();
  });

  it('returns insufficient_scope when only send/compose is granted (§12.1)', async () => {
    const config = defaultConfig();
    const session = fakeSession([Scope.GmailSend]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({ name: 'gmail_get_profile', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'insufficient_scope' },
    });
    await client.close();
  });

  it('returns feature_disabled when features.profile is off', async () => {
    const parsed = parseConfig({ features: { profile: false } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = parsed.value;
    const session = fakeSession([Scope.GmailReadonly]);
    const client = await connect(
      { config, logger: createSilentLogger(), session },
      buildToolGate(config, session.grantedScopes, true),
    );

    const result = await client.callTool({ name: 'gmail_get_profile', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'feature_disabled' },
    });
    await client.close();
  });

  it('returns not_authenticated when there is no session', async () => {
    const config = defaultConfig();
    const client = await connect(
      { config, logger: createSilentLogger(), session: null },
      buildToolGate(config, [], false),
    );

    const result = await client.callTool({ name: 'gmail_get_profile', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'not_authenticated' },
    });
    await client.close();
  });
});
