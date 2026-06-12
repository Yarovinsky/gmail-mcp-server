/**
 * Structured logging (pino) with always-on token redaction (HLD §16.4/§16.5).
 *
 * Every log call's arguments — both the merge object and the message string — are
 * passed through {@link redactSecrets} via pino's `logMethod` hook before pino
 * formats them. Token scrubbing is unconditional: the `redactAccessTokensInLogs`
 * config flag is defense-in-depth and never a switch to permit token logging, so
 * no log path can emit a full access/refresh token regardless of its value.
 */

import { pino, type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import { redactSecrets } from '../safety/redaction.js';
import type { LogLevel } from '../config/config.js';

export type { Logger };

export interface LoggerConfig {
  /** Minimum level to emit (pino levels plus `silent`). */
  level: LogLevel;
  /** Optional logger name included in each record. */
  name?: string;
  /** Optional destination stream (defaults to stdout). Used for tests. */
  destination?: DestinationStream;
}

/** Create a pino logger that redacts token-shaped values from all output. */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    hooks: {
      logMethod(inputArgs, method) {
        const scrubbed = inputArgs.map((arg) => redactSecrets(arg)) as typeof inputArgs;
        method.apply(this, scrubbed);
      },
    },
  };
  if (config.name !== undefined) {
    options.name = config.name;
  }
  // Default to stderr: in stdio transport mode the MCP JSON-RPC protocol owns
  // stdout, so logs must never be written there.
  return pino(options, config.destination ?? process.stderr);
}

/**
 * A no-op logger for contexts where logging is unwanted (e.g. some unit tests).
 * Created at level `silent`.
 */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
