/**
 * The tool registry and the tool/gate abstractions (HLD §13.2, §27.1).
 *
 * This module is intentionally free of any MCP SDK import: it is the SDK-agnostic
 * description of what a tool is, so that the MCP adapter in `server.ts` is the
 * only place that talks to the SDK. Tools declare their name, input schema,
 * feature flag, and required scopes; the actual SDK wiring localizes in one file.
 */

import type { z } from 'zod';
import type { Config, FeatureFlag } from '../config/config.js';
import type { Logger } from '../util/logger.js';
import type { AppError } from '../util/result.js';
import { featureDisabledError } from './errors.js';

/**
 * Runtime context handed to every tool handler. Extended in later phases as
 * dependencies (auth, gmail client, audit logger) are introduced.
 */
export interface ToolContext {
  config: Config;
  logger: Logger;
}

/** The JSON object a tool returns: the §11.1/§17 envelope (`{ok:true,…}` | `{ok:false,error}`). */
export type ToolResultObject = Record<string, unknown>;

/** A typed tool definition. `Shape` is the Zod raw shape of the input object. */
export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  /** The §10 feature flag gating this tool, if any (read tools included, §9.3). */
  feature?: FeatureFlag;
  /** Any-of OAuth scopes that authorize this tool (authoritative list from §12). */
  requiredScopesAnyOf?: readonly string[];
  handler: (
    input: z.infer<z.ZodObject<Shape>>,
    context: ToolContext,
  ) => ToolResultObject | Promise<ToolResultObject>;
}

/** A tool with its specific input shape erased, suitable for storage/registration. */
export type AnyTool = Tool<z.ZodRawShape>;

/**
 * Define a tool with full input typing, erasing the shape to `AnyTool` for the
 * registry. Tools use this so their handler `input` is typed from `inputSchema`.
 */
export function defineTool<Shape extends z.ZodRawShape>(tool: Tool<Shape>): AnyTool {
  return tool as unknown as AnyTool;
}

/** An in-memory registry of tool definitions. The MCP layer talks only to this. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }
}

/**
 * A gate decides whether a tool may run. It returns an `AppError` to block the
 * call (surfaced as a structured tool result) or `null` to allow it. Feature and
 * scope gating (§9.3) are expressed as composed gates.
 */
export type ToolGate = (tool: AnyTool) => AppError | null;

/** Feature-flag gate (§9.3): block a tool whose mapped feature flag is disabled. */
export function featureGate(config: Config): ToolGate {
  return (tool) => {
    if (tool.feature && !config.features[tool.feature]) {
      return featureDisabledError(tool.feature);
    }
    return null;
  };
}

/** Compose gates; the first to return an error wins, otherwise the call is allowed. */
export function composeGates(...gates: ToolGate[]): ToolGate {
  return (tool) => {
    for (const gate of gates) {
      const error = gate(tool);
      if (error) return error;
    }
    return null;
  };
}
