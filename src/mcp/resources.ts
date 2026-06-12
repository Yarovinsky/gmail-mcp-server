/**
 * Optional read-only MCP resources (HLD §11.2). Exposes the mailbox as four bounded,
 * read-only resources:
 *
 *   - `gmail://profile`            → the authenticated profile
 *   - `gmail://labels`             → the label list
 *   - `gmail://message/{messageId}`→ a single message (safe defaults: text body only)
 *   - `gmail://thread/{threadId}`  → a thread's messages
 *
 * Each resource is backed by the corresponding read tool, so it inherits that tool's
 * feature/scope gating and safe defaults (HTML off, body caps), and its serialized body
 * is bounded by `toolResponseBodyCharLimit` (§11.1) — resources never return more than
 * the equivalent tool call. This module lives in the `mcp` layer (it may talk to the
 * SDK and the tool registry).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type ToolContext,
  type ToolGate,
  type ToolResultObject,
  ToolRegistry,
} from './toolRegistry.js';
import { appError, internalError, toErrorResponse } from './errors.js';
import { boundToolResponse } from '../safety/limits.js';

export interface ResourceDeps {
  registry: ToolRegistry;
  context: ToolContext;
  gate: ToolGate;
}

/** First value of a URI-template variable (templates may yield string | string[]). */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Run a read tool on behalf of a resource: apply the same gate, parse the args through
 * the tool's schema (so defaults apply), and return its JSON result — or a structured
 * error envelope. Mirrors the tool-call path so resources and tools behave identically.
 */
async function runToolForResource(
  deps: ResourceDeps,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResultObject> {
  const tool = deps.registry.get(toolName);
  if (!tool) {
    return toErrorResponse(internalError(`Unknown resource-backed tool: ${toolName}`));
  }
  const blocked = deps.gate(tool);
  if (blocked) return toErrorResponse(blocked);

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return toErrorResponse(
      appError('invalid_input', {
        message: 'Invalid resource parameters.',
        details: {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      }),
    );
  }
  try {
    return await tool.handler(parsed.data, deps.context);
  } catch (error) {
    deps.context.logger.error({ err: error, tool: toolName }, 'Resource-backed tool handler threw');
    return toErrorResponse(internalError(`Resource ${toolName} failed unexpectedly.`, error));
  }
}

/** Wrap a tool result as a single bounded `application/json` resource content. */
function jsonResource(uri: URL, result: ToolResultObject, limit: number): ReadResourceResult {
  const bounded = boundToolResponse(result, limit);
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: bounded.serialized }],
  };
}

/** Register the four §11.2 read-only resources on the MCP server. */
export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const limit = deps.context.config.limits.toolResponseBodyCharLimit;

  server.registerResource(
    'gmail-profile',
    'gmail://profile',
    {
      title: 'Gmail profile',
      description: 'The authenticated Gmail profile (email, granted scopes, enabled features).',
      mimeType: 'application/json',
    },
    async (uri) =>
      jsonResource(uri, await runToolForResource(deps, 'gmail_get_profile', {}), limit),
  );

  server.registerResource(
    'gmail-labels',
    'gmail://labels',
    {
      title: 'Gmail labels',
      description: 'The mailbox label list with message/thread counts.',
      mimeType: 'application/json',
    },
    async (uri) =>
      jsonResource(uri, await runToolForResource(deps, 'gmail_list_labels', {}), limit),
  );

  server.registerResource(
    'gmail-message',
    new ResourceTemplate('gmail://message/{messageId}', { list: undefined }),
    {
      title: 'Gmail message',
      description: 'A single message by id (text body only; untrusted email content).',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      jsonResource(
        uri,
        await runToolForResource(deps, 'gmail_get_message', {
          messageId: firstValue(variables.messageId),
        }),
        limit,
      ),
  );

  server.registerResource(
    'gmail-thread',
    new ResourceTemplate('gmail://thread/{threadId}', { list: undefined }),
    {
      title: 'Gmail thread',
      description: 'A thread and its messages by id (bounded; untrusted email content).',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      jsonResource(
        uri,
        await runToolForResource(deps, 'gmail_get_thread', {
          threadId: firstValue(variables.threadId),
        }),
        limit,
      ),
  );
}
