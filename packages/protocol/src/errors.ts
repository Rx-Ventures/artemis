/**
 * Normalized errors.
 *
 * An `Error` does not survive structured clone with its type intact, and
 * provider errors arrive in wildly different shapes. Everything that can fail
 * across the seam or across IPC reports one of these instead.
 */

import type { JsonValue } from './json.js';

/**
 * Coarse error classification. The UI switches on this to decide what to say
 * and whether to offer a retry; {@link AgentError.message} carries the detail.
 *
 * Deliberately small. Resist adding a code per provider quirk — put the quirk
 * in `message` and `details`.
 */
export type AgentErrorCode =
  /** Bad or missing credentials for the selected profile. */
  | 'auth'
  /** Provider-side rate limit or quota exhaustion. */
  | 'rate_limit'
  /** Billing problem: no credit, suspended account, spend cap. */
  | 'billing'
  /** Network failure reaching the provider. */
  | 'network'
  /** Provider returned 5xx / overloaded. */
  | 'provider_unavailable'
  /** Request was malformed or rejected as invalid. */
  | 'invalid_request'
  /** Requested model does not exist or is not available to this account. */
  | 'model_unavailable'
  /** The run hit a configured ceiling: max turns, budget, output tokens. */
  | 'limit_exceeded'
  /** The user (or the app) cancelled the operation. */
  | 'cancelled'
  /** A tool call was denied and the provider chose to stop. */
  | 'permission_denied'
  /** The provider process/transport died unexpectedly. */
  | 'transport'
  /** Artemis could not find or launch the provider at all. */
  | 'provider_not_found'
  /** Anything unclassified. */
  | 'unknown';

/**
 * A provider or engine error in a form that crosses IPC intact.
 *
 * Never put a secret in `message` or `details` — these are rendered in the UI
 * and written to logs. Adapters are responsible for scrubbing before they
 * construct one.
 */
export interface AgentError {
  readonly code: AgentErrorCode;
  /** Human-readable, already scrubbed of credentials. */
  readonly message: string;
  /** The provider's own error identifier, when it has one. */
  readonly providerCode?: string;
  /** HTTP status, when the failure came from an HTTP call. */
  readonly httpStatus?: number;
  /** True when retrying the same request could plausibly succeed. */
  readonly retryable?: boolean;
  /** Structured extras for diagnostics. Must be JSON-cloneable. */
  readonly details?: JsonValue;
}

/**
 * Did this fail only because the run had already ended?
 *
 * The engine refuses an unknown run id and a retired one with the same
 * `invalid_request` code, and the two deserve opposite treatment. A retired id
 * means the caller acted on a view of the world that was true when they acted —
 * the run ended between the click and the IPC call landing — which is a race,
 * not a mistake. An unknown id is a bug and should stay loud.
 *
 * The engine says which by putting `reason` in `details`; this reads it. The
 * alternative is matching on the message, which would make an English sentence
 * part of the API and break the first time someone improved the wording.
 */
export function isEndedRunError(error: AgentError | null | undefined): boolean {
  if (!error || error.code !== 'invalid_request') return false;
  const details = error.details;
  return (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    (details as Record<string, JsonValue | undefined>)['reason'] === 'run_ended'
  );
}
