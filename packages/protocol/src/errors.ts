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
  /** Apollo could not find or launch the provider at all. */
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
