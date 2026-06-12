/**
 * The MCP SDK adapter (HLD §13.2: `mcp → tools`). This is the ONLY module that
 * imports the MCP server SDK. It maps `ToolRegistry` definitions onto the SDK,
 * wrapping each handler with the gate (feature/scope) and converting the tool's
 * JSON result into an MCP `CallToolResult`. No business logic lives here — handlers
 * delegate entirely to the registered tool's `handler` (§27.1).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type AnyTool,
  type ToolContext,
  type ToolGate,
  type ToolResultObject,
  ToolRegistry,
  featureGate,
} from './toolRegistry.js';
import { internalError, toErrorResponse } from './errors.js';
import { boundToolResponse } from '../safety/limits.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

/** Default server identity advertised to MCP clients. */
const DEFAULT_SERVER_INFO = { name: 'gmail-mcp-server', version: '1.0.0' };

export interface BuildServerOptions {
  registry: ToolRegistry;
  context: ToolContext;
  /** Gate applied before every tool runs. Defaults to a feature-flag gate. */
  gate?: ToolGate;
  serverInfo?: { name: string; version: string };
}

/** Build an `McpServer` with every registry tool wired to its gated handler. */
export function buildMcpServer(options: BuildServerOptions): McpServer {
  const { registry, context } = options;
  const gate = options.gate ?? featureGate(context.config);
  const server = new McpServer(options.serverInfo ?? DEFAULT_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });
  for (const tool of registry.list()) {
    wireTool(server, tool, context, gate);
  }
  // Optional read-only resources (§11.2) and static prompts (§11.3). Resources reuse the
  // read tools' gating/safe-defaults; prompts embed no private data.
  registerResources(server, { registry, context, gate });
  registerPrompts(server);
  return server;
}

/** Build the server and connect it to the given transport. */
export async function startServer(
  options: BuildServerOptions & { transport: Transport },
): Promise<McpServer> {
  const server = buildMcpServer(options);
  await server.connect(options.transport);
  return server;
}

function wireTool(server: McpServer, tool: AnyTool, context: ToolContext, gate: ToolGate): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema.shape,
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = await runTool(tool, args, context, gate);
      return toCallToolResult(result, context.config.limits.toolResponseBodyCharLimit);
    },
  );
}

/** Apply the gate, then delegate to the tool handler, mapping throws to internal_error. */
async function runTool(
  tool: AnyTool,
  args: Record<string, unknown>,
  context: ToolContext,
  gate: ToolGate,
): Promise<ToolResultObject> {
  const blocked = gate(tool);
  if (blocked) return toErrorResponse(blocked);
  try {
    return await tool.handler(args, context);
  } catch (error) {
    context.logger.error({ err: error, tool: tool.name }, 'Tool handler threw');
    return toErrorResponse(internalError(`Tool ${tool.name} failed unexpectedly.`, error));
  }
}

/**
 * Convert a tool's JSON result into an MCP `CallToolResult`, bounding the
 * serialized size to `toolResponseBodyCharLimit` (§11.1). The bounded envelope is
 * used for both the text content and the structured content so they stay in sync.
 */
function toCallToolResult(result: ToolResultObject, limit: number): CallToolResult {
  const bounded = boundToolResponse(result, limit);
  return {
    content: [{ type: 'text', text: bounded.serialized }],
    structuredContent: bounded.result,
    isError: bounded.result.ok === false,
  };
}
