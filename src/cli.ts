/**
 * CLI entrypoint logic (HLD §20). Implements `--help`/`--version`, `config init`,
 * `config show`, a `doctor` stub (full checks land in Step 6.9), `start` (stdio
 * now; http arrives in Step 7.4), and the `auth login | status | logout | revoke`
 * subcommands (§9.2, §9.4).
 *
 * `runCli` takes injectable IO/home/cwd/env so it is testable without touching the
 * real home directory or process streams.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/loadConfig.js';
import { defaultConfig } from './config/configSchema.js';
import { homeConfigPath } from './config/paths.js';
import type { TransportKind } from './config/config.js';
import { createToolRegistry } from './tools/index.js';
import { createLogger } from './util/logger.js';
import { buildMcpServer } from './mcp/server.js';
import { createServerTransport } from './mcp/transport.js';
import { TokenStore, tokensDirFromTokenPath } from './auth/tokenStore.js';
import { OAuthClient, loadCredentials } from './auth/oauthClient.js';
import { expandScopeProfile } from './auth/scopeProfiles.js';
import { authLogin, authLogout, authRevoke, authStatus } from './auth/authCommands.js';

/** Current CLI/server version. Keep in sync with package.json on release. */
export const VERSION = '0.1.0';

export interface CliDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Test hook: when provided, `start` calls this instead of connecting a real
   * transport and blocking. Receives the resolved transport kind.
   */
  startHook?: (kind: TransportKind) => Promise<number>;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.set(arg.slice(1), true);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const HELP = `gmail-mcp-server — a configurable MCP server for Gmail

Usage:
  gmail-mcp-server <command> [options]

Commands:
  auth login [--scope-profile <name>]   Authenticate and store OAuth tokens
  auth status                           Show the authenticated email and granted scopes
  auth logout                           Delete locally stored tokens
  auth revoke                           Revoke tokens with Google, then delete them
  config init [--force]                 Write a default config to ~/.gmail-mcp/config.json
  config show                           Print the effective (merged) configuration
  doctor                                Diagnose configuration, credentials, and scopes
  start [--transport stdio|http]        Start the MCP server (default transport: stdio)
        [--host <host>] [--port <port>]

Options:
  -h, --help                            Show this help
  -v, --version                         Show the version

This is not an official Google or Anthropic product. Grant the narrowest Gmail
scopes you need; email content is untrusted and may contain prompt injection.`;

function printHelp(write: (line: string) => void): void {
  write(HELP);
}

function resolveDeps(deps: CliDeps): {
  out: (line: string) => void;
  err: (line: string) => void;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} {
  return {
    out: deps.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    err: deps.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
    home: deps.home,
    cwd: deps.cwd,
    env: deps.env,
  };
}

function loadOptions(deps: CliDeps): { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } {
  const opts: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {};
  if (deps.home !== undefined) opts.home = deps.home;
  if (deps.cwd !== undefined) opts.cwd = deps.cwd;
  if (deps.env !== undefined) opts.env = deps.env;
  return opts;
}

