#!/usr/bin/env node
/**
 * gmail-mcp-server executable entrypoint. Parses argv and dispatches to the CLI
 * (`src/cli.ts`). All command logic lives in `cli.ts` so this file stays a thin
 * shell that maps the CLI's exit code onto the process.
 */

import { runCli } from './cli.js';

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`gmail-mcp-server: fatal error: ${String(error)}\n`);
    process.exitCode = 1;
  });
