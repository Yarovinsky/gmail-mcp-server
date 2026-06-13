/**
 * CLI entrypoint logic (HLD §20). Implements `--help`/`--version`, `config init`,
 * `config show`, `doctor` (the full 7-point §20 diagnostic), `start` (stdio by default,
 * plus the optional local-only `--transport http --host --port` mode of §8.2), and the
 * `auth login | status | logout | revoke` subcommands (§9.2, §9.4).
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
import { createLogger, createSilentLogger } from './util/logger.js';
import { buildMcpServer } from './mcp/server.js';
import { createServerTransport, resolveHttpBinding, serveHttp } from './mcp/transport.js';
import { TokenStore, tokensDirFromTokenPath } from './auth/tokenStore.js';
import { OAuthClient, loadCredentials, parseGrantedScopes } from './auth/oauthClient.js';
import { expandScopeProfile } from './auth/scopeProfiles.js';
import { authLogin, authLogout, authRevoke, authStatus } from './auth/authCommands.js';
import { GmailClient, createGmailApi, type GoogleAuthClient } from './gmail/gmailClient.js';
import type { GmailSession } from './gmail/session.js';
import { buildToolGate } from './tools/gate.js';
import { createFileAuditLogger } from './audit/auditLogger.js';
import type { Config } from './config/config.js';
import type { Logger } from './util/logger.js';

/** Current CLI/server version. Keep in sync with package.json on release. */
export const VERSION = '1.0.0';

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

/** A flag's string value, or undefined when absent or passed as a bare boolean flag. */
function flagString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

/** The minimum supported Node major version (kept in sync with package.json engines). */
export const MIN_NODE_MAJOR = 20;

/** A single `doctor` diagnostic result. `fail` makes `doctor` exit non-zero. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

/** State the doctor checks reason over (gathered with side effects, then judged purely). */
export interface DoctorContext {
  nodeVersion: string;
  config: Config | null;
  configError?: string;
  credentialsExists: boolean;
  tokenExists: boolean;
  /** Granted scopes from the stored token, or null when there is no token. */
  grantedScopes: string[] | null;
  downloadRoot?: { enabled: boolean; path: string; exists: boolean; writable: boolean };
  /** Names of enabled features whose tools no granted scope authorizes. */
  featureScopeMismatches: string[];
}

function nodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

/**
 * Turn a gathered {@link DoctorContext} into the §20 seven-point check list. Pure and
 * side-effect-free so it is fully unit-testable; the I/O (config load, fs, token read)
 * happens in {@link cmdDoctor} which builds the context.
 */
