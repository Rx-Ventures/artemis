/**
 * Settings → Remote: drive another machine's Artemis from this window.
 * ============================================================================
 *
 * The Server section's mirror (ADR 0004). Over there this machine lends its
 * accounts out under tokens it mints; here this window borrows a whole other
 * Artemis under a token *that* machine minted. The pairing is deliberately
 * manual — an address and a token, carried by hand — because reachability is
 * the tailnet's job and a QR/discovery flow would be a second, weaker claim
 * about who can reach whom. See the ADR for what was rejected.
 *
 * ## Why connecting reloads the window
 *
 * Two walls open only for a *newly loaded* document. The bridge binding is
 * resolved once per window, by design; and the CSP that lets the renderer
 * fetch the remote origin is delivered with the document's own response, so a
 * grant configured mid-flight applies to the next load, not this one. The
 * honest join of those two facts is that entering and leaving remote mode is
 * a reload — which is also why the address cannot be validated *before* the
 * reload: the current document is still walled off from it. A wrong token
 * therefore surfaces after the switch, in this same section and on the app's
 * error surface, with Disconnect as the way back.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { CastIcon } from 'lucide-react';

import { call, resolveBridge } from '../../lib/bridge';
import {
  describeRemote,
  readRemoteConfig,
  writeRemoteConfig,
  type RemoteBridgeConfig,
} from '../../lib/remoteConfig';
import { useApp } from '../../state/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusDot } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';

/** Show the shape and the tail: enough to recognise a token, not to use one. */
function maskToken(token: string): string {
  return `${'•'.repeat(Math.min(24, Math.max(0, token.length - 6)))}${token.slice(-6)}`;
}

export function RemoteSection(): ReactElement {
  const bridgeMode = useApp((s) => s.bridgeMode);
  return (
    <SettingsPane
      title="Remote"
      description="Drive another machine's Artemis from this window: its accounts, its runs, its terminals. Reachability is your tailnet's job — what travels here is an address and a token, carried by hand."
    >
      {bridgeMode === 'remote' ? <Connected /> : <Connect />}
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Connected                                                                  */
/* -------------------------------------------------------------------------- */

function Connected(): ReactElement {
  const config = readRemoteConfig();
  const [probe, setProbe] = useState<
    | { readonly status: 'checking' }
    | { readonly status: 'ok'; readonly accounts: number }
    | { readonly status: 'failed'; readonly message: string }
  >({ status: 'checking' });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const bridge = resolveBridge().bridge;
      if (bridge === null) return;
      const result = await call(() => bridge.profiles.list({}));
      if (!alive) return;
      setProbe(
        result.ok
          ? { status: 'ok', accounts: result.value.profiles.length }
          : { status: 'failed', message: result.error.message },
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  const disconnect = (): void => {
    const current = readRemoteConfig();
    if (current !== null) writeRemoteConfig({ ...current, active: false });
    // The grant in main is deliberately left standing: it names an origin the
    // user configured, unlocks nothing without the token, and keeping it
    // means reconnecting later needs no round-trip before the reload.
    globalThis.location.reload();
  };

  if (config === null) {
    // Remote mode with no readable config should be unreachable; if storage
    // was cleared out from under us, the honest offer is the way home.
    return (
      <SettingsGroup label="Connection">
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <p className="text-2xs leading-relaxed text-ink-faint">
            This window is in remote mode but its connection record is unreadable.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={disconnect}>
              Return to this machine
            </Button>
          </div>
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup label="Connection">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-3 rounded-md border border-hairline bg-panel px-3 py-2.5">
          <CastIcon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-ink">{describeRemote(config)}</div>
            <div className="truncate font-mono text-2xs text-ink-faint">
              {config.origin} · {maskToken(config.token)}
            </div>
          </div>
          {probe.status === 'checking' ? (
            <span className="shrink-0 text-2xs text-ink-faint">Checking…</span>
          ) : probe.status === 'ok' ? (
            <span className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-faint">
              <StatusDot tone="mint" />
              {probe.accounts === 1
                ? '1 account served'
                : `${String(probe.accounts)} accounts served`}
            </span>
          ) : (
            <span
              className="flex shrink-0 items-center gap-1.5 text-2xs text-amber"
              title={probe.message}
            >
              <StatusDot tone="amber" />
              Unreachable
            </span>
          )}
          <Button size="sm" variant="outline" className="shrink-0" onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      </div>
      {probe.status === 'failed' ? (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          {probe.message} A wrong token and a machine off the tailnet look the same from here;
          check both on the serving side, or disconnect to work on this machine.
        </p>
      ) : null}
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Connect                                                                    */
/* -------------------------------------------------------------------------- */

function Connect(): ReactElement {
  const stored = readRemoteConfig();
  const [address, setAddress] = useState(stored?.origin ?? '');
  const [token, setToken] = useState(stored?.token ?? '');
  const [label, setLabel] = useState(stored?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = address.trim().length > 0 && token.trim().length > 0 && !busy;

  const connect = async (): Promise<void> => {
    const bridge = resolveBridge().bridge;
    if (bridge === null) return;
    setBusy(true);
    setError(null);

    // Main normalizes and validates the origin, and widens the CSP and the
    // request lockdown to exactly it. The reply is the normalized form, which
    // is what gets stored — the two records must name one origin.
    const granted = await call(() => bridge.remote.configure({ origin: address.trim() }));
    if (!granted.ok) {
      setBusy(false);
      setError(granted.error.message);
      return;
    }
    if (granted.value.origin === null) {
      setBusy(false);
      setError('That is not an address this window can be pointed at.');
      return;
    }

    const config: RemoteBridgeConfig = {
      origin: granted.value.origin,
      token: token.trim(),
      ...(label.trim().length > 0 ? { label: label.trim() } : {}),
      active: true,
    };
    writeRemoteConfig(config);
    // See the file comment: the walls only open for a new document, so the
    // address is proven by arriving, not before leaving.
    globalThis.location.reload();
  };

  return (
    <>
      <SettingsGroup label="Connect to a machine">
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink">Address</span>
            <span className="text-2xs leading-relaxed text-ink-faint">
              The serving Artemis's origin over your tailnet — for a headless server,{' '}
              <span className="font-mono">http://your-machine.tailnet-name.ts.net:6472</span>.
            </span>
            <Input
              value={address}
              placeholder="http://kronos.tailnet-name.ts.net:6472"
              aria-label="Remote address"
              className="font-mono text-xs"
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink">Connection token</span>
            <span className="text-2xs leading-relaxed text-ink-faint">
              Minted on the serving machine —{' '}
              <span className="font-mono">artemis-server connection create</span>, or its own
              Settings → Server. The token decides which accounts you see and where runs work.
            </span>
            <Input
              value={token}
              type="password"
              placeholder="Paste the token"
              aria-label="Connection token"
              className="font-mono text-xs"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink">Name (optional)</span>
            <Input
              value={label}
              placeholder="Kronos"
              aria-label="Remote machine name"
              className="text-xs"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {error === null ? null : (
            <p className="text-2xs leading-relaxed text-destructive">{error}</p>
          )}
          <div>
            <Button size="sm" disabled={!ready} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect — reloads this window'}
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup label="What changes">
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          This window becomes a view of the other machine: its conversations, its live runs, its
          shells. Your own profiles, terminals and files stay untouched underneath and come back
          when you disconnect. What cannot cross the wire — this machine's browser dock, native
          dialogs, the serving machine's files — says so instead of pretending.
        </p>
      </SettingsGroup>
    </>
  );
}
