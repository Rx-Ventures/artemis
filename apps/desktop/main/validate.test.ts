import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import {
  validateProfilesCreate,
  validateProfilesSuggestDir,
  validateProfilesUpdate,
  validateRunsRespondPermission,
  validateRunsSend,
  validateRunsStart,
  validateSessionsList,
} from './validate.js';

/**
 * The renderer is untrusted by construction. These tests pin the two properties
 * that make that statement mean something: malformed input is rejected, and
 * *well-formed input with extra fields attached* is stripped rather than
 * forwarded.
 */

const VALID_RUN = {
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/Users/someone/project',
  prompt: 'hello',
};

describe('validateRunsStart', () => {
  it('accepts a minimal run', () => {
    const result = validateRunsStart({ input: VALID_RUN });
    expect(result.input.providerId).toBe('claude');
    expect(result.input.cwd).toBe('/Users/someone/project');
  });

  it('rejects a relative cwd', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, cwd: '../elsewhere' } })).toThrow(ValidationError);
  });

  it('rejects an unknown provider', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, providerId: 'gpt' } })).toThrow(ValidationError);
  });

  it('rejects an unknown permission mode rather than downgrading it', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, permissionMode: 'yolo' } })).toThrow(ValidationError);
  });

  it('drops fields the contract does not define', () => {
    // The interesting case: a renderer trying to reach past the contract into
    // the Claude Agent SDK's own `Options`.
    const result = validateRunsStart({
      input: {
        ...VALID_RUN,
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: '/tmp/evil',
        env: { ANTHROPIC_API_KEY: 'sk-attacker' },
      },
    });
    expect(Object.keys(result.input).sort()).toEqual(['cwd', 'profileId', 'prompt', 'providerId']);
  });

  it('accepts an empty prompt, which is how a resumed session continues', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, prompt: '' } })).not.toThrow();
  });

  it('rejects an id that is really a path', () => {
    expect(() => validateRunsStart({ input: { ...VALID_RUN, profileId: '../../etc/passwd' } })).toThrow(
      ValidationError,
    );
  });

  it('rejects a prototype-polluting metadata key', () => {
    const result = validateRunsStart({
      input: { ...VALID_RUN, metadata: JSON.parse('{"__proto__":{"polluted":true},"tab":"a"}') as object },
    });
    expect(result.input.metadata).toEqual({ tab: 'a' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

/**
 * Attachments.
 *
 * The renderer enforces every one of these limits before the send, so a user
 * never meets them. These tests are about the other caller — a renderer that
 * has been compromised, or a bug — because this is the last place a payload can
 * be refused before it is written to a file and billed to an account.
 */
describe('attachments', () => {
  /** A 1×1 PNG. Small, real, and decodes. */
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const image = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'image',
    id: 'img_1',
    mediaType: 'image/png',
    data: PNG,
    ...over,
  });

  it('accepts an image on a run and on a mid-run send', () => {
    const started = validateRunsStart({ input: { ...VALID_RUN, attachments: [image()] } });
    expect(started.input.attachments).toHaveLength(1);
    expect(started.input.attachments?.[0]?.mediaType).toBe('image/png');

    const sent = validateRunsSend({ runId: 'run_1', text: 'look', attachments: [image()] });
    expect(sent.attachments).toHaveLength(1);
  });

  it('treats an empty list as no attachments at all', () => {
    // So `compact` drops the key rather than forwarding `[]`, which an adapter
    // would otherwise have to distinguish from "none" for no reason.
    expect(validateRunsStart({ input: { ...VALID_RUN, attachments: [] } }).input.attachments).toBeUndefined();
  });

  it('rejects a media type no provider reads', () => {
    // SVG is the one worth naming: it is a document that can carry script, and
    // it is the format someone would most plausibly try.
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ mediaType: 'image/svg+xml' })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects a data: prefix rather than quietly stripping it', () => {
    expect(() =>
      validateRunsStart({
        input: { ...VALID_RUN, attachments: [image({ data: `data:image/png;base64,${PNG}` })] },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects payloads that are not base64', () => {
    // `Buffer.from(…, 'base64')` would accept both of these by discarding what
    // it could not read, which is why the check is a regex.
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ data: 'not base64!!' })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ data: 'iVBO=RwLA' })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects an image over the per-image ceiling', () => {
    // 8MB of valid base64, well past the 5MB limit.
    const huge = 'A'.repeat(4 * 1024 * 1024 * 8 / 3);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ data: huge })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects more images than a prompt can carry', () => {
    const five = Array.from({ length: 5 }, (_, index) => image({ id: `img_${String(index)}` }));
    expect(() => validateRunsStart({ input: { ...VALID_RUN, attachments: five } })).toThrow(ValidationError);
  });

  it('rejects two attachments sharing an id', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image(), image()] } }),
    ).toThrow(ValidationError);
  });

  it('rejects an id that is really a path', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ id: '../../etc/passwd' })] } }),
    ).toThrow(ValidationError);
  });

  it('drops a caller-supplied path', () => {
    // The shape the protocol deliberately does not have. A renderer that sends
    // one is asking the main process to read a file of its choosing.
    const result = validateRunsStart({
      input: { ...VALID_RUN, attachments: [image({ path: '/Users/someone/.ssh/id_rsa' })] },
    });
    expect(result.input.attachments?.[0]).not.toHaveProperty('path');
  });

  it('keeps a filename as a label but caps its length', () => {
    const named = validateRunsStart({
      input: { ...VALID_RUN, attachments: [image({ name: 'shot.png' })] },
    });
    expect(named.input.attachments?.[0]?.name).toBe('shot.png');

    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ name: 'x'.repeat(500) })] } }),
    ).toThrow(ValidationError);
  });

  it('rejects anything that is not an image', () => {
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: [image({ kind: 'file' })] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: ['not an object'] } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateRunsStart({ input: { ...VALID_RUN, attachments: { 0: image() } } }),
    ).toThrow(ValidationError);
  });
});

