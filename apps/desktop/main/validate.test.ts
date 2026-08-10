import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import {
  validateProfilesCreate,
  validateProfilesUpdate,
  validateRunsRespondPermission,
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

describe('validateProfilesCreate', () => {
  it('accepts a first-party draft', () => {
    const result = validateProfilesCreate({
      draft: { label: 'Work', providerId: 'claude', apiKey: '  sk-ant-example-key-value  ' },
    });
    expect(result.draft.label).toBe('Work');
    // Trimmed, because a pasted key routinely arrives with whitespace.
    expect(result.draft.apiKey).toBe('sk-ant-example-key-value');
  });

  it('rejects a credential hiding in publicEnv', () => {
    // `publicEnv` is persisted unencrypted, so this has to fail before it is
    // written anywhere.
    expect(() =>
      validateProfilesCreate({
        draft: { label: 'Work', providerId: 'claude', publicEnv: { ANTHROPIC_AUTH_TOKEN: 'nope' } },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects publicEnv that would point the credential elsewhere', () => {
    // The renderer is untrusted by construction. `ANTHROPIC_BASE_URL` carries
    // no secret and passes the credential-name check, but the main process
    // writes the decrypted key into the same bundle before handing it to the
    // provider subprocess — so a renderer that could set it would read the key
    // back off its own server, with nothing sensitive ever crossing IPC.
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
      draft: { label: 'Work', providerId: 'claude', publicEnv: { AWS_REGION: 'us-east-1' } },
    });
    expect(result.draft.publicEnv).toEqual({ AWS_REGION: 'us-east-1' });
  });

  it('rejects a configDirName that escapes its root', () => {
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', configDirName: '../../..' } }),
    ).toThrow(ValidationError);
  });

  it('rejects a key with an embedded newline', () => {
    expect(() =>
      validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', apiKey: 'sk-ant\nrest' } }),
    ).toThrow(ValidationError);
  });

  it('carries the auth mode through', () => {
    const result = validateProfilesCreate({
      draft: {
        label: 'Plan',
        providerId: 'claude',
        authMode: 'subscription',
        apiKey: 'sk-ant-oat01-0123456789abcdef',
      },
    });
    expect(result.draft.authMode).toBe('subscription');
  });

  it('drops an auth mode the renderer did not send', () => {
    // Payloads are rebuilt rather than passed through, so an absent field must
    // stay absent — that is what makes "the provider's default mode" reachable.
    const result = validateProfilesCreate({ draft: { label: 'W', providerId: 'claude' } });
    expect('authMode' in result.draft).toBe(false);
  });

  it('rejects a malformed auth mode id', () => {
    // Shape only. Whether Claude offers a mode by this name, and whether it
    // offers it on the chosen backend, is decided in `resolveEnv` where the
    // adapter's declared list is reachable.
    for (const authMode of ['Subscription', 'sub scription', '../../etc', 1]) {
      expect(() =>
        validateProfilesCreate({ draft: { label: 'W', providerId: 'claude', authMode } }),
      ).toThrow(ValidationError);
    }
  });
});

describe('validateProfilesUpdate', () => {
  it('preserves a null apiKey, which means "delete the credential"', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { apiKey: null } });
    expect(result.patch.apiKey).toBeNull();
  });

  it('omits apiKey entirely when absent, which means "leave it alone"', () => {
    const result = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('apiKey' in result.patch).toBe(false);
  });

  it('carries an auth-mode switch through, and omits it when absent', () => {
    const switched = validateProfilesUpdate({
      id: 'p1',
      patch: { authMode: 'subscription', apiKey: 'sk-ant-oat01-0123456789abcdef' },
    });
    expect(switched.patch.authMode).toBe('subscription');

    const renamed = validateProfilesUpdate({ id: 'p1', patch: { label: 'Renamed' } });
    expect('authMode' in renamed.patch).toBe(false);
  });

  it('rejects a malformed auth mode on update', () => {
    expect(() => validateProfilesUpdate({ id: 'p1', patch: { authMode: 'NOT A MODE' } })).toThrow(
      ValidationError,
    );
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

  it('rejects the SDK-only cliArg destination, which Libra must never produce', () => {
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
