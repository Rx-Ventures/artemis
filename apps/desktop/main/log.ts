/**
 * Main-process logging.
 *
 * Thin on purpose — this is not a logging framework, it is a guarantee that
 * nothing credential-shaped reaches stdout or a crash report. Every string that
 * goes through here is run past {@link scrubSecrets} first.
 *
 * Stack traces stay in the main process. They are never forwarded to the
 * renderer: `AgentError` carries a scrubbed message and a code, and that is all
 * the UI needs to say something useful.
 */

import { scrubSecrets } from './redact.js';

/** Severity levels, in increasing order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minimumLevel: LogLevel = process.env['LIBRA_LOG_LEVEL'] === 'debug' ? 'debug' : 'info';

/**
 * Render one argument for output, scrubbing strings and unwrapping errors.
 *
 * Errors are flattened here rather than handed to `console.error` directly so
 * that the stack goes through the scrubber too — an exception thrown from
 * inside an HTTP client can easily carry an `Authorization` header in its
 * message.
 */
function format(value: unknown): string {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value instanceof Error) {
    const stack = value.stack ?? `${value.name}: ${value.message}`;
    return scrubSecrets(stack);
  }
  try {
    return scrubSecrets(JSON.stringify(value) ?? String(value));
  } catch {
    return '[unserialisable]';
  }
}

function emit(level: LogLevel, scope: string, message: string, extra: readonly unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) return;
  const line = `[apollo:${scope}] ${scrubSecrets(message)}`;
  const rest = extra.map(format);
  // eslint-disable-next-line no-console -- the main process logs to the terminal by design.
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (rest.length > 0) sink(line, ...rest);
  else sink(line);
}

/** A scoped logger. Scope shows up as `[apollo:<scope>]`. */
export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

/** Create a logger for one subsystem. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, ...extra) => emit('debug', scope, message, extra),
    info: (message, ...extra) => emit('info', scope, message, extra),
    warn: (message, ...extra) => emit('warn', scope, message, extra),
    error: (message, ...extra) => emit('error', scope, message, extra),
  };
}