describe('validateProfilesCreate', () => {
  it('accepts a first-party draft', () => {
    const result = validateProfilesCreate({
      draft: { label: 'Work', providerId: 'claude', configDir: '  /Users/me/.claude  ' },
    });
    expect(result.draft.label).toBe('Work');
    // Trimmed, because a pasted path routinely arrives with whitespace.
    expect(result.draft.configDir).toBe('/Users/me/.claude');
  });

  it('requires a config directory', () => {
    // No default. A profile with no directory has no account and no history,
    // and guessing one on the user's behalf is what the old scheme did.
    expect(() => validateProfilesCreate({ draft: { label: 'Work', providerId: 'claude' } })).toThrow(
      ValidationError,
    );
  });

  it('rejects a relative config directory', () => {
    // The path is resolved by a child process whose working directory is not
    // the user's, so a relative one means somewhere nobody intended.
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', configDir: '.claude' } }),
    ).toThrow(ValidationError);
  });

  it('rejects a config directory that traverses upward', () => {
    expect(() =>
      validateProfilesCreate({
        draft: { label: 'W', providerId: 'claude', configDir: '/Users/me/../../etc' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects the filesystem root', () => {
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', configDir: '/' } }),
    ).toThrow(ValidationError);
  });

  it('rejects a tilde rather than creating a directory literally named "~"', () => {
    // Nothing in Artemis expands `~`; a child process would receive it verbatim.
    expect(() =>
      validateProfilesCreate({
        draft: { label: 'W', providerId: 'claude', configDir: '~/.claude' },
      }),
    ).toThrow(ValidationError);
  });

  it('normalises a colour, and rejects one that is not hex', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Work',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        color: '#ABC',
      },
    });
    expect(result.draft.color).toBe('#aabbcc');

    // Rejected rather than dropped: silently discarding it would show the user
    // a colour they picked and save a profile without it.
    expect(() =>
      validateProfilesCreate({
        draft: {
          label: 'Work',
          providerId: 'claude',
          configDir: '/Users/me/.claude',
          color: 'url(javascript:alert(1))',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a credential hiding in publicEnv', () => {
    // `publicEnv` is persisted unencrypted, so this has to fail before it is
    // written anywhere.
    expect(() =>
      validateProfilesCreate({
        draft: {
          label: 'Work',
          providerId: 'claude',
          configDir: '/Users/me/.claude',
          publicEnv: { ANTHROPIC_AUTH_TOKEN: 'nope' },
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects publicEnv that would point the credential elsewhere', () => {
    // The renderer is untrusted by construction. `ANTHROPIC_BASE_URL` carries
    // no secret and passes the credential-name check, but the provider CLI will
    // send the credential from its config directory to whatever endpoint it is
    // aimed at — so a renderer that could set it would redirect a real token.
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'HTTPS_PROXY',
      'http_proxy',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      expect(() =>
        validateProfilesCreate({
          draft: {
            label: 'Work',
            providerId: 'claude',
            configDir: '/Users/me/.claude',
            publicEnv: { [key]: 'https://attacker.example' },
          },
        }),
      ).toThrow(ValidationError);
    }
  });

  it('rejects a redirecting publicEnv on update too', () => {
    expect(() =>
      validateProfilesUpdate({
        id: 'p1',
        patch: { publicEnv: { ANTHROPIC_BASE_URL: 'https://attacker.example' } },
      }),
    ).toThrow(ValidationError);
  });

  it('allows genuinely non-sensitive env vars', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Work',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        publicEnv: { AWS_REGION: 'us-east-1' },
      },
    });
    expect(result.draft.publicEnv).toEqual({ AWS_REGION: 'us-east-1' });
  });

  it('drops a field the renderer did not send', () => {
    // Payloads are rebuilt rather than passed through, so an extra property
    // cannot ride along into the engine.
    const result = validateProfilesCreate({
      draft: {
        label: 'W',
        providerId: 'claude',
        configDir: '/Users/me/.claude',
        apiKey: 'sk-ant-nope',
      },
    });
    expect('apiKey' in result.draft).toBe(false);
  });
});

describe('validateProfilesUpdate', () => {
  it('carries a config-directory change through', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { configDir: '/Users/me/other' } });
    expect(result.patch.configDir).toBe('/Users/me/other');
  });

  it('omits configDir entirely when absent, which means "leave it alone"', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('configDir' in result.patch).toBe(false);
  });

  it('rejects a malformed config directory on update', () => {
    expect(() => validateProfilesUpdate({ id: 'p1', patch: { configDir: 'relative' } })).toThrow(
      ValidationError,
    );
  });

  it('keeps an empty colour as the empty string, which is how a patch clears it', () => {
    // Coercing it to `undefined` here would turn "remove the colour" into
    // "leave it alone", and the swatch would come back after every save.
    const cleared = validateProfilesUpdate({ id: 'p1', patch: { color: '' } });
    expect(cleared.patch.color).toBe('');

    const untouched = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('color' in untouched.patch).toBe(false);
  });
});

