/**
 * @vitest-environment jsdom
 *
 * The browser preferences, and how they ride a run's input.
 *
 * Two window-level choices — "the agent browses with my Chrome"
 * (`agentChrome`) and "open pages in my default browser"
 * (`openWebExternally`) — become fields on `RunInput`, and everything
 * downstream (the adapter's `--chrome` flag, main's tool-server decision
 * table) keys off those fields. What is worth pinning here is the wiring's
 * three sharp edges:
 *
 *  - **Absent, not false.** A run with no preference must carry *neither
 *    field*: the protocol treats an absent flag as "off", and a run started
 *    before these options existed has to look byte-identical to one started
 *    after.
 *  - **Chrome is asked of Claude only.** The bridge is the Claude CLI's;
 *    sending `chromeBrowser` to a provider that has never heard of Chrome
 *    would be asking the wrong party a question whose silence looks like an
 *    answer.
 *  - **External is asked of everyone.** It describes what the *host's* tools
 *    do, and the host is the same host whichever provider is running.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test
 * files, so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  focusedPane,
  setAgentChrome,
  setOpenWebExternally,
  submitPrompt,
  useApp,
} from './store';
import { setPaneState } from './pane';

/** Every `runs.start` input main was handed, keyed by what this suite pins. */
let started: { chromeBrowser?: boolean; externalBrowser?: boolean }[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    send: async () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } }),
    start: async ({
      input,
    }: {
      input: { runId: string; chromeBrowser?: boolean; externalBrowser?: boolean };
    }) => {
      // Key presence, not value: the contract is that an unset preference is
      // an *absent* field, and a fake that normalised the two would pass a
      // wiring that sends `chromeBrowser: false` to every run.
      started.push({
        ...('chromeBrowser' in input ? { chromeBrowser: input.chromeBrowser } : {}),
        ...('externalBrowser' in input ? { externalBrowser: input.externalBrowser } : {}),
      });
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: NO_CAPABILITIES,
            startedAt: 1,
            sessionId: 'sess-new',
          },
        },
      };
    },
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

beforeEach(() => {
  started = [];
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
  } as never);
  useApp.setState({
    providers: [
      { id: 'claude', label: 'Claude', capabilities: NO_CAPABILITIES, models: [] },
      { id: 'codex', label: 'Codex', capabilities: NO_CAPABILITIES, models: [] },
    ] as never,
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude' },
      { id: 'p2', label: 'Other', providerId: 'codex' },
    ] as never,
    // Reset explicitly rather than trusting the module-scope defaults: under
    // `--localstorage-file`, a prefs blob written by an earlier local run
    // survives into this one and seeds the store before any test runs.
    agentChrome: false,
    openWebExternally: false,
    banners: [],
  });
});

describe('what rides the run input', () => {
  it('carries neither field when neither preference is set', async () => {
    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('asks Claude for the Chrome bridge when the preference is on', async () => {
    setAgentChrome(true);

    await submitPrompt('hello');

    expect(started).toEqual([{ chromeBrowser: true }]);
  });

  it('does not ask a provider without the bridge, whatever the preference', async () => {
    setAgentChrome(true);
    setPaneState(focusedPane(), { activeProviderId: 'codex', activeProfileId: 'p2' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('marks external opens for every provider alike', async () => {
    // `externalBrowser` describes the host's own tools, so — unlike the
    // Chrome flag — it is not Claude's question.
    setOpenWebExternally(true);
    setPaneState(focusedPane(), { activeProviderId: 'codex', activeProfileId: 'p2' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ externalBrowser: true }]);
  });

  it('sends both when both are set, and lets main pick the winner', async () => {
    // Precedence (Chrome wins) is the tool-server decision table's call, and
    // it is pinned there. The renderer reports preferences; it does not
    // resolve them, so the table stays the one place the rule lives.
    setAgentChrome(true);
    setOpenWebExternally(true);

    await submitPrompt('hello');

    expect(started).toEqual([{ chromeBrowser: true, externalBrowser: true }]);
  });
});

describe('the preferences themselves', () => {
  // One setter per test, and the blob is removed first — deliberately: every
  // other setter also saves the whole state, so without both, a setter that
  // forgot to persist would hide behind whichever save ran before it.
  beforeEach(() => {
    globalThis.localStorage.removeItem('artemis.prefs.v1');
  });

  const savedBlob = (): { agentChrome?: boolean; openWebExternally?: boolean } =>
    JSON.parse(globalThis.localStorage.getItem('artemis.prefs.v1') ?? '{}') as {
      agentChrome?: boolean;
      openWebExternally?: boolean;
    };

  it('persists the Chrome choice on its own, so it survives a relaunch', () => {
    setAgentChrome(true);

    expect(savedBlob().agentChrome).toBe(true);
  });

  it('persists the external-open choice on its own', () => {
    setOpenWebExternally(true);

    expect(savedBlob().openWebExternally).toBe(true);
  });
});
