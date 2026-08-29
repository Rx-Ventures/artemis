/**
 * The remote-bridge connection: where it is kept, and why there.
 * ============================================================================
 *
 * Entering remote mode is decided by `resolveBridge()`, which runs
 * synchronously at module scope — before any store exists, before any IPC
 * round-trip can resolve. The connection therefore has to be readable in the
 * same tick, which is `localStorage`: the same store the theme boot script
 * reads for the same reason, and the store the prefs blob itself falls back
 * to in a window with no bridge.
 *
 * The token lives here too, deliberately. It is the same class of credential
 * as the server connections `ServerState` carries into every renderer on
 * purpose: minted by an Artemis, unlocking exactly one port behind the user's
 * own tailnet, revocable with one click on the serving machine. The *origin*
 * additionally lives with main (`main/remoteAccess.ts`), because main owns
 * the CSP; this file's copy is the one the bridge dials and the one the
 * Settings section edits — if the two disagree, every remote fetch fails
 * closed with a blocked request, and reconnecting realigns them.
 *
 * `active` is what separates "configured" from "engaged": leaving remote mode
 * keeps the address and token for the next visit, and only the flag flips.
 * Both transitions take a reload — the bridge binding is resolved once per
 * window on purpose, and swapping a live window's entire world out from under
 * its store would be a second, worse implementation of reload.
 */

const REMOTE_CONFIG_KEY = 'artemis.remote.v1';

export interface RemoteBridgeConfig {
  /** `http(s)://host:port`, as main normalized it. */
  readonly origin: string;
  /** The connection token, sent as `Authorization: Bearer` and never in a URL. */
  readonly token: string;
  /** What the user called the machine, for the header chip. */
  readonly label?: string;
  /** True while this window should boot into remote mode. */
  readonly active: boolean;
}

/** The stored connection, or null when none has been configured. */
export function readRemoteConfig(): RemoteBridgeConfig | null {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(REMOTE_CONFIG_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteBridgeConfig>;
    if (typeof parsed.origin !== 'string' || parsed.origin === '') return null;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    return {
      origin: parsed.origin,
      token: parsed.token,
      ...(typeof parsed.label === 'string' && parsed.label !== '' ? { label: parsed.label } : {}),
      active: parsed.active === true,
    };
  } catch {
    return null;
  }
}

/** Store the connection, or clear it entirely with `null`. */
export function writeRemoteConfig(config: RemoteBridgeConfig | null): void {
  try {
    if (config === null) globalThis.localStorage?.removeItem(REMOTE_CONFIG_KEY);
    else globalThis.localStorage?.setItem(REMOTE_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // A full quota loses a convenience, not a capability: the user can
    // re-enter the address. Nothing to say that a failed connect won't.
  }
}

/** One line naming the machine, for chrome that has a few centimetres. */
export function describeRemote(config: RemoteBridgeConfig): string {
  if (config.label !== undefined) return config.label;
  try {
    return new URL(config.origin).host;
  } catch {
    return config.origin;
  }
}
