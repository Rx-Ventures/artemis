/**
 * The machine's key managers, read on demand and acted on one click at a time.
 *
 * A hook for `useMemoryBanks`'s reason: the reading has a lifecycle (in
 * flight, landed, failed) and the pane has *actions* whose in-flight state has
 * to dim the right button. Threading that through a component body is how a
 * pane ends up showing a stale row beside a fresh receipt.
 *
 * **Not in the app store, deliberately.** Nothing outside this pane needs to
 * know which managers exist — the resolution that matters happens in the main
 * process, at the moment a subprocess needs a value, and a copy of the list in
 * global state would only be a second thing to keep fresh.
 *
 * Every write channel answers with the whole list, so this never patches its
 * own state optimistically: what is on screen is always what main last said.
 * That matters more here than elsewhere because a save has a side effect the
 * renderer cannot predict — for a `userpass` connection it performs a login,
 * and whether that login worked is the answer, not the request.
 */

import { useCallback, useEffect, useState } from 'react';

import type {
  ArtemisBridge,
  IpcResult,
  SecretConnectionState,
  SecretProviderDescriptor,
  SecretRef,
  SecretRefTestResult,
  SecretServerCertificate,
  SecretVerifyResult,
  SecretsConnectionSaveRequest,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/** Which action is running. One slot: every button dims while any runs. */
export type SecretManagerAction = 'save' | 'verify' | 'delete' | 'certificate';

export interface SecretManagersPane {
  /** A read is in flight. True on first render, before anything is known. */
  readonly reading: boolean;
  readonly connections: readonly SecretConnectionState[];
  /** What the forms are built from. Empty until the first read lands. */
  readonly providers: readonly SecretProviderDescriptor[];
  /** Why the read failed, already safe to show. */
  readonly error: string | null;
  readonly busy: SecretManagerAction | null;
  /** The last write's own words, kept until the next one. */
  readonly lastAction: string | null;
  readonly refresh: () => void;
  /** Create or replace a connection. Answers with what verifying it came to. */
  readonly save: (request: SecretsConnectionSaveRequest) => Promise<SecretVerifyResult | null>;
  readonly verify: (id: string) => Promise<SecretVerifyResult | null>;
  readonly remove: (id: string) => Promise<boolean>;
  /**
   * Shake hands with a server and bring back its certificate for the user to
   * look at. Nothing is trusted by calling this.
   */
  readonly fetchCertificate: (address: string) => Promise<IpcResult<SecretServerCertificate>>;
  /**
   * Resolve a reference and throw the value away.
   *
   * Deliberately outside the `busy` slot, for `useMemoryBanks.verifyRemote`'s
   * reason: it changes nothing, its answer belongs beside the fields that
   * produced it, and a user trying paths should not have the pane dim on every
   * attempt.
   */
  readonly testRef: (ref: SecretRef) => Promise<IpcResult<SecretRefTestResult>>;
}

function secretsChannel(): ArtemisBridge['secrets'] | null {
  return resolveBridge().bridge?.secrets ?? null;
}

export function useSecretManagers(): SecretManagersPane {
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState(true);
  const [connections, setConnections] = useState<readonly SecretConnectionState[]>([]);
  const [providers, setProviders] = useState<readonly SecretProviderDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SecretManagerAction | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  useEffect(() => {
    const channel = secretsChannel();
    if (channel === null) {
      setReading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    setReading(true);
    void (async () => {
      const result = await call(() => channel.listConnections({}));
      if (cancelled) return;
      setReading(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setConnections(result.value.connections);
      setProviders(result.value.providers);
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((count) => count + 1), []);

  const save = useCallback(
    async (request: SecretsConnectionSaveRequest): Promise<SecretVerifyResult | null> => {
      const channel = secretsChannel();
      if (channel === null) return null;
      setBusy('save');
      const result = await call(() => channel.saveConnection(request));
      setBusy(null);
      if (!result.ok) {
        setLastAction(result.error.message);
        return null;
      }
      setConnections(result.value.connections);
      setProviders(result.value.providers);
      setLastAction(result.value.verify.detail);
      return result.value.verify;
    },
    [],
  );

  const verify = useCallback(async (id: string): Promise<SecretVerifyResult | null> => {
    const channel = secretsChannel();
    if (channel === null) return null;
    setBusy('verify');
    const result = await call(() => channel.verifyConnection({ id }));
    setBusy(null);
    if (!result.ok) {
      setLastAction(result.error.message);
      return null;
    }
    setConnections(result.value.connections);
    setProviders(result.value.providers);
    setLastAction(result.value.verify.detail);
    return result.value.verify;
  }, []);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    const channel = secretsChannel();
    if (channel === null) return false;
    setBusy('delete');
    const result = await call(() => channel.deleteConnection({ id }));
    setBusy(null);
    if (!result.ok) {
      setLastAction(result.error.message);
      return false;
    }
    setConnections(result.value.connections);
    setProviders(result.value.providers);
    setLastAction('The connection and its credential are gone.');
    return true;
  }, []);

  const fetchCertificate = useCallback(
    async (address: string): Promise<IpcResult<SecretServerCertificate>> => {
      const channel = secretsChannel();
      if (channel === null) {
        return {
          ok: false,
          error: { code: 'transport', message: 'This window cannot reach the main process.', retryable: true },
        };
      }
      setBusy('certificate');
      const result = await call(() => channel.fetchServerCert({ address }));
      setBusy(null);
      return result.ok ? { ok: true, value: result.value.certificate } : result;
    },
    [],
  );

  const testRef = useCallback(async (ref: SecretRef): Promise<IpcResult<SecretRefTestResult>> => {
    const channel = secretsChannel();
    if (channel === null) {
      return {
        ok: false,
        error: { code: 'transport', message: 'This window cannot reach the main process.', retryable: true },
      };
    }
    return call(() => channel.testRef({ ref }));
  }, []);

  return {
    reading,
    connections,
    providers,
    error,
    busy,
    lastAction,
    refresh,
    save,
    verify,
    remove,
    fetchCertificate,
    testRef,
  };
}
