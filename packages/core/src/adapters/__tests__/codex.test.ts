/**
 * Tests for the Codex adapter's decision-making.
 *
 * Everything here is a pure function or a rejection that happens before a
 * process is spawned, so none of it touches the `codex` binary. The live
 * transport is covered by `jsonrpc.test.ts` on one side and `codexMapper.test.ts`
 * on the other; what is left in between — permission mapping, input validation,
 * response parsing, approval translation — is what this file pins down.
 */

import { describe, expect, it } from 'vitest';

import type { JsonValue, PermissionMode, ProfileId, RunId } from '@rx-artemis/protocol';

import {
  CODEX_CAPABILITIES,
  CODEX_CREDENTIALS,
  CODEX_CREDENTIAL_ENVS,
  CODEX_HOME_ENV,
  createCodexAdapter,
  parseCodexAuthStatus,
  parseModelList,
  parseRateLimitWindows,
  parseThreadList,
  toApprovalResponse,
  toCodexPermissions,
  validateCodexRunInput,
} from '../codex.js';
import { CODEX_SERVER_REQUEST } from '../codexProtocol.js';
import { isAdapterError } from '../types.js';
import type { ProbeResult, ResolvedRunInput } from '../types.js';

const PROFILE = 'p-1' as ProfileId;

function runInput(overrides?: Partial<ResolvedRunInput>): ResolvedRunInput {
  return {
    providerId: 'codex',
    profileId: PROFILE,
    cwd: '/work/repo',
    prompt: 'hello',
    runId: 'run-1' as RunId,
    env: { [CODEX_HOME_ENV]: '/profiles/work' },
    ...overrides,
  };
}

describe('capabilities', () => {
  it('advertises only permission modes Codex can honour exactly', () => {
    // `dontAsk` means "never prompt, deny instead". Codex's `never` proceeds
    // instead of denying, so offering it would be silently more permissive than
    // the user asked for. `auto` has no equivalent at all.
    expect(CODEX_CAPABILITIES.permissionModes).toEqual([
      'plan',
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  });

  it('claims streaming, steering and plan usage, but not cost', () => {
    expect(CODEX_CAPABILITIES).toMatchObject({
      interactivePermissions: true,
      partialMessages: true,
      midRunSteering: true,
      forkSession: true,
      resumeSession: true,
      listSessions: true,
      usageReporting: true,
      planUsageReporting: true,
      costReporting: false,
      subagents: false,
    });
  });
});

describe('credentials', () => {
  it('scopes a profile with CODEX_HOME', () => {
    expect(CODEX_CREDENTIALS.configDirVar).toBe('CODEX_HOME');
  });

  it('strips every variable that could authenticate around the profile', () => {
    // Each of these outranks CODEX_HOME. An OPENAI_API_KEY in the user's shell
    // would bill metered usage against the subscription the profile just signed
    // into.
    expect(CODEX_CREDENTIAL_ENVS).toContain('OPENAI_API_KEY');
    expect(CODEX_CREDENTIAL_ENVS).toContain('OPENAI_BASE_URL');
    expect(CODEX_CREDENTIAL_ENVS).toContain('CODEX_HOME');
  });

  it('names the real login argv', () => {
    expect(CODEX_CREDENTIALS.signIn.executable).toBe('codex');
    expect(CODEX_CREDENTIALS.signIn.loginArgs).toEqual(['login']);
    expect(CODEX_CREDENTIALS.signIn.statusArgs).toEqual(['login', 'status']);
    expect(CODEX_CREDENTIALS.signIn.logoutArgs).toEqual(['logout']);
  });

  it('supplies its own status parser, because Codex prints prose', () => {
    // Without this, the shared polling path would run Claude's JSON reader over
    // "Logged in using ChatGPT" and report a signed-in profile as signed out.
    expect(CODEX_CREDENTIALS.signIn.parseStatus).toBe(parseCodexAuthStatus);
  });
});

describe('parseCodexAuthStatus', () => {
  const probe = (stdout: string, exitCode = 0, stderr = ''): ProbeResult => ({
    stdout,
    stderr,
    exitCode,
  });

  it('reads the signed-in line from stderr, where Codex actually writes it', () => {
    // The bug this pins down: `codex login status` writes to stderr and leaves
    // stdout empty. `codex login status 2>&1` hides that completely, which is
    // how the first version of this parser shipped reading only stdout and
    // reported a signed-in account as an error.
    expect(parseCodexAuthStatus(probe('', 0, 'Logged in using ChatGPT\n'))).toEqual({
      loggedIn: true,
      authMethod: 'chatgpt',
    });
  });

  it('reads it from stdout too, in case that ever changes', () => {
    expect(parseCodexAuthStatus(probe('Logged in using ChatGPT\n'))).toEqual({
      loggedIn: true,
      authMethod: 'chatgpt',
    });
  });

  it('reads the signed-out line, which exits non-zero', () => {
    // Exit 1 is the *normal* signed-out case, so the exit code cannot be the
    // signal — the text is.
    expect(parseCodexAuthStatus(probe('', 1, 'Not logged in\n'))).toEqual({
      loggedIn: false,
      authMethod: 'none',
    });
  });

  it('does not mistake "Not logged in" for a match on "logged in"', () => {
    // The substring is right there; order of the checks is what saves it.
    expect(parseCodexAuthStatus(probe('Not logged in', 1)).loggedIn).toBe(false);
  });

  it('normalises the auth method to the app server’s vocabulary', () => {
    // `getAuthStatus` over the app server says `chatgpt` / `apikey`. The two
    // paths describe the same account, so they must not disagree about it.
    expect(parseCodexAuthStatus(probe('Logged in using ChatGPT')).authMethod).toBe('chatgpt');
    expect(parseCodexAuthStatus(probe('Logged in using an API key')).authMethod).toBe('apikey');
  });

  it('still reports signed in when the method is unfamiliar', () => {
    const status = parseCodexAuthStatus(probe('Logged in using Enterprise SSO'));
    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe('enterprise sso');
  });

  it('handles a bare "Logged in" with no method', () => {
    expect(parseCodexAuthStatus(probe('Logged in'))).toEqual({
      loggedIn: true,
      authMethod: 'unknown',
    });
  });

  it('names a missing config directory rather than claiming signed out', () => {
    const status = parseCodexAuthStatus(
      probe('', 1, 'Error loading configuration: CODEX_HOME points to "/nope", but that path does not exist'),
    );

    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/directory does not exist/);
  });

  it('reports anything unrecognised as an error, not as signed out', () => {
    // A wrong "signed out" sends the user round a login loop they have already
    // completed; an error at least says what it saw.
    const status = parseCodexAuthStatus(probe('zsh: command not found: codex', null));
    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/command not found/);
  });

  it('reports empty output as an error', () => {
    expect(parseCodexAuthStatus(probe('', 0)).error).toBeTruthy();
  });

  it('never throws, whatever it is handed', () => {
    for (const stdout of ['', '\n\n', '{}', '💥', 'Logged in using '.repeat(500)]) {
      expect(() => parseCodexAuthStatus(probe(stdout))).not.toThrow();
    }
  });
});