function cmdConfigInit(deps: CliDeps, force: boolean): number {
  const { out, err } = resolveDeps(deps);
  const file = homeConfigPath(deps.home);
  if (fs.existsSync(file) && !force) {
    err(`Config already exists at ${file}. Use --force to overwrite.`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
  out(`Wrote default config to ${file}`);
  return 0;
}

function cmdConfigShow(deps: CliDeps): number {
  const { out, err } = resolveDeps(deps);
  const result = loadConfig(loadOptions(deps));
  if (!result.ok) {
    err(`Failed to load config: ${result.error.message}`);
    return 1;
  }
  out(JSON.stringify(result.value, null, 2));
  return 0;
}

function cmdConfig(sub: string | undefined, flags: ParsedArgs['flags'], deps: CliDeps): number {
  const { err } = resolveDeps(deps);
  switch (sub) {
    case 'init':
      return cmdConfigInit(deps, flags.get('force') === true);
    case 'show':
      return cmdConfigShow(deps);
    default:
      err(`Unknown config subcommand: ${sub ?? '(none)'}. Use "config init" or "config show".`);
      return 1;
  }
}

function cmdDoctor(deps: CliDeps): number {
  const { out } = resolveDeps(deps);
  // Stub (full 7-point checks land in Step 6.9). Report node version and config validity.
  out(`gmail-mcp-server doctor (v${VERSION})`);
  out(`  node version: ${process.version}`);
  const result = loadConfig(loadOptions(deps));
  if (result.ok) {
    out(`  config: OK (transport=${result.value.transport})`);
    out('  note: full credential/token/scope checks arrive in a later step.');
    return 0;
  }
  out(`  config: INVALID — ${result.error.message}`);
  return 1;
}

async function cmdStart(flags: ParsedArgs['flags'], deps: CliDeps): Promise<number> {
  const { err } = resolveDeps(deps);
  const result = loadConfig(loadOptions(deps));
  if (!result.ok) {
    err(`Failed to load config: ${result.error.message}`);
    return 1;
  }
  const config = result.value;
  const transportFlag = flags.get('transport');
  const kind: TransportKind =
    transportFlag === 'http' || transportFlag === 'stdio' ? transportFlag : config.transport;

  if (deps.startHook) {
    return deps.startHook(kind);
  }

  let transport;
  try {
    transport = createServerTransport(kind);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const logger = createLogger({ level: config.logging.level });
  const registry = createToolRegistry();
  const server = buildMcpServer({ registry, context: { config, logger } });
  await server.connect(transport);
  logger.info({ transport: kind, tools: registry.size }, 'gmail-mcp-server started');

  // Keep the process alive; the stdio transport drives requests until the client
  // disconnects or the process is signalled.
  await new Promise<void>(() => {});
  return 0;
}

async function cmdAuth(
  sub: string | undefined,
  flags: ParsedArgs['flags'],
  deps: CliDeps,
): Promise<number> {
  const { out, err } = resolveDeps(deps);
  const configResult = loadConfig(loadOptions(deps));
  if (!configResult.ok) {
    err(`Failed to load config: ${configResult.error.message}`);
    return 1;
  }
  const config = configResult.value;
  const profile = config.activeProfile;
  const logger = createLogger({ level: config.logging.level });
  const store = new TokenStore({
    tokensDir: tokensDirFromTokenPath(config.oauth.tokenPath),
    logger,
  });
  const io = { out, err };

  switch (sub) {
    case 'status':
      return authStatus({ store, profile, io });
    case 'logout':
      return authLogout({ store, profile, io });
    case 'login': {
      const credResult = loadCredentials(config.oauth.credentialsPath);
      if (!credResult.ok) {
        err(credResult.error.message);
        return 1;
      }
      const oauth = new OAuthClient(credResult.value, { logger });

      let scopes = config.oauth.scopes;
      const scopeProfile = flags.get('scope-profile');
      if (typeof scopeProfile === 'string') {
        const expanded = expandScopeProfile(scopeProfile);
        if (!expanded.ok) {
          err(expanded.error.message);
          return 1;
        }
        scopes = expanded.value;
      }

      return authLogin({
        oauth,
        store,
        profile,
        scopes,
        io,
        fetchEmail: (token) => oauth.getProfileEmail(token),
      });
    }
    case 'revoke': {
      const credResult = loadCredentials(config.oauth.credentialsPath);
      if (!credResult.ok) {
        // Without credentials we cannot reach Google's revocation endpoint, but we
        // must still remove the local token so it is not left behind (§9.4).
        err(
          `Cannot reach Google to revoke (${credResult.error.message}); removing local token only.`,
        );
        return authLogout({ store, profile, io });
      }
      const oauth = new OAuthClient(credResult.value, { logger });
      return authRevoke({ store, oauth, profile, io });
    }
    default:
      err(`Unknown auth subcommand: ${sub ?? '(none)'}. Use login | status | logout | revoke.`);
      return 1;
  }
}

/** Run the CLI, returning a process exit code. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const { out, err } = resolveDeps(deps);
  const { positionals, flags } = parseArgs(argv);

  if (flags.has('version') || flags.has('v')) {
    out(VERSION);
    return 0;
  }
  if (flags.has('help') || flags.has('h') || positionals.length === 0) {
    printHelp(out);
    return 0;
  }

  const command = positionals[0];
  switch (command) {
    case 'config':
      return cmdConfig(positionals[1], flags, deps);
    case 'doctor':
      return cmdDoctor(deps);
    case 'start':
      return cmdStart(flags, deps);
    case 'auth':
      return cmdAuth(positionals[1], flags, deps);
    default:
      err(`Unknown command: ${command}`);
      printHelp(err);
      return 1;
  }
}
