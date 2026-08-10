/**
 * Error primitives for `@rx-apollo/core`.
 *
 * Two problems this solves:
 *
 *  1. **`Error` does not survive structured clone.** Anything that can fail on
 *     its way to the renderer has to be reducible to a plain
 *     {@link AgentError}. {@link ApolloError.toAgentError} is that reduction.
 *  2. **Errors get rendered and logged.** A stack trace or a provider message
 *     that happens to contain an API key would leak it into the UI and into
 *     log files. Every message that passes through here is scrubbed.
 *
 * These live under `profiles/` because profiles are the lowest layer of the
 * engine — the secret store and env resolution both need to raise typed errors
 * and neither may depend on the session machinery.
 */

import type { AgentError, AgentErrorCode, JsonValue } from '@rx-apollo/protocol';

/** Every {@link AgentErrorCode}, for validating error-shaped values at runtime. */
const AGENT_ERROR_CODES = [
  'auth',
  'rate_limit',
  'billing',
  'network',
  'provider_unavailable',
  'invalid_request',
  'model_unavailable',
  'limit_exceeded',
  'cancelled',
  'permission_denied',
  'transport',
  'provider_not_found',
  'unknown',
] as const satisfies readonly AgentErrorCode[];

const AGENT_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(AGENT_ERROR_CODES);

/** Runtime type guard for {@link AgentErrorCode}. */
export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === 'string' && AGENT_ERROR_CODE_SET.has(value);
}

/**
 * Patterns that look like credential material.
 *
 * This is a backstop, not a security boundary: the real rule is that secrets
 * never get put into an error in the first place. It exists because the
 * alternative — one careless `${err.message}` interpolation shipping a key
 * into the transcript pane — is unrecoverable once it has happened.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Anthropic-style keys and anything else with an `sk-` prefix.
  /sk-[A-Za-z0-9_-]{6,}/g,
  // `Authorization: Bearer <token>` and friends.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // AWS access key ids, which show up in Bedrock misconfiguration errors.
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
];

/**
 * Replace anything that looks like a credential with a placeholder.
 *
 * Applied to every message that becomes a {@link ApolloError} or an
 * {@link AgentError}. Safe to call on arbitrary text; it never throws.
 *
 * Deliberately not exported: the adapters layer publishes its own scrubber for
 * provider payloads, and two functions of the same name in the package barrel
 * would be ambiguous. This one exists to protect the error path.
 */
function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // `pattern` is module-level and global; reset lastIndex so repeated calls
    // do not start mid-string.
    pattern.lastIndex = 0;
    out = out.replace(pattern, '«redacted»');
  }
  return out;
}

/** Extra detail attached to a {@link ApolloError}. */
export interface ApolloErrorOptions {
  /** The underlying failure, kept for logs in the main process only. */
  readonly cause?: unknown;
  /** Structured diagnostics. Must be JSON-cloneable and secret-free. */
  readonly details?: JsonValue;
  /** True when retrying the same operation could plausibly succeed. */
  readonly retryable?: boolean;
  /** The provider's own error identifier, when there is one. */
  readonly providerCode?: string;
  /** HTTP status, when the failure came from an HTTP call. */
  readonly httpStatus?: number;
}

/**
 * Base class for engine errors that carry a normalized {@link AgentErrorCode}.
 *
 * Throw a subclass rather than a bare `Error` anywhere a failure can reach the
 * IPC boundary, so the main process can map it to an `IpcFail` without
 * guessing at a code.
 */
export class ApolloError extends Error {
  readonly code: AgentErrorCode;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean | undefined;
  readonly providerCode: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(code: AgentErrorCode, message: string, options: ApolloErrorOptions = {}) {
    super(scrubSecrets(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable;
    this.providerCode = options.providerCode;
    this.httpStatus = options.httpStatus;
  }

  /** Reduce to the IPC-safe shape. */
  toAgentError(): AgentError {
    const error: {
      code: AgentErrorCode;
      message: string;
      providerCode?: string;
      httpStatus?: number;
      retryable?: boolean;
      details?: JsonValue;
    } = { code: this.code, message: this.message };

    if (this.providerCode !== undefined) error.providerCode = this.providerCode;
    if (this.httpStatus !== undefined) error.httpStatus = this.httpStatus;
    if (this.retryable !== undefined) error.retryable = this.retryable;
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

/** A profile could not be read, written, validated or credentialed. */
export class ProfileError extends ApolloError {}

/** True for anything thrown by core that already carries a normalized code. */
export function isApolloError(value: unknown): value is ApolloError {
  return value instanceof ApolloError;
}

/** True for a plain object that already satisfies {@link AgentError}. */
function isAgentErrorLike(value: unknown): value is AgentError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return isAgentErrorCode(candidate.code) && typeof candidate.message === 'string';
}

/**
 * Coerce anything caught in a `catch` into an {@link AgentError}.
 *
 * Deliberately named for what it produces rather than the generic
 * "normalizeError", because adapters have their own provider-specific
 * normalizers and the two must not collide in the package barrel.
 *
 * @param error    the caught value
 * @param fallback code to use when nothing better can be inferred
 */
export function normalizeAgentError(error: unknown, fallback: AgentErrorCode = 'unknown'): AgentError {
  if (isApolloError(error)) return error.toAgentError();
  if (isAgentErrorLike(error)) return { ...error, message: scrubSecrets(error.message) };

  // The adapters layer throws `AdapterError`, which carries a fully-formed
  // AgentError. Read it structurally rather than importing the class, so the
  // profiles layer stays independent of the adapter seam.
  if (typeof error === 'object' && error !== null) {
    const nested = (error as { agentError?: unknown }).agentError;
    if (isAgentErrorLike(nested)) return { ...nested, message: scrubSecrets(nested.message) };
  }

  if (error instanceof Error) {
    return { code: fallback, message: scrubSecrets(error.message || error.name || 'Unknown error') };
  }
  if (typeof error === 'string') return { code: fallback, message: scrubSecrets(error) };

  let described: string;
  try {
    described = JSON.stringify(error) ?? String(error);
  } catch {
    described = String(error);
  }
  return { code: fallback, message: scrubSecrets(described) };
}
