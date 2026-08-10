/**
 * Outbound leak detection.
 *
 * The single most important invariant in Apollo is that **a secret never crosses
 * the IPC boundary into the renderer**. The profile handlers are written to
 * return {@link import('@rx-apollo/protocol').ProfileMetadata}, never `Profile` —
 * but "written to" is a property of today's code, not of tomorrow's refactor.
 * This module is the tripwire that makes the invariant hold mechanically.
 *
 * Two independent checks run over every payload on its way out:
 *
 *  1. **Structural.** Certain *key names* must never appear in anything the
 *     renderer receives. `secretRef`, `publicEnv` and `configDirName` are
 *     exactly the fields that distinguish `Profile` from `ProfileMetadata`, so
 *     their presence means someone returned the wrong shape. `apiKey` and
 *     friends mean someone returned a credential outright. This check is cheap
 *     and it catches the realistic bug.
 *
 *  2. **Value shape.** Every string is matched against a set of credential
 *     patterns — `sk-…`, `sk-ant-…`, AWS access key ids, PEM private key
 *     headers, `Bearer …`. This catches a credential that arrived somewhere
 *     unexpected, e.g. embedded in a provider error message.
 *
 * A hit throws {@link SecretLeakError}. Failing closed is deliberate: a broken
 * feature is recoverable, a leaked key is not.
 *
 * ### Why some fields are exempt
 *
 * Not every string is ours to police. Model output, tool results and user
 * prompts are *content*: if a user pastes their own key into a prompt, the
 * transcript legitimately contains it, and refusing to render the conversation
 * would be both useless and confusing. Those fields are listed in
 * {@link ScanPolicy.contentKeys} (scanned structurally, exempt from the value
 * patterns) and {@link ScanPolicy.opaqueKeys} (not descended into at all,
 * because a tool result can be megabytes of arbitrary JSON).
 *
 * The distinction is what makes the check usable: everything Apollo itself
 * assembles is scanned strictly, and only provider/user content is exempt.
 */

/** Thrown when a payload bound for the renderer fails a leak check. */
export class SecretLeakError extends Error {
  /** JSON-path-ish location of the offending node, e.g. `.profiles[0].secretRef`. */
  readonly path: string;
  /** Which payload was being checked — usually an IPC channel name. */
  readonly context: string;
  /** The rule that fired. Never contains the offending value. */
  readonly rule: string;

  constructor(context: string, path: string, rule: string) {
    super(
      `Refusing to send data to the renderer: ${rule} at ${context}${path}. ` +
        'This is a bug in the main process — a payload that should be renderer-safe ' +
        'appears to contain a credential.',
    );
    this.name = 'SecretLeakError';
    this.context = context;
    this.path = path;
    this.rule = rule;
  }
}

/**
 * Credential patterns.
 *
 * Deliberately anchored on recognisable prefixes rather than entropy: an
 * entropy heuristic would flag base64 tool output constantly, and a check that
 * cries wolf gets deleted. These are the shapes that actually appear in a
 * credential Apollo could plausibly hold.
 *
 * The `sk-` rule is the one named in Apollo's security brief; the rest are
 * defence in depth for the Bedrock / Vertex / Foundry backends.
 */
