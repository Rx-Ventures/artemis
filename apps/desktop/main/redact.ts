/**
 * Outbound leak detection.
 *
 * The single most important invariant in Artemis is that **a secret never crosses
 * the IPC boundary into the renderer**. The profile handlers are written to
 * return {@link import('@rx-artemis/protocol').ProfileMetadata}, never `Profile` —
 * but "written to" is a property of today's code, not of tomorrow's refactor.
 * This module is the tripwire that makes the invariant hold mechanically.
 *
 * Two independent checks run over every payload on its way out:
 *
 *  1. **Structural.** Certain *key names* must never appear in anything the
 *     renderer receives. `publicEnv` is what distinguishes `Profile` from
 *     `ProfileMetadata`, so its presence means someone returned the wrong
 *     shape. `secretRef`, `apiKey` and friends mean someone returned a
 *     credential outright — Artemis has none to return any more, which makes
 *     their appearance a regression rather than a mistake. This check is cheap
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
 * The distinction is what makes the check usable: everything Artemis itself
 * assembles is scanned strictly, and only provider/user content is exempt.
 *
 * ### Which policy a payload gets
 *
 * The exemptions above are worth nothing if the payload is handed the wrong
 * policy, and *which* policy is a property of the channel, not of the
 * direction. A pushed `AgentEvent` and a replayed one are the same bytes; so
 * are a terminal's live output and its replay buffer. {@link assertResponseSafe}
 * is where that mapping lives, so every `ipcMain.handle` response goes through
 * one decision rather than one default.
 */

import { IPC, type IpcChannel } from '@rx-artemis/protocol';

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
 * credential Artemis could plausibly hold.
 *
 * The `sk-` rule is the one named in Artemis's security brief; the rest are
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
   * shaped provider data that Artemis did not author.
   */
  readonly opaqueKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

/**
 * The `Profile` fields that {@link import('@rx-artemis/protocol').ProfileMetadata}
 * deliberately omits, plus the obvious credential field names.
 *
 * Seeing any of these in a renderer-bound payload means the wrong type was
 * returned. That is the exact bug this module exists to prevent.
 *
 * `publicEnv` is what now distinguishes the two shapes, and `secretRef` /
 * `apiKey` are kept as tripwires for a credential field returning — they no
 * longer exist anywhere in Artemis, so any reappearance is a regression worth
 * failing closed on.
 *
 * **`configDir` is deliberately absent from this list.** It used to be here as
 * `configDirName`, back when a filesystem location had no business in the
 * renderer. It is now a field of `ProfileMetadata`: the user chose the path,
 * the sign-in command has to name it, and the profile screen cannot work
 * without it. Adding it back would reject `profiles:list` at boot.
 */
const PROFILE_LEAK_KEYS = ['secretref', 'apikey', 'api_key', 'publicenv'];

/** Scan policy for `ipcMain.handle` responses. Strict: Artemis authors these. */
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
  // key into a prompt and we still have to list their history. `name` and
  // `instructions` are a routine's own prose — the instructions are a whole
  // prompt, and refusing to list routines because one mentions a token shape
  // would hide exactly the row the user needs to edit.
  // `suggestion` is the provider's predicted next prompt — model prose bound
  // for the composer, and a prediction of user text can quote whatever the
  // user themselves pasted.
  contentKeys: new Set([
    'title',
    'firstprompt',
    'message',
    'description',
    'reason',
    'unavailablereason',
    'name',
    'instructions',
    'suggestion',
  ]),
  // `metadata` is echoed straight back from the renderer's own `RunInput`.
  opaqueKeys: new Set(['metadata']),
  maxDepth: 12,
  maxNodes: 50_000,
};

/**
 * Scan policy for pushed {@link import('@rx-artemis/protocol').AgentEvent}s.
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
 * Scan policy for pushed {@link import('@rx-artemis/protocol').TerminalEvent}s.
 *
 * The loosest of the three on values and identical to the others on structure,
 * and the asymmetry is the whole point of having a third policy rather than
 * reusing {@link EVENT_SCAN_POLICY}.
 *
 * **Why `data` is exempt from the value patterns.** This module exists to stop
 * *Artemis's own* stored credentials — a profile's key, a token it holds — from
 * reaching the renderer through a handler that returned the wrong type. A
 * terminal's output is not Artemis's data at all: it is the user's own screen,
 * on the way to being drawn for the user who typed the command that produced
 * it. Running the credential patterns over it would mean `cat .env`, `env`,
 * `git remote -v` and `aws configure list` silently printing `[redacted]` in
 * the user's own shell — the app corrupting the output of a program it did not
 * run, to protect a secret from the person who owns it.
 *
 * It is also the one payload in the app where the scan would be measurable:
 * this runs on every batch of output, sixty times a second per terminal.
 *
 * **What stays strict.** `forbiddenKeys` is unchanged, so no profile field may
 * appear anywhere on a terminal event at any depth. The exemption is for one
 * named string, not for the envelope carrying it.
 */
export const TERMINAL_SCAN_POLICY: ScanPolicy = {
  forbiddenKeys: new Set(PROFILE_LEAK_KEYS),
  contentKeys: new Set(['data']),
  opaqueKeys: new Set(),
  maxDepth: 4,
  maxNodes: 64,
};

/**
 * Scan policy for the *envelope* around a page of replayed events.
 *
 * `events` is opaque here and scanned separately, one event at a time, under
 * {@link EVENT_SCAN_POLICY} — see {@link assertNoSecretsInTranscript}. What is
 * left is the handful of fields Artemis authors around them (`runId`,
 * `hasMore`), which stay under the strict response rules.
 */
