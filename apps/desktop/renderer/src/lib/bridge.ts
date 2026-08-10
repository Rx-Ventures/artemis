/**
 * Access to `window.libra`.
 *
 * Everything the renderer can do to the outside world goes through this
 * module. There is no `require`, no `ipcRenderer`, no `process` — if a
 * capability is not on `LibraBridge`, the renderer does not have it, and the
 * fix is a new IPC channel rather than a tsconfig edit.
 */

import type { IpcResult, LibraBridge } from '@libra/protocol';
import { createMockBridge } from './mockBridge';

export type BridgeMode =
  /** The preload script ran and `window.libra` is real. */
  | 'preload'
  /** Dev only: no preload, so a scripted fake is standing in. */
  | 'mock'
  /** Nothing to talk to. The app renders a dead-end screen. */
  | 'unavailable';

export interface BridgeBinding {
  readonly mode: BridgeMode;
  readonly bridge: LibraBridge | null;
}

let binding: BridgeBinding | null = null;

/** Resolve (once) how this renderer is talking to the main process. */
export function resolveBridge(): BridgeBinding {
  if (binding) return binding;

  const injected = typeof window === 'undefined' ? undefined : window.libra;
  if (injected) {
    binding = { mode: 'preload', bridge: injected };
  } else if (import.meta.env.DEV) {
    binding = { mode: 'mock', bridge: createMockBridge() };
  } else {
    binding = { mode: 'unavailable', bridge: null };
  }
  return binding;
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
