/**
 * Error normalization for the IPC boundary.
 *
 * `ipcRenderer.invoke` rejections are lossy — the error's class is gone, its
 * stack is stringified into the renderer, and the renderer cannot branch on
 * anything useful. So the main process never rejects: every handler resolves an
 * {@link IpcResult}, and anything thrown along the way lands here first and
 * comes out as a typed, scrubbed {@link IpcError}.
 *
 * The stack stays in the main process, where it is logged. What crosses is a
 * code the UI can switch on and a message that has already been through
 * {@link scrubSecrets}.
 */

import type { AgentErrorCode, IpcChannel, IpcError } from '@rx-apollo/protocol';
import { scrubSecrets, SecretLeakError } from './redact.js';

/**
 * A malformed request from the renderer.
 *
 * The renderer is untrusted by construction — it is the one part of Apollo
 * running attacker-reachable content (a markdown transcript, a tool result). A
 * validation failure is a normal, expected outcome, not an exception.
 */
export class ValidationError extends Error {
  /** Dotted path of the offending field, e.g. `input.cwd`. */
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Invalid request: ${field} ${detail}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** The engine (`@rx-apollo/core`) could not be loaded or failed to start. */
export class EngineUnavailableError extends Error {
  constructor(detail: string) {
    super(`Apollo's engine is unavailable: ${detail}`);
    this.name = 'EngineUnavailableError';
  }
}

/** Encrypted credential storage is not usable on this machine. */
export class SecretStoreUnavailableError extends Error {
  /** Machine-readable cause, for the UI and for tests. */
  readonly reason: 'encryption_unavailable' | 'plaintext_backend' | 'io_error' | 'corrupt_store';

  constructor(reason: SecretStoreUnavailableError['reason'], detail: string) {
    super(detail);
    this.name = 'SecretStoreUnavailableError';
    this.reason = reason;
  }
}

/**
 * A directory cannot be used as a workspace.
 *
 * Distinct from {@link ValidationError} because the renderer did nothing wrong:
 * the path came from the OS picker, or from a folder that existed when it was
 * chosen and does not now. It still maps to `invalid_request`, because the
 * remedy is the same — pick a different directory.
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** An IPC message from a frame we do not trust. */
export class UntrustedSenderError extends Error {
  constructor(detail: string) {
    super(`Rejected IPC from an untrusted sender: ${detail}`);
    this.name = 'UntrustedSenderError';
  }
}

const AGENT_ERROR_CODES = new Set<string>([
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
]);

function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === 'string' && AGENT_ERROR_CODES.has(value);
}

/**
 * True when `value` already carries the normalized error shape.
 *
 * Adapters in `@rx-apollo/core` are expected to classify their own failures — they
 * are the only layer that knows what a provider's 429 actually means. When they
 * have done so, this function lets that classification survive instead of being
 * flattened to `unknown` here.
 */
function isAgentErrorLike(value: unknown): value is { code: AgentErrorCode; message: string } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isAgentErrorCode(candidate['code']) && typeof candidate['message'] === 'string';
}

/**
 * Turn anything thrown into an {@link IpcError}.
 *
 * @param error   whatever was caught
 * @param channel the channel being served, stamped onto the result
 */
export function toIpcError(error: unknown, channel?: IpcChannel): IpcError {
  const base = classify(error);
  return channel ? { ...base, channel } : base;
}

function classify(error: unknown): IpcError {
  if (error instanceof ValidationError) {
    return {
      code: 'invalid_request',
      message: scrubSecrets(error.message),
      retryable: false,
      details: { field: error.field },
    };
  }

  if (error instanceof SecretStoreUnavailableError) {
    return {
      code: 'auth',
      message: scrubSecrets(error.message),
      retryable: false,
      details: { reason: error.reason },
    };
  }

  if (error instanceof EngineUnavailableError) {
    return { code: 'provider_not_found', message: scrubSecrets(error.message), retryable: false };
  }

  if (error instanceof WorkspaceError) {
    // The message is already a complete sentence naming the directory, written
    // to be shown verbatim. Nothing to add.
    return { code: 'invalid_request', message: scrubSecrets(error.message), retryable: false };
  }

  if (error instanceof UntrustedSenderError) {
    return { code: 'permission_denied', message: 'Request rejected.', retryable: false };
  }

  if (error instanceof SecretLeakError) {
    // Never echo the path or the rule to the renderer: the path is a map of
    // main-process internals and the rule tells an attacker which patterns the
    // tripwire looks for. It is logged in full on this side.
    return {
      code: 'unknown',
      message: 'Apollo blocked a response that failed its credential-safety check. This is a bug; please report it.',
      retryable: false,
    };
  }

  if (isAgentErrorLike(error)) {
    const source = error as Record<string, unknown>;
    const normalized: IpcError = {
      code: error.code,
      message: scrubSecrets(error.message),
      ...(typeof source['providerCode'] === 'string' ? { providerCode: source['providerCode'] } : {}),
      ...(typeof source['httpStatus'] === 'number' ? { httpStatus: source['httpStatus'] } : {}),
      ...(typeof source['retryable'] === 'boolean' ? { retryable: source['retryable'] } : {}),
    };
    return normalized;
  }

  if (error instanceof Error) {
    return { code: 'unknown', message: scrubSecrets(error.message) || error.name, retryable: false };
  }

  return { code: 'unknown', message: 'An unexpected error occurred.', retryable: false };
}