export function buildDoctorChecks(ctx: DoctorContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. Node version.
  const major = nodeMajor(ctx.nodeVersion);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `${ctx.nodeVersion} (>= v${MIN_NODE_MAJOR}).` }
      : {
          name: 'node',
          status: 'fail',
          detail: `${ctx.nodeVersion} is below the required Node >= v${MIN_NODE_MAJOR}. Upgrade Node.`,
        },
  );

  // 2. Config validity. Without a valid config nothing else is reliable.
  if (!ctx.config) {
    checks.push({
      name: 'config',
      status: 'fail',
      detail: `Invalid configuration: ${ctx.configError ?? 'unknown error'}. Fix it or run \`config init\`.`,
    });
    return checks;
  }
  checks.push({
    name: 'config',
    status: 'ok',
    detail: `Valid (transport=${ctx.config.transport}, profile=${ctx.config.activeProfile}).`,
  });

  // 3. Credentials file exists.
  checks.push(
    ctx.credentialsExists
      ? { name: 'credentials', status: 'ok', detail: `Found: ${ctx.config.oauth.credentialsPath}.` }
      : {
          name: 'credentials',
          status: 'fail',
          detail: `Missing OAuth credentials at ${ctx.config.oauth.credentialsPath}. Create a Desktop App OAuth client in Google Cloud and save it there.`,
        },
  );

  // 4. Token file exists or auth needed.
  checks.push(
    ctx.tokenExists
      ? {
          name: 'token',
          status: 'ok',
          detail: `Token present for profile '${ctx.config.activeProfile}'.`,
        }
      : {
          name: 'token',
          status: 'warn',
          detail: `No token for profile '${ctx.config.activeProfile}'. Run \`gmail-mcp-server auth login\`.`,
        },
  );

  // 5. Token scopes.
  if (ctx.grantedScopes && ctx.grantedScopes.length > 0) {
    checks.push({
      name: 'scopes',
      status: 'ok',
      detail: `Granted: ${ctx.grantedScopes.join(', ')}.`,
    });
  } else if (ctx.tokenExists) {
    checks.push({
      name: 'scopes',
      status: 'warn',
      detail: 'Token has no recorded scopes; re-run `auth login`.',
    });
  } else {
    checks.push({ name: 'scopes', status: 'warn', detail: 'Unknown until you authenticate.' });
  }

  // 6. Download root exists/writable if downloads enabled.
  const dr = ctx.downloadRoot;
  if (!dr || !dr.enabled) {
    checks.push({
      name: 'downloads',
      status: 'ok',
      detail: 'Downloads disabled (downloads.enabled=false).',
    });
  } else if (dr.exists && dr.writable) {
    checks.push({ name: 'downloads', status: 'ok', detail: `Writable: ${dr.path}.` });
  } else if (!dr.exists) {
    checks.push({
      name: 'downloads',
      status: 'warn',
      detail: `Download root does not exist yet (created on first save): ${dr.path}.`,
    });
  } else {
    checks.push({
      name: 'downloads',
      status: 'fail',
      detail: `Download root is not writable: ${dr.path}. Fix permissions or change downloads.rootDir.`,
    });
  }

  // 7. Feature flags match granted scopes.
  if (!ctx.grantedScopes) {
    checks.push({
      name: 'feature-scopes',
      status: 'warn',
      detail: 'Cannot verify feature/scope alignment until you authenticate.',
    });
  } else if (ctx.featureScopeMismatches.length === 0) {
    checks.push({
      name: 'feature-scopes',
      status: 'ok',
      detail: 'Enabled features are authorized by the granted scopes.',
    });
  } else {
    checks.push({
      name: 'feature-scopes',
      status: 'warn',
      detail: `Enabled but not authorized by the granted scopes: ${ctx.featureScopeMismatches.join(', ')}. Re-run \`auth login\` with broader scopes, or disable these features.`,
    });
  }

  return checks;
}

/**
 * Names of enabled features whose tools NONE of the granted scopes authorize. Derived
 * from the live tool registry so the per-tool §12 scope map stays the single source of
 * truth (§9.3).
 */
export function featureScopeMismatches(config: Config, granted: readonly string[]): string[] {
  const grantedSet = new Set(granted);
  const mismatches = new Set<string>();
  for (const tool of createToolRegistry().list()) {
    const feature = tool.feature;
    if (!feature || !config.features[feature]) continue;
    const required = tool.requiredScopesAnyOf;
    if (!required || required.length === 0) continue;
    if (!required.some((scope) => grantedSet.has(scope))) {
      mismatches.add(feature);
    }
  }
  return [...mismatches];
}

/** Probe the (already `~`-expanded) download root for existence and writability. */
function probeDownloadRoot(config: Config): DoctorContext['downloadRoot'] {
  const dirPath = config.downloads.rootDir;
  if (!config.downloads.enabled) {
    return { enabled: false, path: dirPath, exists: false, writable: false };
  }
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return { enabled: true, path: dirPath, exists: true, writable: true };
  } catch {
    return { enabled: true, path: dirPath, exists: fs.existsSync(dirPath), writable: false };
  }
}

