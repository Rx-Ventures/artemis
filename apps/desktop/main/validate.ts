/**
 * Inbound IPC validation.
 *
 * The renderer is untrusted by construction. Not because we expect the user to
 * attack their own app, but because the renderer is the one process in Artemis
 * that displays attacker-influenced content: a transcript, a tool result, a
 * file the agent read. If anything ever achieves script execution there, this
 * file is the wall between it and the main process's filesystem access,
 * credential store and subprocess spawning.
 *
 * Two rules make that wall useful:
 *
 *  1. **Every payload is validated, not cast.** `ipcMain.handle` hands you
 *     `unknown`; a `as RunsStartRequest` would be a lie. Each validator below
 *     checks types, ranges and character sets before anything downstream sees
 *     the value.
 *
 *  2. **Every payload is rebuilt, not passed through.** Validators construct a
 *     fresh object containing only the fields the contract defines. A renderer
 *     cannot smuggle an extra property through to the Claude Agent SDK's
 *     `Options` by attaching it to a request — the field is simply dropped,
 *     because it was never copied across.
 *
 * Failures throw {@link ValidationError}, which the dispatcher turns into an
 * `invalid_request` result. Nothing here rejects a promise.
 */

import { isAbsolute } from 'node:path';

import {
  ATTACHMENT_LIMITS,
  attachmentBytes,
  base64Bytes,
  configDirProblem,
  IMAGE_MEDIA_TYPES,
  isCredentialRoutingEnvKey,
  isImageAttachment,
  isImageMediaType,
  isPermissionMode,
  isProviderEffort,
  isProviderId,
  isSecretEnvKey,
  normalizeProfileColor,
  profileColorProblem,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type JsonObject,
  type JsonValue,
  type PermissionDecision,
  type PermissionRule,
  type PermissionRuleUpdate,
  type ProfileDraft,
  type ProfilePatch,
  type ProfilesCreateRequest,
  type ProfilesDeleteRequest,
  type ProfilesListRequest,
  type ProfilesSuggestDirRequest,
  type ProfilesUpdateRequest,
  type ProvidersListRequest,
  type ProvidersModelsRequest,
  type RunInput,
  type RunsDisposeRequest,
  type RunsInterruptRequest,
  type RunsListRequest,
  type RunsRespondPermissionRequest,
  type RunsSendRequest,
  type RunsStartRequest,
  type SessionsListAllRequest,
  type SessionsListRequest,
  type SystemPromptSpec,
  type SessionsDeleteRequest,
  type SessionsMessagesRequest,
  type SessionsRenameRequest,
  type AuthSignOutRequest,
  type AuthStatusRequest,
  type UsagePlanRequest,
  type WindowRequest,
  type WorkspaceDescribeRequest,
  type WorkspacePickDirectoryRequest,
} from '@rx-artemis/protocol';

import { ValidationError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Size ceilings.
 *
 * These exist to bound memory and to make an accidental infinite loop in the
 * renderer fail fast instead of filling the main process's heap. They are
 * generous — a one-megabyte prompt is far past anything a person types — and
 * none of them is a security boundary on its own.
 */
const LIMITS = {
  id: 200,
  label: 200,
  prompt: 1_000_000,
  text: 1_000_000,
  systemPrompt: 200_000,
  path: 4_096,
  model: 200,
  toolName: 200,
  denyMessage: 4_000,
  toolListItems: 512,
  directoryItems: 64,
  envEntries: 64,
  envKey: 128,
  envValue: 8_192,
  ruleUpdates: 64,
  rulesPerUpdate: 256,
  metadataNodes: 256,
  metadataDepth: 8,
  jsonObjectNodes: 4_096,
  jsonObjectDepth: 12,
  maxTurns: 10_000,
  maxBudgetUsd: 100_000,
  pageSize: 1_000,
  offset: 1_000_000,
  /**
   * Transport bound for a session title, deliberately far above the length the
   * engine actually stores (`MAX_SESSION_TITLE`).
   *
   * The two limits do different jobs. This one rejects payloads no user
   * produced; the engine's truncates what a user *did* produce — someone
   * pasting a paragraph into the rename field wants a name out of it, not an
   * error about a character count no part of the UI shows them. Setting this
   * to the storage cap would turn that paste into a failure.
   */
  sessionTitle: 4_000,
} as const;

/**
 * Character set for every identifier that crosses IPC — profile ids, run ids,
 * session ids, permission request ids.
 *
 * Wide enough for a uuid, a nanoid or a `profile_<hex>`; narrow enough that an
 * id can never be a path, a shell fragment or a JSON injection.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** POSIX-ish environment variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that must never be copied into an object built from renderer input. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PERMISSION_SCOPES = new Set(['once', 'session', 'local', 'project', 'user']);
const PERMISSION_RULE_BEHAVIORS = new Set(['allow', 'deny', 'ask']);

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  // Structured clone always produces `Object.prototype`-rooted objects; anything
  // else came from somewhere it should not have.
  return proto === Object.prototype || proto === null;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(field, 'must be an object');
  return value;
}

/** The top-level request envelope. `undefined` is accepted as `{}`. */
function requireRequest(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireObject(value, 'request');
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'must be a string');
  if (value.length === 0) throw new ValidationError(field, 'must not be empty');
  if (value.length > maxLength) throw new ValidationError(field, `must be at most ${maxLength} characters`);
  if (value.includes('\u0000')) throw new ValidationError(field, 'must not contain NUL bytes');
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLength);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(field, 'must be a boolean');
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(field, 'must be an integer');
  }
  if (value < min || value > max) throw new ValidationError(field, `must be between ${min} and ${max}`);
  return value;
}