describe('toCodexPermissions', () => {
  const options = { cwd: '/work/repo' };

  it('makes plan mode genuinely read-only', () => {
    // `never` alone would let the agent mutate without asking; the sandbox is
    // what actually enforces "research and propose only".
    expect(toCodexPermissions('plan', options)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('maps default onto untrusted plus a writable workspace', () => {
    expect(toCodexPermissions('default', options)).toEqual({
      approvalPolicy: 'untrusted',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/work/repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it('lets acceptEdits write without prompting but still gate escalations', () => {
    const result = toCodexPermissions('acceptEdits', options);
    expect(result.approvalPolicy).toBe('on-request');
    expect(result.sandboxPolicy).toMatchObject({ type: 'workspaceWrite' });
  });

  it('maps bypassPermissions onto full access', () => {
    expect(toCodexPermissions('bypassPermissions', options)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('treats an absent mode as default', () => {
    expect(toCodexPermissions(undefined, options)).toEqual(toCodexPermissions('default', options));
  });

  it('adds additional directories to the writable roots', () => {
    const result = toCodexPermissions('default', {
      cwd: '/work/repo',
      additionalDirectories: ['/work/shared', '/tmp/scratch'],
    });

    expect(result.sandboxPolicy).toMatchObject({
      writableRoots: ['/work/repo', '/work/shared', '/tmp/scratch'],
    });
  });

  it('never returns a sandbox that is more permissive than the mode asked for', () => {
    // A regression guard on the whole table: only the one mode that is
    // documented as dangerous may produce full access.
    for (const mode of ['plan', 'default', 'acceptEdits'] as PermissionMode[]) {
      expect(toCodexPermissions(mode, options).sandboxPolicy.type).not.toBe('dangerFullAccess');
    }
  });
});

describe('validateCodexRunInput', () => {
  /**
   * Called directly rather than through `createRun`, which spawns a process as
   * soon as validation passes. Every check below is supposed to fire *ahead* of
   * that, and testing it in isolation is the only way to prove it does.
   */
  function expectRejection(input: ResolvedRunInput, match: RegExp): void {
    let thrown: unknown;
    try {
      validateCodexRunInput(input);
    } catch (error) {
      thrown = error;
    }
    expect(isAdapterError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(match);
  }

  it('rejects a relative cwd', () => {
    expectRejection(runInput({ cwd: 'relative/path' }), /absolute path/);
  });

  it('rejects a permission mode it cannot honour, rather than downgrading it', () => {
    // The seam requires rejection here: silently downgrading a permission mode
    // is how you end up more permissive than the user asked for.
    expectRejection(runInput({ permissionMode: 'dontAsk' }), /does not support/);
    expectRejection(runInput({ permissionMode: 'auto' }), /does not support/);
  });

  it('accepts every mode it advertises', () => {
    for (const permissionMode of CODEX_CAPABILITIES.permissionModes) {
      expect(() => {
        validateCodexRunInput(runInput({ permissionMode }));
      }).not.toThrow();
    }
  });

  it('rejects an effort level it does not offer', () => {
    expectRejection(runInput({ effort: 'max' }), /effort level/);
  });

  it('accepts every effort level it advertises', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      expect(() => {
        validateCodexRunInput(runInput({ effort }));
      }).not.toThrow();
    }
  });

  it('accepts a Windows-style absolute path', () => {
    // The check must not depend on which platform the test runner is on, or a
    // Windows user's runs would be rejected by a macOS-built binary.
    expect(() => {
      validateCodexRunInput(runInput({ cwd: 'C:\\Users\\me\\repo' }));
    }).not.toThrow();
    expect(() => {
      validateCodexRunInput(runInput({ cwd: '\\\\server\\share' }));
    }).not.toThrow();
  });

  it('is exposed on the adapter as the first thing createRun does', async () => {
    // Belt and braces: the rejection must survive the trip through the adapter,
    // not just exist as a helper nobody calls.
    await expect(
      createCodexAdapter().createRun(runInput({ cwd: 'relative/path' })),
    ).rejects.toThrow(/absolute path/);
  });
});

describe('parseModelList', () => {
  const response = {
    data: [
      {
        id: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        description: 'Faster and cheaper.',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Frontier model.',
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
        ],
      },
      { id: 'internal-preview', displayName: 'Internal', hidden: true },
    ],
  } as unknown as JsonValue;

  it('puts the provider’s default first', () => {
    // `ProviderDescriptor.models` documents the first entry as what a run gets
    // when `model` is omitted, so this ordering is a contract.
    expect(parseModelList(response).map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });

  it('drops hidden models', () => {
    expect(parseModelList(response).map((m) => m.id)).not.toContain('internal-preview');
  });

  it('carries the display name, note and effort levels', () => {
    const [first] = parseModelList(response);
    expect(first).toMatchObject({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      displayName: 'GPT-5.5',
      note: 'Frontier model.',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
    });
  });

  it('ignores effort levels Artemis does not publish', () => {
    const [model] = parseModelList({
      data: [{ id: 'm', supportedReasoningEfforts: [{ reasoningEffort: 'ludicrous' }] }],
    } as unknown as JsonValue);

    expect(model).not.toHaveProperty('effortLevels');
  });

  it('returns nothing for a malformed response instead of throwing', () => {
    for (const value of [null, {}, { data: 'nope' }, [1, 2]] as unknown as JsonValue[]) {
      expect(parseModelList(value)).toEqual([]);
    }
  });
});

describe('parseThreadList', () => {
  const response = {
    data: [
      {
        id: 'th-1',
        cwd: '/work/repo',
        preview: 'fix the build',
        createdAt: 1782631656,
        updatedAt: 1782631679,
      },
      { id: 'th-2', cwd: '/other', name: 'Release prep', updatedAt: 1782631700 },
      { id: 'th-3', preview: 'no cwd anywhere' },
    ],
  } as unknown as JsonValue;

  it('converts Unix seconds to milliseconds', () => {
    // Codex timestamps in seconds; every Artemis timestamp is milliseconds.
    const [first] = parseThreadList(response, PROFILE, undefined);
    expect(first?.updatedAt).toBe(1782631679 * 1000);
    expect(first?.createdAt).toBe(1782631656 * 1000);
  });

  it('prefers a user-assigned name over the preview, and marks it custom', () => {
    const sessions = parseThreadList(response, PROFILE, undefined);
    expect(sessions.find((s) => s.id === 'th-2')).toMatchObject({
      title: 'Release prep',
      titleIsCustom: true,
    });
    expect(sessions.find((s) => s.id === 'th-1')).toMatchObject({
      title: 'fix the build',
      firstPrompt: 'fix the build',
    });
    expect(sessions.find((s) => s.id === 'th-1')).not.toHaveProperty('titleIsCustom');
  });

  it('drops a thread with no recoverable cwd rather than guessing', () => {
    // A session that cannot be grouped or resumed into a known directory is
    // worse than absent.
    expect(parseThreadList(response, PROFILE, undefined).map((s) => s.id)).toEqual(['th-1', 'th-2']);
  });

  it('falls back to the queried cwd when the thread omits one', () => {
    expect(parseThreadList(response, PROFILE, '/fallback').find((s) => s.id === 'th-3')).toMatchObject(
      { cwd: '/fallback' },
    );
  });

  it('stamps every summary with the profile it was read for', () => {
    expect(parseThreadList(response, PROFILE, '/x').every((s) => s.profileId === PROFILE)).toBe(true);
    expect(parseThreadList(response, PROFILE, '/x').every((s) => s.providerId === 'codex')).toBe(true);
  });

  it('returns nothing for a malformed response', () => {
    expect(parseThreadList({} as JsonValue, PROFILE, '/x')).toEqual([]);
  });
});

describe('parseRateLimitWindows', () => {
  it('reads the windows a real free-plan account reported', () => {
    const windows = parseRateLimitWindows({
      primary: { usedPercent: 12, windowDurationMins: 43200, resetsAt: 1789003989 },
      planType: 'free',
    });

    expect(windows).toEqual([
      { id: 'primary', label: '30 days', utilization: 12, resetsAt: 1789003989 * 1000 },
    ]);
  });

  it('labels windows by their duration', () => {
    const label = (windowDurationMins: number): string =>
      parseRateLimitWindows({ primary: { windowDurationMins } })[0]?.label ?? '';

    expect(label(300)).toBe('5 hours');
    expect(label(60)).toBe('1 hour');
    expect(label(1440)).toBe('24 hours');
    expect(label(10080)).toBe('7 days');
    expect(label(43200)).toBe('30 days');
    expect(label(90)).toBe('90 minutes');
  });

  it('reports a missing utilization as null rather than zero', () => {
    // Zero means "none used"; null means "not reported". Conflating them would
    // show a full-looking gauge as empty.
    expect(parseRateLimitWindows({ primary: { windowDurationMins: 60 } })[0]?.utilization).toBeNull();
  });

  it('reads both windows when the plan has two', () => {
    const windows = parseRateLimitWindows({
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    });

    expect(windows.map((w) => w.id)).toEqual(['primary', 'secondary']);
  });

  it('returns nothing when no windows are present', () => {
    expect(parseRateLimitWindows({ planType: 'free' })).toEqual([]);
  });
});

describe('toApprovalResponse', () => {
  it('accepts a command approval', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.commandExecutionApproval, { behavior: 'allow' }),
    ).toEqual({ decision: 'accept' });
  });

  it('persists an approval scoped to the session', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.commandExecutionApproval, {
        behavior: 'allow',
        scope: 'session',
      }),
    ).toEqual({ decision: 'acceptForSession' });
  });

  it('treats an "always allow" rule update as a session approval', () => {
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.fileChangeApproval, {
        behavior: 'allow',
        updatedPermissions: [
          { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'ApplyPatch' }], scope: 'session' },
        ],
      }),
    ).toEqual({ decision: 'acceptForSession' });
  });

  it('declines on a denial', () => {
    for (const method of [
      CODEX_SERVER_REQUEST.commandExecutionApproval,
      CODEX_SERVER_REQUEST.fileChangeApproval,
    ]) {
      expect(toApprovalResponse(method, { behavior: 'deny' })).toEqual({ decision: 'decline' });
    }
  });

  it('answers a permissions request in its own vocabulary, not with a decision', () => {
    // This is the whole reason the translation is per-request-kind: the
    // permissions request expects a granted subset and a scope, and would not
    // understand `{ decision: 'accept' }`.
    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, { behavior: 'allow' }),
    ).toEqual({ permissions: [], scope: 'turn' });

    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, {
        behavior: 'allow',
        scope: 'session',
      }),
    ).toEqual({ permissions: [], scope: 'session' });

    expect(
      toApprovalResponse(CODEX_SERVER_REQUEST.permissionsApproval, { behavior: 'deny' }),
    ).toEqual({ permissions: [] });
  });
});