function cmdDoctor(deps: CliDeps): number {
  const { out } = resolveDeps(deps);
  const configResult = loadConfig(loadOptions(deps));
  const config = configResult.ok ? configResult.value : null;

  let credentialsExists = false;
  let tokenExists = false;
  let grantedScopes: string[] | null = null;
  let downloadRoot: DoctorContext['downloadRoot'];
  let mismatches: string[] = [];

  if (config) {
    credentialsExists = loadCredentials(config.oauth.credentialsPath).ok;
    const store = new TokenStore({
      tokensDir: tokensDirFromTokenPath(config.oauth.tokenPath),
      logger: createSilentLogger(),
    });
    const token = store.load(config.activeProfile);
    tokenExists = token.ok;
    if (token.ok) grantedScopes = parseGrantedScopes(token.value);
    downloadRoot = probeDownloadRoot(config);
    if (grantedScopes) mismatches = featureScopeMismatches(config, grantedScopes);
  }

  const ctx: DoctorContext = {
    nodeVersion: process.version,
    config,
    credentialsExists,
    tokenExists,
    grantedScopes,
    featureScopeMismatches: mismatches,
  };
  if (!configResult.ok) ctx.configError = configResult.error.message;
  if (downloadRoot) ctx.downloadRoot = downloadRoot;

  const checks = buildDoctorChecks(ctx);

  out(`gmail-mcp-server doctor (v${VERSION})`);
  for (const check of checks) {
    const mark = check.status === 'ok' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
    out(`  [${mark}] ${check.name}: ${check.detail}`);
  }
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

/**
 * Build the authenticated Gmail session for `start`, or `null` when the server is
 * not yet authenticated / has no credentials. A null session lets the server still
 * boot and serve `health`; mailbox tools then return `not_authenticated`.
 */
function buildSession(config: Config, logger: Logger): GmailSession | null {
  const credentials = loadCredentials(config.oauth.credentialsPath);
  if (!credentials.ok) {
    logger.warn(
      { reason: credentials.error.message },
      'No OAuth credentials; Gmail tools will report not_authenticated.',
    );
    return null;
  }
  const store = new TokenStore({
    tokensDir: tokensDirFromTokenPath(config.oauth.tokenPath),
    logger,
  });
  const token = store.load(config.activeProfile);
  if (!token.ok) {
    logger.warn(
      { profile: config.activeProfile },
      'No saved token; run `auth login`. Gmail tools will report not_authenticated.',
    );
    return null;
  }
  const oauth = new OAuthClient(credentials.value, { logger });
  const authClient = oauth.getAuthenticatedClient(token.value) as unknown as GoogleAuthClient;
  const gmail = new GmailClient(createGmailApi(authClient), { logger });
  return { gmail, grantedScopes: parseGrantedScopes(token.value) };
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

  // Validate the HTTP binding (host/port) up front so a bad address fails fast and
  // never reaches the safe-by-default §8.2 listener.
  let binding;
  if (kind === 'http') {
    const resolved = resolveHttpBinding({
      host: flagString(flags.get('host')),
      port: flagString(flags.get('port')),
    });
    if (!resolved.ok) {
      err(resolved.error.message);
      return 1;
    }
    binding = resolved.value;
  }

  const logger = createLogger({ level: config.logging.level });
  const session = buildSession(config, logger);
  const audit = createFileAuditLogger(config.logging.auditLogPath, logger);
  const registry = createToolRegistry();
  const gate = buildToolGate(config, session?.grantedScopes ?? [], session !== null);
  const buildServer = (): ReturnType<typeof buildMcpServer> =>
    buildMcpServer({ registry, context: { config, logger, session, audit }, gate });

  if (binding) {
    let handle;
    try {
      // Each HTTP session gets its own MCP server instance (§8.2 stateful mode).
      handle = await serveHttp(buildServer, binding);
    } catch (error) {
      err(
        `Failed to start HTTP transport: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    const addr = handle.address() ?? binding;
    logger.info(
      {
        transport: 'http',
        host: addr.host,
        port: addr.port,
        tools: registry.size,
        authenticated: session !== null,
      },
      'gmail-mcp-server started (HTTP)',
    );
  } else {
    await buildServer().connect(createServerTransport('stdio'));
    logger.info(
      { transport: 'stdio', tools: registry.size, authenticated: session !== null },
      'gmail-mcp-server started',
    );
  }

  // Keep the process alive; the transport (stdio reader or HTTP listener) drives
  // requests until the client disconnects or the process is signalled.
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