function optionalFiniteNumber(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, 'must be a finite number');
  }
  if (value < min || value > max) throw new ValidationError(field, `must be between ${min} and ${max}`);
  return value;
}

function requireId(value: unknown, field: string): string {
  const text = requireString(value, field, LIMITS.id);
  if (!ID_PATTERN.test(text)) throw new ValidationError(field, 'is not a valid identifier');
  return text;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, field);
}

/**
 * An absolute filesystem path.
 *
 * Absoluteness is required by the contract (`RunInput.cwd`), and it also stops
 * the agent's working directory from being resolved against whatever the main
 * process's `process.cwd()` happens to be at the time.
 */
function requireAbsolutePath(value: unknown, field: string): string {
  const text = requireString(value, field, LIMITS.path);
  if (!isAbsolute(text)) {
    // The detail is worth its length. This message is what a user sees after
    // typing a folder name into the working-directory field, and "must be an
    // absolute path" leaves them to work out what that means.
    throw new ValidationError(
      field,
      'must be an absolute path — a full path such as /Users/you/projects/app',
    );
  }
  return text;
}

function optionalAbsolutePath(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireAbsolutePath(value, field);
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > maxItems) throw new ValidationError(field, `must have at most ${maxItems} entries`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, maxLength));
}

function optionalAbsolutePathArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.directoryItems) {
    throw new ValidationError(field, `must have at most ${LIMITS.directoryItems} entries`);
  }
  return value.map((entry, index) => requireAbsolutePath(entry, `${field}[${index}]`));
}

/** Drop keys whose value is `undefined`, so built payloads stay tidy. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/* -------------------------------------------------------------------------- */
/* JSON payloads                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validate an arbitrary JSON payload (a tool input, run metadata).
 *
 * Rebuilds the value rather than returning it, so prototype-polluting keys are
 * dropped rather than merely detected, and so a hostile object with getters
 * cannot re-materialise after inspection.
 */
function validateJsonValue(
  value: unknown,
  field: string,
  budget: { nodes: number; readonly maxNodes: number; readonly maxDepth: number },
  depth = 0,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    throw new ValidationError(field, `must contain at most ${budget.maxNodes} values`);
  }
  if (depth > budget.maxDepth) {
    throw new ValidationError(field, `must not nest deeper than ${budget.maxDepth} levels`);
  }

  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      if (value.length > LIMITS.text) throw new ValidationError(field, 'contains an oversized string');
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new ValidationError(field, 'contains a non-finite number');
      return value;
    default:
      break;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => validateJsonValue(entry, `${field}[${index}]`, budget, depth + 1));
  }

  if (!isPlainObject(value)) throw new ValidationError(field, 'must contain only JSON values');

  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (key.length > LIMITS.envKey) throw new ValidationError(field, 'contains an oversized key');
    out[key] = validateJsonValue(entry, `${field}.${key}`, budget, depth + 1);
  }
  return out;
}

function optionalJsonObject(
  value: unknown,
  field: string,
  maxNodes: number,
  maxDepth: number,
): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new ValidationError(field, 'must be an object');
  return validateJsonValue(value, field, { nodes: 0, maxNodes, maxDepth }) as JsonObject;
}

/**
 * Non-sensitive environment variables for a profile.
 *
 * The checks here duplicate `@rx-artemis/core`'s. That is deliberate: `publicEnv` is
 * written to an unencrypted config file, so "someone pasted
 * `ANTHROPIC_AUTH_TOKEN` into the extra-env box" has to be caught before the
 * value reaches any layer that might persist it.
 *
 * The routing check is the one that earns its keep against a *hostile*
 * renderer rather than a careless user. `ANTHROPIC_BASE_URL` holds no secret
 * and reads as an innocuous setting, but `resolveEnv` writes the decrypted API
 * key into the same bundle it lands in, so accepting one here would hand the
 * key to whatever host the renderer named — with nothing sensitive ever
 * appearing in an IPC payload for the leak scanner to catch.
 */
function optionalPublicEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const source = requireObject(value, field);
  const keys = Object.keys(source);
  if (keys.length > LIMITS.envEntries) {
    throw new ValidationError(field, `must have at most ${LIMITS.envEntries} entries`);
  }

  const out: Record<string, string> = {};
  for (const key of keys) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (!ENV_KEY_PATTERN.test(key) || key.length > LIMITS.envKey) {
      throw new ValidationError(`${field}.${key}`, 'is not a valid environment variable name');
    }
    if (isSecretEnvKey(key)) {
      throw new ValidationError(
        `${field}.${key}`,
        'looks like a credential. Store API keys in the profile’s key field, which is encrypted, ' +
          'rather than in the plain environment bundle',
      );
    }
    if (isCredentialRoutingEnvKey(key)) {
      throw new ValidationError(
        `${field}.${key}`,
        'controls where the profile’s credential is sent. Endpoint, proxy and TLS-trust ' +
          'variables are decided by Artemis, not by a profile',
      );
    }
    out[key] = requireString(source[key], `${field}.${key}`, LIMITS.envValue);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

function validatePermissionRules(value: unknown, field: string): readonly PermissionRule[] {
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.rulesPerUpdate) {
    throw new ValidationError(field, `must have at most ${LIMITS.rulesPerUpdate} entries`);
  }
  return value.map((entry, index) => {
    const rule = requireObject(entry, `${field}[${index}]`);
    return compact<PermissionRule>({
      toolName: requireString(rule['toolName'], `${field}[${index}].toolName`, LIMITS.toolName),
      ruleContent: optionalString(rule['ruleContent'], `${field}[${index}].ruleContent`, LIMITS.text),
    });
  });
}

function validateScope(value: unknown, field: string): PermissionRuleUpdate['scope'] {
  const scope = requireString(value, field, 32);
  if (!PERMISSION_SCOPES.has(scope)) throw new ValidationError(field, 'is not a valid permission scope');
  return scope as PermissionRuleUpdate['scope'];
}

function validateRuleBehavior(value: unknown, field: string): 'allow' | 'deny' | 'ask' {
  const behavior = requireString(value, field, 16);
  if (!PERMISSION_RULE_BEHAVIORS.has(behavior)) {
    throw new ValidationError(field, 'must be "allow", "deny" or "ask"');
  }
  return behavior as 'allow' | 'deny' | 'ask';
}

function validatePermissionRuleUpdate(value: unknown, field: string): PermissionRuleUpdate {
  const update = requireObject(value, field);
  const type = requireString(update['type'], `${field}.type`, 32);

  switch (type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return {
        type,
        behavior: validateRuleBehavior(update['behavior'], `${field}.behavior`),
        rules: validatePermissionRules(update['rules'], `${field}.rules`),
        scope: validateScope(update['scope'], `${field}.scope`),
      };

    case 'setMode': {
      const mode = update['mode'];
      if (!isPermissionMode(mode)) throw new ValidationError(`${field}.mode`, 'is not a valid permission mode');
      return { type, mode, scope: validateScope(update['scope'], `${field}.scope`) };
    }

    case 'addDirectories':
    case 'removeDirectories': {
      const directories = optionalAbsolutePathArray(update['directories'], `${field}.directories`);
      if (!directories) throw new ValidationError(`${field}.directories`, 'is required');
      return { type, directories, scope: validateScope(update['scope'], `${field}.scope`) };
    }

    default:
      throw new ValidationError(`${field}.type`, 'is not a known permission update type');
  }
}

function optionalRuleUpdates(value: unknown, field: string): readonly PermissionRuleUpdate[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length > LIMITS.ruleUpdates) {
    throw new ValidationError(field, `must have at most ${LIMITS.ruleUpdates} entries`);
  }
  return value.map((entry, index) => validatePermissionRuleUpdate(entry, `${field}[${index}]`));
}

