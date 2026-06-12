/**
 * MCP transport selection (HLD §8). Default and recommended transport is stdio
 * (§8.1); the optional HTTP transport (§8.2) lands in Step 7.4. Keeping transport
 * construction here isolates the SDK transport classes from the rest of the code.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportKind } from '../config/config.js';

export type { Transport };

/** Create the server-side transport for the configured kind. */
export function createServerTransport(kind: TransportKind): Transport {
  switch (kind) {
    case 'stdio':
      return new StdioServerTransport();
    case 'http':
      throw new Error(
        'HTTP transport is not implemented yet (see IMPL Step 7.4). Use --transport stdio.',
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown transport: ${String(exhaustive)}`);
    }
  }
}