const TRANSCRIPT_ENVELOPE_POLICY: ScanPolicy = {
  ...RESPONSE_SCAN_POLICY,
  opaqueKeys: new Set([...RESPONSE_SCAN_POLICY.opaqueKeys, 'events']),
};

/**
 * Scan policy for {@link import('@rx-artemis/protocol').PreviewMarkdown} and for
 * {@link import('@rx-artemis/protocol').FilesReadResponse}.
 *
 * `text` is a file off the user's own disk, read because the user clicked it.
 * Under the strict policy a README documenting `sk-ant-…`, or a checked-in
 * test fixture holding a PEM header, would refuse to open — Artemis declining
 * to show a person a file they already have.
 *
 * The two channels share it because they carry the same field for the same
 * reason, and the file channel is the one that needs it more: a preview opens
 * five renderable extensions, while `files.read` opens `.env`, `config.yml` and
 * every fixture in a test directory. A named policy either channel can point at
 * is what keeps the next reader of a file from meeting a credential-safety
 * error about their own disk.
 */
const FILE_TEXT_SCAN_POLICY: ScanPolicy = {
  ...RESPONSE_SCAN_POLICY,
  contentKeys: new Set([...RESPONSE_SCAN_POLICY.contentKeys, 'text']),
};

/**
 * Scan policy for the Cerebro bank's memory listing.
 *
 * `body` is a teammate's prose off the bank's reviewed main branch, not
 * Artemis's data — the same argument as {@link PREVIEW_SCAN_POLICY}'s `text`.
 * The bank's own validator refuses credential-shaped strings before a memory
 * can land, and a memory that merely *documents* a key format must still be
 * listable. Structure stays strict: no profile field at any depth.
 */
const CEREBRO_SCAN_POLICY: ScanPolicy = {
  ...RESPONSE_SCAN_POLICY,
  contentKeys: new Set([...RESPONSE_SCAN_POLICY.contentKeys, 'body']),
};

/**
 * Scan a payload carrying replayed {@link import('@rx-artemis/protocol').AgentEvent}s.
 *
 * Each event is scanned exactly as the live push path scans it: same policy,
 * and its **own** node budget. Both halves of that matter.
 *
 * The policy, because a replayed event is the same event — model output, tool
 * inputs, tool results. Scanning it as though Artemis wrote it means a
 * transcript in which the agent so much as *discussed* an API key cannot be
 * reopened.
 *
 * The per-event budget, because the alternative charges one session's whole
 * history against a limit sized for one event. A budget that a long
 * conversation grows into is not a security boundary, it is a length limit
 * wearing one: nothing about the ten-thousandth event is more suspicious than
 * the first, and the failure lands on the heaviest users.
 */
export function assertNoSecretsInTranscript(value: unknown, context: string): void {
  assertNoSecrets(value, context, TRANSCRIPT_ENVELOPE_POLICY);

  const events = typeof value === 'object' && value !== null ? (value as { events?: unknown }).events : undefined;
  if (events === undefined) return;

  // The exemption above is for a *list of events*, and only because the next
  // line scans each one. Anything else in that field is a shape nobody
  // designed, so it goes back to the strict policy rather than through a hole
  // opened for a type it does not have.
  if (!Array.isArray(events)) {
    assertNoSecrets(events, `${context}.events`, RESPONSE_SCAN_POLICY);
    return;
  }

  for (let i = 0; i < events.length; i += 1) {
    assertNoSecrets(events[i], `${context}.events[${i}]`, EVENT_SCAN_POLICY);
  }
}

/**
 * The tripwire for `ipcMain.handle` responses.
 *
 * Most channels return something Artemis assembled itself and get
 * {@link RESPONSE_SCAN_POLICY}. The exceptions are the channels that hand back
 * content Artemis did not author, and they are exceptions only in the sense
 * that a *response* is carrying what a *push* usually does — the same events,
 * the same terminal bytes. They are scanned the same way their pushed twin is,
 * which is the point: one payload shape, one rule, whichever direction it
 * travels.
 *
 * Structure stays strict on every one of them. No profile field may appear on
 * any response, at any depth, under any policy here.
 */
export function assertResponseSafe(value: unknown, channel: IpcChannel): void {
  switch (channel) {
    // A page of replayed events, in both cases — the live feed's own shape.
    case IPC.runsEvents:
    case IPC.sessionsMessages:
      return assertNoSecretsInTranscript(value, channel);

    // The tail of a terminal's output, which is the user's screen and not
    // Artemis's data. See TERMINAL_SCAN_POLICY for why `data` is exempt.
    case IPC.terminalReplay:
      return assertNoSecrets(value, channel, TERMINAL_SCAN_POLICY);

    // A file the user asked to see, rendered or as source. Both carry `text`
    // off the user's own disk; see FILE_TEXT_SCAN_POLICY.
    case IPC.previewOpen:
    case IPC.filesRead:
      return assertNoSecrets(value, channel, FILE_TEXT_SCAN_POLICY);

    // Team-authored memory bodies, already gated by the bank's own validator.
    case IPC.cerebroList:
      return assertNoSecrets(value, channel, CEREBRO_SCAN_POLICY);

    default:
      return assertNoSecrets(value, channel, RESPONSE_SCAN_POLICY);
  }
}

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