function validatePermissionDecision(value: unknown, field: string): PermissionDecision {
  const decision = requireObject(value, field);
  const behavior = requireString(decision['behavior'], `${field}.behavior`, 16);

  if (behavior === 'allow') {
    return compact({
      behavior: 'allow' as const,
      updatedInput: optionalJsonObject(
        decision['updatedInput'],
        `${field}.updatedInput`,
        LIMITS.jsonObjectNodes,
        LIMITS.jsonObjectDepth,
      ),
      updatedPermissions: optionalRuleUpdates(decision['updatedPermissions'], `${field}.updatedPermissions`),
      scope:
        decision['scope'] === undefined || decision['scope'] === null
          ? undefined
          : validateScope(decision['scope'], `${field}.scope`),
    });
  }

  if (behavior === 'deny') {
    return compact({
      behavior: 'deny' as const,
      message: optionalString(decision['message'], `${field}.message`, LIMITS.denyMessage),
      interrupt: optionalBoolean(decision['interrupt'], `${field}.interrupt`),
      updatedPermissions: optionalRuleUpdates(decision['updatedPermissions'], `${field}.updatedPermissions`),
    });
  }

  throw new ValidationError(`${field}.behavior`, 'must be "allow" or "deny"');
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A profile draft.
 *
 * Note what it no longer carries: a credential. There is no plaintext secret
 * anywhere in this IPC surface, in either direction, because Artemis stores
 * none — the provider's own login writes one into the config directory named
 * below and Artemis never sees it.
 */
function validateProfileDraft(value: unknown, field: string): ProfileDraft {
  const draft = requireObject(value, field);
  const providerId = draft['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError(`${field}.providerId`, 'is not a known provider');

  return compact<ProfileDraft>({
    label: requireString(draft['label'], `${field}.label`, LIMITS.label),
    providerId,
    configDir: requireConfigDir(draft['configDir'], `${field}.configDir`),
    publicEnv: optionalPublicEnv(draft['publicEnv'], `${field}.publicEnv`),
    color: optionalColor(draft['color'], `${field}.color`),
  });
}

/**
 * Validate a swatch colour, normalised to `#rrggbb`.
 *
 * A rejection rather than a silent drop, even though the store would drop it
 * anyway and nothing breaks either way. This boundary's job is to say what the
 * renderer got wrong; quietly discarding a field would show the user a colour
 * they picked, save a profile without it, and give them nothing to go on.
 *
 * The empty string survives as the empty string — that is `ProfilePatch`'s way
 * of clearing a colour, and turning it into `undefined` here would silently
 * change "remove the colour" into "leave it alone".
 */
function optionalColor(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return '';
  const problem = profileColorProblem(value);
  if (problem !== null) throw new ValidationError(field, problem);
  return normalizeProfileColor(value) ?? undefined;
}

/**
 * Validate a config-directory path.
 *
 * The rules live in protocol's {@link configDirProblem}, and are applied from
 * that single definition in three places — here, in the profile store, and in
 * the editor while the user is still typing. So the boundary cannot drift from
 * what the form accepted, nor from what the store will agree to keep.
 */
function requireConfigDir(value: unknown, field: string): string {
  const problem = configDirProblem(value);
  if (problem !== null) throw new ValidationError(field, problem);
  const trimmed = (value as string).trim();
  if (trimmed.length > LIMITS.path) {
    throw new ValidationError(field, 'is implausibly long for a path');
  }
  return trimmed;
}

function optionalConfigDir(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireConfigDir(value, field);
}

function validateProfilePatch(value: unknown, field: string): ProfilePatch {
  const patch = requireObject(value, field);
  return compact<ProfilePatch>({
    label: optionalString(patch['label'], `${field}.label`, LIMITS.label),
    configDir: optionalConfigDir(patch['configDir'], `${field}.configDir`),
    publicEnv: optionalPublicEnv(patch['publicEnv'], `${field}.publicEnv`),
    color: optionalColor(patch['color'], `${field}.color`),
  });
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

function optionalSystemPrompt(value: unknown, field: string): SystemPromptSpec | undefined {
  if (value === undefined || value === null) return undefined;
  const spec = requireObject(value, field);
  const kind = requireString(spec['kind'], `${field}.kind`, 16);
  switch (kind) {
    case 'default':
      return { kind: 'default' };
    case 'append':
    case 'replace':
      return { kind, text: requireString(spec['text'], `${field}.text`, LIMITS.systemPrompt) };
    default:
      throw new ValidationError(`${field}.kind`, 'must be "default", "append" or "replace"');
  }
}

/**
 * Base64 as the Messages API wants it: standard alphabet, correct padding, no
 * whitespace and no `data:` prefix.
 *
 * Checked by shape rather than by round-tripping through `Buffer`, because
 * `Buffer.from(x, 'base64')` does not validate — it discards anything outside
 * the alphabet and returns whatever it managed to decode. A payload that is
 * half base64 and half something else would sail through a decode check and
 * reach the provider as a corrupt image, or reach `writeFile` in an adapter as
 * a file whose contents nobody predicted.
 *
 * ## Why this is not one regex
 *
 * The obvious pattern is
 * `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`, where the
 * `{4}` group inside a `*` is what enforces the multiple-of-four length. That
 * is a **nested quantifier**, and V8 pushes a backtracking frame per repetition
 * — so on a payload of any real size it does not reject the input, it throws
 * `RangeError: Maximum call stack size exceeded`. That version shipped in the
 * image-only revision of this file and never fired, because five megabytes of
 * image was under the threshold; the first 8MB file attachment found it.
 *
 * So the length rule is arithmetic and the charset rule is a flat character
 * class, which is linear and allocates no frames. `=` appears only in the
 * trailing `={0,2}`, so padding still cannot appear in the middle.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * The base64 payload both attachment kinds carry.
 *
 * Size before shape: the regex is linear, but scanning a 40MB string before
 * refusing it is work done for a payload that was never going to be accepted.
 */
function requirePayload(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'must be a string');
  if (value.length === 0) throw new ValidationError(field, 'must not be empty');
  if (base64Bytes(value) > maxBytes) {
    throw new ValidationError(field, `must decode to at most ${String(maxBytes)} bytes`);
  }
  if (!isBase64(value)) {
    throw new ValidationError(field, 'must be base64 with no data: prefix');
  }
  return value;
}

/**
 * One image crossing IPC.
 *
 * The renderer enforces every one of these limits too, so the user finds out
 * while the image is still in the composer. That is a courtesy, not the
 * boundary: a renderer is not a trusted enforcer of its own limits, and this
 * is the last place the payload can be refused before it is written to a file
 * or billed to the user's account.
 */
function validateImageAttachment(value: unknown, field: string): ImageAttachment {
  const attachment = requireObject(value, field);

  const mediaType = attachment['mediaType'];
  if (!isImageMediaType(mediaType)) {
    throw new ValidationError(
      `${field}.mediaType`,
      `must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`,
    );
  }

  return compact<ImageAttachment>({
    kind: 'image',
    id: requireId(attachment['id'], `${field}.id`),
    mediaType,
    data: requirePayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerImage),
    // A filename, so it is untrusted display text: length-capped like every
    // other label, and never used to build a path — staged images are named
    // after a counter for exactly this reason.
    name: optionalString(attachment['name'], `${field}.name`, ATTACHMENT_LIMITS.nameLength),
    width: optionalInteger(attachment['width'], `${field}.width`, 1, 1_000_000),
    height: optionalInteger(attachment['height'], `${field}.height`, 1, 1_000_000),
  });
}

/**
 * One file crossing IPC.
 *
 * No format check, deliberately — see {@link FileAttachment}. What is checked
 * is the one field that is *not* inert: `name` is required here (an image's is
 * optional) because the staged file is named after it, so a missing one is a
 * bug rather than a shrug. It is length-capped and NUL-checked by
 * `requireString`, and `safeFileName` in the core adapters reduces it to a
 * single safe path component before anything opens it. Two layers, because the
 * consequence of getting it wrong is a write outside the staging directory.
 */
function validateFileAttachment(value: unknown, field: string): FileAttachment {
  const attachment = requireObject(value, field);

  return compact<FileAttachment>({
    kind: 'file',
    id: requireId(attachment['id'], `${field}.id`),
    name: requireString(attachment['name'], `${field}.name`, ATTACHMENT_LIMITS.nameLength),
    // Free-form: browsers hand over whatever they like, including nothing, and
    // only `application/pdf` changes any behaviour downstream. Bounded so it
    // cannot be used as a smuggling channel, and otherwise passed through.
    mediaType: optionalString(attachment['mediaType'], `${field}.mediaType`, 200),
    data: requirePayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerFile),
  });
}

