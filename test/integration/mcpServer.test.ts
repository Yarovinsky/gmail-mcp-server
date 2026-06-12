import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, defineTool } from '../../src/mcp/toolRegistry.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';

/** Build a registry with an always-on echo tool and a feature-gated tool. */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'test_echo',
      description: 'Echo the input value back (test tool).',
      inputSchema: z.object({ value: z.string() }),
      handler: (input) => ({ ok: true, echoed: input.value }),
    }),
  );
  registry.register(
    defineTool({
      name: 'test_gated',
      description: 'A tool gated behind the drafts feature (off by default).',
      inputSchema: z.object({}),
      feature: 'drafts',
      handler: () => ({ ok: true }),
    }),
  );
  return registry;
}

async function connectClient(registry: ToolRegistry): Promise<Client> {
  const server = buildMcpServer({
    registry,
    context: { config: defaultConfig(), logger: createSilentLogger() },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP server over in-memory transport', () => {
  it('boots and responds to list_tools', async () => {
    const client = await connectClient(buildRegistry());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('test_echo');
    expect(names).toContain('test_gated');
    await client.close();
  });

  it('calls a tool and returns its structured result', async () => {
    const client = await connectClient(buildRegistry());
    const result = await client.callTool({ name: 'test_echo', arguments: { value: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true, echoed: 'hello' });
    await client.close();
  });

  it('returns a structured feature_disabled error for a gated tool', async () => {
    const client = await connectClient(buildRegistry());
    const result = await client.callTool({ name: 'test_gated', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'feature_disabled' },
    });
    await client.close();
  });
});

describe('health tool (real registry)', () => {
  it('is listed and callable over the MCP transport', async () => {
    const client = await connectClient(createToolRegistry());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('health');

    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      status: 'ok',
      server: 'gmail-mcp-server',
    });
    await client.close();
  });
});
