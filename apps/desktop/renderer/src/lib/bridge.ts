/**
 * Access to `window.artemis`.
 *
 * Everything the renderer can do to the outside world goes through this
 * module. There is no `require`, no `ipcRenderer`, no `process` — if a
 * capability is not on `ArtemisBridge`, the renderer does not have it, and the
 * fix is a new IPC channel rather than a tsconfig edit.
 */

import type { IpcResult, ArtemisBridge } from '@rx-artemis/protocol';
import { createMockBridge } from './mockBridge';
import { createRemoteBridge } from './remoteBridge';
import { readRemoteConfig } from './remoteConfig';

export type BridgeMode =
  /** The preload script ran and `window.artemis` is real. */
  | 'preload'
  /**
   * The user connected this window to another machine's Artemis (ADR 0004):
   * the same interface, served over HTTP plus the event stream, so the whole
   * existing UI draws the remote machine. Entered and left by a reload — see
   * `remoteConfig.ts` for why the binding is not swapped live.
   */
  | 'remote'
  /** Dev only: no preload, so a scripted fake is standing in. */
  | 'mock'
  /** Nothing to talk to. The app renders a dead-end screen. */
  | 'unavailable';

export interface BridgeBinding {
  readonly mode: BridgeMode;
  readonly bridge: ArtemisBridge | null;
}

let binding: BridgeBinding | null = null;

/** Resolve (once) how this renderer is talking to the main process. */
export function resolveBridge(): BridgeBinding {
  if (binding) return binding;

  const injected = typeof window === 'undefined' ? undefined : window.artemis;
  const remote = readRemoteConfig();
  if (remote?.active === true && (injected !== undefined || import.meta.env.DEV)) {
    // Before the plain preload branch, because that is what "connected" means:
    // this window's world is the remote machine's. The local bridge still
    // rides along for what stays local — window chrome, updates, the prefs
    // file — and for the way back out.
    binding = { mode: 'remote', bridge: createRemoteBridge(remote, injected ?? null) };
  } else if (injected) {
    binding = { mode: 'preload', bridge: injected };
  } else if (import.meta.env.DEV) {
    binding = { mode: 'mock', bridge: createMockBridge() };
  } else {
    binding = { mode: 'unavailable', bridge: null };
  }
  return binding;
}

/**
 * Does this window have real native chrome behind it?
 *
 * The header's traffic-light gutter and window controls used to key on
 * `mode === 'preload'`, which was two facts fused: "the UI is drawn locally"
 * and "an Electron window is hosting it". Remote mode splits them — the
 * conversation lives elsewhere while the window is exactly as native as it
 * ever was — so the chrome question is asked of the *host*, not the mode.
 */
export function hasNativeWindowChrome(): boolean {
  const { mode } = resolveBridge();
  if (mode === 'preload') return true;
  return mode === 'remote' && typeof window !== 'undefined' && window.artemis !== undefined;
}

/**
 * Run a bridge call, turning a rejected promise into an `IpcResult`.
 *
 * Handlers are contractually forbidden from rejecting, but a dead main process
 * or a torn-down window rejects anyway — and a renderer that lets that escape
 * as an unhandled promise leaves the UI wedged in a `starting` state.
 */
export async function call<T>(operation: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await operation();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'transport',
        message: cause instanceof Error ? cause.message : 'The main process did not respond.',
        retryable: true,
      },
    };
  }
}