function optionalAttachments(value: unknown, field: string): readonly Attachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  if (value.length === 0) return undefined;
  // A cheap bound before anything is decoded, so a renderer sending ten
  // thousand entries is refused by a length check rather than by a loop.
  if (value.length > ATTACHMENT_LIMITS.images + ATTACHMENT_LIMITS.files) {
    throw new ValidationError(
      field,
      `must have at most ${String(ATTACHMENT_LIMITS.images + ATTACHMENT_LIMITS.files)} entries`,
    );
  }

  const attachments = value.map((entry, index): Attachment => {
    const at = `${field}[${index}]`;
    const kind = requireObject(entry, at)['kind'];
    if (kind === 'image') return validateImageAttachment(entry, at);
    if (kind === 'file') return validateFileAttachment(entry, at);
    throw new ValidationError(`${at}.kind`, 'must be "image" or "file"');
  });

  // Per kind, because the two have different ceilings for different reasons —
  // an image's bytes become tokens, a file's become a file.
  const images = attachments.filter(isImageAttachment).length;
  if (images > ATTACHMENT_LIMITS.images) {
    throw new ValidationError(field, `must have at most ${String(ATTACHMENT_LIMITS.images)} images`);
  }
  const files = attachments.length - images;
  if (files > ATTACHMENT_LIMITS.files) {
    throw new ValidationError(field, `must have at most ${String(ATTACHMENT_LIMITS.files)} files`);
  }

  // The per-attachment ceilings bound one payload; this bounds the request.
  // Ten files each just under the limit is ten times the memory of one, in the
  // main process, held while they are written to disk.
  const total = attachments.reduce((sum, attachment) => sum + attachmentBytes(attachment), 0);
  if (total > ATTACHMENT_LIMITS.bytesTotal) {
    throw new ValidationError(
      field,
      `must decode to at most ${String(ATTACHMENT_LIMITS.bytesTotal)} bytes in total`,
    );
  }

  // Duplicate ids would make the transcript's chips ambiguous and are never
  // something the composer produces.
  const ids = new Set(attachments.map((attachment) => attachment.id));
  if (ids.size !== attachments.length) {
    throw new ValidationError(field, 'must not contain two attachments with the same id');
  }

  return attachments;
}