describe('validateProfilesSuggestDir', () => {
  it('accepts a partial label, because the form asks while the user is typing', () => {
    expect(validateProfilesSuggestDir({ label: 'Wo' })).toEqual({ label: 'Wo' });
  });

  it('accepts an empty request rather than refusing the first keystroke', () => {
    expect(validateProfilesSuggestDir({})).toEqual({ label: '' });
  });

  it('rejects a non-string label', () => {
    expect(() => validateProfilesSuggestDir({ label: 42 })).toThrow(ValidationError);
  });
});

describe('validateRunsRespondPermission', () => {
  it('accepts an allow with a persisted rule', () => {
    const result = validateRunsRespondPermission({
      runId: 'r1',
      requestId: 'q1',
      decision: {
        behavior: 'allow',
        scope: 'project',
        updatedPermissions: [
          { type: 'addRules', behavior: 'allow', scope: 'project', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }] },
        ],
      },
    });
    expect(result.decision.behavior).toBe('allow');
  });

  it('rejects an unknown scope', () => {
    expect(() =>
      validateRunsRespondPermission({
        runId: 'r1',
        requestId: 'q1',
        decision: { behavior: 'allow', scope: 'forever' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects the SDK-only cliArg destination, which Artemis must never produce', () => {
    expect(() =>
      validateRunsRespondPermission({
        runId: 'r1',
        requestId: 'q1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', scope: 'cliArg' }],
        },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a decision that is neither allow nor deny', () => {
    expect(() =>
      validateRunsRespondPermission({ runId: 'r1', requestId: 'q1', decision: { behavior: 'maybe' } }),
    ).toThrow(ValidationError);
  });
});

describe('validateSessionsList', () => {
  it('requires the profile, because history is per-profile', () => {
    expect(() => validateSessionsList({ providerId: 'claude', cwd: '/a' })).toThrow(ValidationError);
  });

  it('bounds pagination', () => {
    expect(() =>
      validateSessionsList({ providerId: 'claude', profileId: 'p1', cwd: '/a', limit: 10_000_000 }),
    ).toThrow(ValidationError);
  });
});
