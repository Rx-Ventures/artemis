/**
 * The Cerebro bank, read on demand and acted on one click at a time.
 *
 * A hook for the same reason `useSharedConfigStatus` is one: the reading has a
 * lifecycle (in flight, landed, failed) plus a re-read, and the pane also has
 * three *actions* whose in-flight state has to dim the right button. Threading
 * that through a component body is how a pane ends up showing a stale bank
 * next to a fresh receipt.
 *
 * **Not in the app store, deliberately** — the same argument as the shared
 * config reading, stronger here: this is a photograph of a git clone that
 * agents, hooks, and *other machines'* pull requests change underneath us.
 * Nothing in the app should ever treat it as settled fact; the pane re-reads
 * after every action, and that is the only freshness promised.
 *
 * Actions run one at a time (`busy` is a single slot, and every button
 * disables while any action runs). Not a technical limit — the CLI serialises
 * itself with a lock — but an honest UI one: two in-flight receipts would
 * race for the one `lastAction` line, and the loser's outcome would vanish.
 */

import { useCallback, useEffect, useState } from 'react';

import type {
  ArtemisBridge,
  CerebroActionResponse,
  CerebroMemory,
  CerebroPreflight,
  CerebroRetireRequest,
  CerebroStatus,
  IpcResult,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

export type CerebroAction = 'setup' | 'sync' | 'retire';

/** What the last click came to — the CLI's own words, kept until the next click. */
export interface CerebroReceipt {
  readonly ok: boolean;
  readonly message: string;
}

export interface CerebroPane {
  /** A read is in flight. True on first render, before anything is known. */
  readonly reading: boolean;
  /** The last successful status reading, or `null` if there has not been one. */
  readonly status: CerebroStatus | null;
  /**
   * What this machine is missing, with the fix for each.
   *
   * Read alongside status rather than on demand: the pane's primary action is
   * "set up", and an enabled button that fails on click because `git` is not
   * installed is the exact experience the check exists to prevent.
   */
  readonly preflight: CerebroPreflight | null;
  /** The bank's memories; empty until the bank is installed and read. */
  readonly memories: readonly CerebroMemory[];
  /** Why the read failed, already safe to show. Mutually exclusive with {@link status}. */
  readonly error: string | null;
  readonly refresh: () => void;
  /** The action currently running, or `null`. Every button disables while one runs. */
  readonly busy: CerebroAction | null;
  readonly lastAction: CerebroReceipt | null;
  readonly setup: () => void;
  readonly sync: () => void;
  readonly retire: (request: CerebroRetireRequest) => void;
}

function cerebroChannel(): ArtemisBridge['cerebro'] | null {
  return resolveBridge().bridge?.cerebro ?? null;
}

export function useCerebro(): CerebroPane {
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState(true);
  const [status, setStatus] = useState<CerebroStatus | null>(null);
  const [preflight, setPreflight] = useState<CerebroPreflight | null>(null);
  const [memories, setMemories] = useState<readonly CerebroMemory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CerebroAction | null>(null);
  const [lastAction, setLastAction] = useState<CerebroReceipt | null>(null);

  useEffect(() => {
    const channel = cerebroChannel();
    if (channel === null) {
      setReading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    setReading(true);

    void (async () => {
      const statusResult = await call(() => channel.status({}));
      if (cancelled) return;
      if (!statusResult.ok) {
        setReading(false);
        setStatus(null);
        setMemories([]);
        setError(statusResult.error.message);
        return;
      }
      // The list is only worth asking for once the repo exists; before setup
      // it would just be the same "not installed" fact wearing an error. The
      // preflight is the opposite — it matters most when nothing is installed.
      if (!statusResult.value.installed) {
        const preflightResult = await call(() => channel.preflight({}));
        if (cancelled) return;
        setReading(false);
        setStatus(statusResult.value);
        setPreflight(preflightResult.ok ? preflightResult.value : null);
        setMemories([]);
        setError(preflightResult.ok ? null : preflightResult.error.message);
        return;
      }
      const listResult = await call(() => channel.list({}));
      if (cancelled) return;
      setReading(false);
      setStatus(statusResult.value);
      setMemories(listResult.ok ? listResult.value.memories : []);
      setError(listResult.ok ? null : listResult.error.message);
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const act = useCallback(
    async (
      kind: CerebroAction,
      operation: (channel: ArtemisBridge['cerebro']) => Promise<IpcResult<CerebroActionResponse>>,
    ): Promise<boolean> => {
      const channel = cerebroChannel();
      if (channel === null) return false;
      setBusy(kind);
      const result = await call(() => operation(channel));
      setBusy(null);
      setLastAction(
        result.ok ? { ok: true, message: result.value.message } : { ok: false, message: result.error.message },
      );
      if (result.ok) refresh();
      return result.ok;
    },
    [refresh],
  );

  const setup = useCallback(() => void act('setup', (c) => c.setup({})), [act]);
  const sync = useCallback(() => void act('sync', (c) => c.sync({})), [act]);
  const retire = useCallback(
    (request: CerebroRetireRequest) => void act('retire', (c) => c.retire(request)),
    [act],
  );

  return {
    reading,
    status,
    preflight,
    memories,
    error,
    refresh,
    busy,
    lastAction,
    setup,
    sync,
    retire,
  };
}

/**
 * Just "is the bank on this machine?".
 *
 * The Agents pane needs this one boolean, to decide whether its built-in
 * Cerebro prompt is currently being sent. Reaching for {@link useCerebro} there
 * would work and would also pull every memory in the bank across IPC — bodies
 * included — plus a preflight that shells out to `cerebro doctor`, all to
 * answer a yes/no question on a pane that shows neither.
 *
 * `null` while the read is in flight, and *stays* `null` if it fails. Not
 * `false`: "not installed" is a claim the pane puts on screen next to a prompt
 * it says is not being sent, and a failed read is not evidence for it.
 */
export function useCerebroInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    const channel = cerebroChannel();
    if (channel === null) return undefined;

    let cancelled = false;
    void (async () => {
      const result = await call(() => channel.status({}));
      if (cancelled) return;
      if (result.ok) setInstalled(result.value.installed);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return installed;
}