function validateRunInput(value: unknown, field: string): RunInput {
  const input = requireObject(value, field);

  const providerId = input['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError(`${field}.providerId`, 'is not a known provider');

  const permissionMode = input['permissionMode'];
  if (permissionMode !== undefined && permissionMode !== null && !isPermissionMode(permissionMode)) {
    throw new ValidationError(`${field}.permissionMode`, 'is not a known permission mode');
  }

  // Shape only, exactly like `backend` and `authMode` on a profile: whether the
  // provider actually declares a level by this name is the adapter's question,
  // and the adapter answers it by rejecting the run rather than dropping the
  // setting. This boundary only proves it is an id and not a payload.
  const effort = input['effort'];
  if (effort !== undefined && effort !== null && !isProviderEffort(effort)) {
    throw new ValidationError(`${field}.effort`, 'is not a valid reasoning-effort id');
  }

  // The prompt is allowed to be empty — resuming a session to let the agent
  // continue is a real workflow — so it is length-checked rather than
  // required-non-empty.
  const prompt = input['prompt'];
  if (typeof prompt !== 'string') throw new ValidationError(`${field}.prompt`, 'must be a string');
  if (prompt.length > LIMITS.prompt) {
    throw new ValidationError(`${field}.prompt`, `must be at most ${LIMITS.prompt} characters`);
  }

  return compact<RunInput>({
    providerId,
    profileId: requireId(input['profileId'], `${field}.profileId`),
    cwd: requireAbsolutePath(input['cwd'], `${field}.cwd`),
    prompt,
    attachments: optionalAttachments(input['attachments'], `${field}.attachments`),
    runId: optionalId(input['runId'], `${field}.runId`),
    resumeSessionId: optionalId(input['resumeSessionId'], `${field}.resumeSessionId`),
    forkSession: optionalBoolean(input['forkSession'], `${field}.forkSession`),
    model: optionalString(input['model'], `${field}.model`, LIMITS.model),
    fallbackModel: optionalString(input['fallbackModel'], `${field}.fallbackModel`, LIMITS.model),
    permissionMode: permissionMode === null ? undefined : (permissionMode as RunInput['permissionMode']),
    effort: effort === null ? undefined : (effort as RunInput['effort']),
    allowedTools: optionalStringArray(
      input['allowedTools'],
      `${field}.allowedTools`,
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    disallowedTools: optionalStringArray(
      input['disallowedTools'],
      `${field}.disallowedTools`,
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    additionalDirectories: optionalAbsolutePathArray(
      input['additionalDirectories'],
      `${field}.additionalDirectories`,
    ),
    maxTurns: optionalInteger(input['maxTurns'], `${field}.maxTurns`, 1, LIMITS.maxTurns),
    maxBudgetUsd: optionalFiniteNumber(input['maxBudgetUsd'], `${field}.maxBudgetUsd`, 0, LIMITS.maxBudgetUsd),
    systemPrompt: optionalSystemPrompt(input['systemPrompt'], `${field}.systemPrompt`),
    title: optionalString(input['title'], `${field}.title`, LIMITS.label),
    includePartialMessages: optionalBoolean(input['includePartialMessages'], `${field}.includePartialMessages`),
    metadata: optionalJsonObject(input['metadata'], `${field}.metadata`, LIMITS.metadataNodes, LIMITS.metadataDepth),
  });
}

/* -------------------------------------------------------------------------- */
/* Request validators, one per channel                                        */
/* -------------------------------------------------------------------------- */

export function validateProfilesList(raw: unknown): ProfilesListRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (providerId === undefined || providerId === null) return {};
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return { providerId };
}

export function validateProfilesCreate(raw: unknown): ProfilesCreateRequest {
  const request = requireRequest(raw);
  return { draft: validateProfileDraft(request['draft'], 'draft') };
}

export function validateProfilesUpdate(raw: unknown): ProfilesUpdateRequest {
  const request = requireRequest(raw);
  return {
    id: requireId(request['id'], 'id'),
    patch: validateProfilePatch(request['patch'], 'patch'),
  };
}

export function validateProfilesDelete(raw: unknown): ProfilesDeleteRequest {
  const request = requireRequest(raw);
  return compact<ProfilesDeleteRequest>({
    id: requireId(request['id'], 'id'),
    deleteConfigDir: optionalBoolean(request['deleteConfigDir'], 'deleteConfigDir'),
  });
}

/**
 * A label to name a suggested directory after.
 *
 * Accepts an empty label — the create form calls this while the user is still
 * typing, and refusing the first keystroke would leave the field blank at the
 * exact moment it is most useful. The suggestion falls back to a generic name.
 */
export function validateProfilesSuggestDir(raw: unknown): ProfilesSuggestDirRequest {
  const request = requireRequest(raw);
  const label = request['label'];
  if (label !== undefined && typeof label !== 'string') {
    throw new ValidationError('label', 'must be a string');
  }
  return { label: (label ?? '').slice(0, LIMITS.label) };
}

export function validateProvidersList(raw: unknown): ProvidersListRequest {
  const request = requireRequest(raw);
  return compact<ProvidersListRequest>({ refresh: optionalBoolean(request['refresh'], 'refresh') });
}

/**
 * The live model catalogue.
 *
 * `providerId` and `profileId` get the same treatment they get in
 * {@link validateSessionsList}, and for the same reason: together they decide
 * which adapter runs and which credential it runs with. A `profileId` that is
 * merely well-formed is still checked against the store downstream, so this
 * only has to reject the shapes that would reach an adapter as garbage.
 *
 * `cwd` is optional here but absolute when present. The provider resolves its
 * configuration relative to it, so a relative path would be resolved against
 * the main process's `process.cwd()` — an artefact of how Artemis was launched,
 * and never what the renderer meant.
 */
export function validateProvidersModels(raw: unknown): ProvidersModelsRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return compact<ProvidersModelsRequest>({
    providerId,
    profileId: requireId(request['profileId'], 'profileId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
  });
}

export function validateRunsStart(raw: unknown): RunsStartRequest {
  const request = requireRequest(raw);
  return { input: validateRunInput(request['input'], 'input') };
}

export function validateRunsSend(raw: unknown): RunsSendRequest {
  const request = requireRequest(raw);
  const text = request['text'];
  if (typeof text !== 'string') throw new ValidationError('text', 'must be a string');
  if (text.length > LIMITS.text) throw new ValidationError('text', `must be at most ${LIMITS.text} characters`);
  return compact<RunsSendRequest>({
    runId: requireId(request['runId'], 'runId'),
    text,
    attachments: optionalAttachments(request['attachments'], 'attachments'),
  });
}

export function validateRunsInterrupt(raw: unknown): RunsInterruptRequest {
  const request = requireRequest(raw);
  return { runId: requireId(request['runId'], 'runId') };
}

export function validateRunsRespondPermission(raw: unknown): RunsRespondPermissionRequest {
  const request = requireRequest(raw);
  return {
    runId: requireId(request['runId'], 'runId'),
    requestId: requireId(request['requestId'], 'requestId'),
    decision: validatePermissionDecision(request['decision'], 'decision'),
  };
}

export function validateRunsDispose(raw: unknown): RunsDisposeRequest {
  const request = requireRequest(raw);
  return { runId: requireId(request['runId'], 'runId') };
}

export function validateRunsList(raw: unknown): RunsListRequest {
  const request = requireRequest(raw);
  return compact<RunsListRequest>({ cwd: optionalAbsolutePath(request['cwd'], 'cwd') });
}

export function validateSessionsList(raw: unknown): SessionsListRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (!isProviderId(providerId)) throw new ValidationError('providerId', 'is not a known provider');
  return compact<SessionsListRequest>({
    providerId,
    profileId: requireId(request['profileId'], 'profileId'),
    cwd: requireAbsolutePath(request['cwd'], 'cwd'),
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.pageSize),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * The aggregated listing.
 *
 * Note what is *absent*: no profile id and no cwd. Both are answers this query
 * produces rather than inputs it takes — the renderer cannot ask for another
 * profile's history because it does not name a profile at all. `providerId` is
 * the one filter, and it is optional.
 */
export function validateSessionsListAll(raw: unknown): SessionsListAllRequest {
  const request = requireRequest(raw);
  const providerId = request['providerId'];
  if (providerId !== undefined && providerId !== null && !isProviderId(providerId)) {
    throw new ValidationError('providerId', 'is not a known provider');
  }
  return compact<SessionsListAllRequest>({
    providerId: providerId === undefined || providerId === null ? undefined : providerId,
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.pageSize),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * The directory picker.
 *
 * `defaultPath` only decides where the dialog opens; the user still has to
 * choose. It is required to be absolute all the same — a relative path would
 * be resolved against the main process's `process.cwd()`, which is an
 * implementation detail of how Artemis was launched and has nothing to do with
 * anything the user can see.
 *
 * The dialog's title and button text are deliberately **not** accepted. They
 * are copy in a native OS window, and letting the renderer write them would
 * make a system dialog say whatever renderer script wanted it to say.
 */
export function validateWorkspacePickDirectory(raw: unknown): WorkspacePickDirectoryRequest {
  const request = requireRequest(raw);
  return compact<WorkspacePickDirectoryRequest>({
    defaultPath: optionalAbsolutePath(request['defaultPath'], 'defaultPath'),
  });
}

/** Naming a directory. Absolute, because there is nothing to resolve against. */
export function validateWorkspaceDescribe(raw: unknown): WorkspaceDescribeRequest {
  const request = requireRequest(raw);
  return { path: requireAbsolutePath(request['path'], 'path') };
}

/** Opening a stored session: which profile, which session, which run to stamp. */
export function validateSessionsMessages(raw: unknown): SessionsMessagesRequest {
  const request = requireRequest(raw);
  return compact<SessionsMessagesRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    runId: requireId(request['runId'], 'runId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    limit: optionalInteger(request['limit'], 'limit', 1, LIMITS.pageSize),
    offset: optionalInteger(request['offset'], 'offset', 0, LIMITS.offset),
  });
}

/**
 * Retitle one session.
 *
 * `title` is bounded but not otherwise policed: it is a display string that is
 * appended to a JSONL record and rendered as text, never interpolated into a
 * path or a command, so the only hostile input worth refusing here is one big
 * enough to be an attack on the store itself. `requireString` already rejects
 * NUL bytes, which is the character that would corrupt the record.
 */
export function validateSessionsRename(raw: unknown): SessionsRenameRequest {
  const request = requireRequest(raw);
  return compact<SessionsRenameRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
    title: requireString(request['title'], 'title', LIMITS.sessionTitle),
  });
}

/**
 * Destroy one session.
 *
 * Nothing here is a policy check. The decision to delete is the user's and was
 * taken in front of a confirmation dialog in the renderer; this only makes sure
 * the three fields naming *which* transcript are well-formed, so that a
 * malformed id cannot become a path.
 */
export function validateSessionsDelete(raw: unknown): SessionsDeleteRequest {
  const request = requireRequest(raw);
  return compact<SessionsDeleteRequest>({
    profileId: requireId(request['profileId'], 'profileId'),
    sessionId: requireId(request['sessionId'], 'sessionId'),
    cwd: optionalAbsolutePath(request['cwd'], 'cwd'),
  });
}

/** Plan usage is per-account, so a profile id is the whole request. */
export function validateAuthStatus(raw: unknown): AuthStatusRequest {
  const request = requireRequest(raw);
  return { profileId: requireId(request['profileId'], 'profileId') };
}

export function validateAuthSignOut(raw: unknown): AuthSignOutRequest {
  const request = requireRequest(raw);
  return { profileId: requireId(request['profileId'], 'profileId') };
}

export function validateUsagePlan(raw: unknown): UsagePlanRequest {
  const request = requireRequest(raw);
  return {
    profileId: requireId(request['profileId'], 'profileId'),
  };
}

/**
 * Every window channel's request: nothing at all.
 *
 * Shared by all four rather than written out four times, because there is
 * genuinely one shape and a copy per channel would only invite them to drift.
 *
 * `requireRequest` still runs, so a non-object payload is rejected rather than
 * ignored, and rule (2) at the top of this file still holds in the strongest
 * possible form — the returned object is a fresh empty one, so a renderer that
 * attaches a `windowId` finds it dropped before any handler could read it. That
 * is the point: the window a command acts on is the one it arrived from, and
 * nothing in the payload can change that.
 */
export function validateWindowRequest(raw: unknown): WindowRequest {
  requireRequest(raw);
  return {};
}