const SECRET_VALUE_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'anthropic-style api key (sk-…)', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { rule: 'anthropic api key (sk-ant-…)', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { rule: 'aws access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'aws session/secret key assignment', pattern: /\bAWS_(SECRET_ACCESS_KEY|SESSION_TOKEN)\s*[=:]/i },
  { rule: 'google api key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'pem private key', pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { rule: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/ },
  {
    rule: 'inline credential assignment',
    pattern: /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[=:]\s*["']?[A-Za-z0-9_\-.]{20,}/i,
  },
];

/** Global-flagged twins of {@link SECRET_VALUE_RULES}, for {@link scrubSecrets}. */
const SCRUB_PATTERNS: readonly RegExp[] = SECRET_VALUE_RULES.map(
  ({ pattern }) => new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'),
);

/** True when `value` looks like a credential. */
export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_RULES.some(({ pattern }) => pattern.test(value));
}

/**
 * Replace anything credential-shaped with a placeholder.
 *
 * Used on strings headed for a log or an `AgentError.message`. Never used on
 * transcript content — mangling the model's own output is worse than the
 * problem it would solve.
 */
export function scrubSecrets(value: string): string {
  let out = value;
  for (const pattern of SCRUB_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** Configuration for one flavour of scan. */
export interface ScanPolicy {
  /**
   * Key names that must not appear anywhere in the payload, at any depth.
   * Compared case-insensitively.
   */
  readonly forbiddenKeys: ReadonlySet<string>;
  /**
   * Keys whose string values are provider or user *content* and are therefore
   * exempt from {@link SECRET_VALUE_RULES}. Still checked structurally.
   */
  readonly contentKeys: ReadonlySet<string>;
  /**
   * Keys whose subtree is not walked at all: arbitrarily large, arbitrarily
   * shaped provider data that Apollo did not author.
   */
  readonly opaqueKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

/**
 * The `Profile` fields that {@link import('@rx-apollo/protocol').ProfileMetadata}
 * deliberately omits, plus the obvious credential field names.
 *
 * Seeing any of these in a renderer-bound payload means the wrong type was
 * returned. That is the exact bug this module exists to prevent.
 */
const PROFILE_LEAK_KEYS = ['secretref', 'apikey', 'api_key', 'publicenv', 'configdirname'];

/** Scan policy for `ipcMain.handle` responses. Strict: Apollo authors these. */
export const RESPONSE_SCAN_POLICY: ScanPolicy = {
  forbiddenKeys: new Set([
    ...PROFILE_LEAK_KEYS,
    'env',
    'password',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'credentials',
  ]),
  // Session titles and first prompts are user text; a user may have pasted a
  // key into a prompt and we still have to list their history.
  contentKeys: new Set(['title', 'firstprompt', 'message', 'description', 'reason', 'unavailablereason']),
  // `metadata` is echoed straight back from the renderer's own `RunInput`.
  opaqueKeys: new Set(['metadata']),
  maxDepth: 12,
  maxNodes: 50_000,
};

/**
 * Scan policy for pushed {@link import('@rx-apollo/protocol').AgentEvent}s.
 *
 * Looser on values, because an agent event is almost entirely model output and
 * tool results, and just as strict on structure — no profile field has any
 * business appearing on an event.
 */
export const EVENT_SCAN_POLICY: ScanPolicy = {
  forbiddenKeys: new Set(PROFILE_LEAK_KEYS),
  contentKeys: new Set([
    'text',
    'resulttext',
    'message',
    'title',
    'description',
    'reason',
    'prompt',
    'firstprompt',
    'summary',
    'blockedpath',
  ]),
  // Tool inputs and tool results are provider data, unbounded in size and
  // shape. Walking them would cost real time on every delta for no benefit.
  opaqueKeys: new Set(['input', 'result', 'updatedinput', 'details']),
  maxDepth: 12,
  maxNodes: 50_000,
};

/**
 * Throw if `value` looks like it carries a credential.
 *
 * @param value   the payload about to cross into the renderer
 * @param context a label for the error message, normally the IPC channel
 * @param policy  which scan to run; defaults to the strict response policy
 */
export function assertNoSecrets(
  value: unknown,
  context: string,
  policy: ScanPolicy = RESPONSE_SCAN_POLICY,
): void {
  let nodes = 0;
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number, valueScanned: boolean): void => {
    nodes += 1;
    if (nodes > policy.maxNodes) {
      throw new SecretLeakError(context, path, `payload exceeded ${policy.maxNodes} nodes and could not be verified`);
    }
    if (depth > policy.maxDepth) {
      throw new SecretLeakError(context, path, `payload nested deeper than ${policy.maxDepth} levels and could not be verified`);
    }

    if (typeof node === 'string') {
      if (valueScanned) {
        for (const { rule, pattern } of SECRET_VALUE_RULES) {
          if (pattern.test(node)) throw new SecretLeakError(context, path, rule);
        }
      }
      return;
    }

    if (node === null || typeof node !== 'object') return;

    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${path}[${i}]`, depth + 1, valueScanned);
      }
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const lowered = key.toLowerCase();
      if (policy.forbiddenKeys.has(lowered)) {
        throw new SecretLeakError(context, `${path}.${key}`, `forbidden field "${key}"`);
      }
      if (policy.opaqueKeys.has(lowered)) continue;
      walk(child, `${path}.${key}`, depth + 1, valueScanned && !policy.contentKeys.has(lowered));
    }
  };

  walk(value, '', 0, true);
}
