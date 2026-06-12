/**
 * Zod schema for the effective server configuration (HLD §10), with the feature
 * defaults from §9.3 (read-oriented `true`, write/optional `false`).
 *
 * Every field has a default, so parsing `{}` yields the full §10 config. All
 * objects are strict, so unknown keys — including a misspelled feature flag — are
 * rejected (§22.1 invalid-value cases). `parseConfig` maps any validation failure
 * to a canonical `invalid_input` error (§17).
 */

import { z } from 'zod';
import { type AppError, type AppResult, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';

/** Transport kinds (§8). HTTP host/port are CLI-only (§8.2) and not config keys. */
export const TransportSchema = z.enum(['stdio', 'http']);

/** Collision policies for saved attachments (§15.3). */
export const CollisionPolicySchema = z.enum([
  'append-counter',
  'overwrite',
  'fail',
  'content-addressed',
]);

/** Log levels (pino levels plus `silent`). */
export const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** OAuth credential/token locations and requested scopes (§9). */
export const OAuthConfigSchema = z.strictObject({
  credentialsPath: z.string().default('~/.gmail-mcp/credentials.json'),
  tokenPath: z.string().default('~/.gmail-mcp/tokens/default.json'),
  scopes: z.array(z.string()).default(['https://www.googleapis.com/auth/gmail.readonly']),
});

/** The 11 feature flags (§9.3 / §10). Read-oriented default `true`; write/optional `false`. */
export const FeaturesConfigSchema = z.strictObject({
  profile: z.boolean().default(true),
  labels: z.boolean().default(true),
  labelsWrite: z.boolean().default(false),
  search: z.boolean().default(true),
  readMessages: z.boolean().default(true),
  readThreads: z.boolean().default(true),
  attachments: z.boolean().default(true),
  drafts: z.boolean().default(false),
  send: z.boolean().default(false),
  modify: z.boolean().default(false),
  history: z.boolean().default(false),
});

/** Numeric bounds applied to every tool (§10 `limits`, §27.3). */
export const LimitsConfigSchema = z.strictObject({
  defaultPageSize: z.number().int().positive().default(10),
  maxPageSize: z.number().int().positive().default(100),
  maxMessageBodyChars: z.number().int().positive().default(20000),
  maxAttachmentBytes: z.number().int().positive().default(52428800),
  maxBulkDownloadCount: z.number().int().positive().default(50),
  toolResponseBodyCharLimit: z.number().int().positive().default(50000),
});

/** Download/filesystem policy (§10 `downloads`, §15). */
export const DownloadsConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  rootDir: z.string().default('~/Downloads/gmail-mcp'),
  preserveOriginalFilenames: z.boolean().default(true),
  collisionPolicy: CollisionPolicySchema.default('append-counter'),
  allowedMimeTypes: z.array(z.string()).default([]),
  blockedExtensions: z
    .array(z.string())
    .default([
      '.exe',
      '.dll',
      '.bat',
      '.cmd',
      '.ps1',
      '.vbs',
      '.js',
      '.scr',
      '.com',
      '.jar',
      '.msi',
    ]),
  includeInlineAttachmentsByDefault: z.boolean().default(false),
});

/** Safety/confirmation toggles (§10 `safety`, §16). */
export const SafetyConfigSchema = z.strictObject({
  requireConfirmationForSend: z.boolean().default(true),
  requireConfirmationForModify: z.boolean().default(true),
  requireConfirmationForBulkDownload: z.boolean().default(true),
  bulkDownloadConfirmationThreshold: z.number().int().positive().default(10),
  redactAccessTokensInLogs: z.boolean().default(true),
  disableRawHtmlBodyByDefault: z.boolean().default(true),
  allowRawMessage: z.boolean().default(false),
});

/** Logging config (§10 `logging`, §16.5). */
export const LoggingConfigSchema = z.strictObject({
  level: LogLevelSchema.default('info'),
  auditLogPath: z.string().default('~/.gmail-mcp/audit.jsonl'),
});

/** The full effective configuration object (§10). */
export const ConfigSchema = z.strictObject({
  activeProfile: z.string().default('default'),
  transport: TransportSchema.default('stdio'),
  // `.prefault({})` (not `.default({})`): on Zod v4 a nested object default must be
  // the fully-resolved output and skips parsing, so inner field defaults would not
  // apply. `.prefault` substitutes `{}` as pre-parse input and runs it through the
  // sub-schema, letting each block's own defaults fill in.
  oauth: OAuthConfigSchema.prefault({}),
  features: FeaturesConfigSchema.prefault({}),
  limits: LimitsConfigSchema.prefault({}),
  downloads: DownloadsConfigSchema.prefault({}),
  safety: SafetyConfigSchema.prefault({}),
  logging: LoggingConfigSchema.prefault({}),
});

/** Effective (post-defaults) configuration type. */
export type Config = z.infer<typeof ConfigSchema>;

/** Raw (pre-defaults) configuration input type — everything optional. */
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Format Zod issues into a compact, human-readable summary for error messages. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate an unknown value against the config schema, returning an `AppResult`.
 * On failure the error is a canonical `invalid_input` with the offending paths in
 * `details.issues`.
 */
export function parseConfig(input: unknown): AppResult<Config> {
  const result = ConfigSchema.safeParse(input);
  if (result.success) {
    return ok(result.data);
  }
  const error: AppError = appError('invalid_input', {
    message: `Invalid configuration: ${formatIssues(result.error)}`,
    details: {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    },
  });
  return { ok: false, error };
}

/** Return the full default configuration (every §10 default applied). */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
