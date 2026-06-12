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

/** Default server identity advertised to MCP clients. */
const DEFAULT_SERVER_INFO = { name: 'gmail-mcp-server', version: '0.1.0' };

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
    capabilities: { tools: {} },
  });
  for (const tool of registry.list()) {
    wireTool(server, tool, context, gate);
  }
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
      return toCallToolResult(result);
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

/** Convert a tool's JSON result into an MCP `CallToolResult`. */
function toCallToolResult(result: ToolResultObject): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.ok === false,
  };
}
