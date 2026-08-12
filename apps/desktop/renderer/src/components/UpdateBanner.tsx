/**
 * The update banner — a strip under the header, shown only while the sidebar is
 * hidden.
 *
 * ## Why it is the fallback rather than the surface
 *
 * The update lives at the foot of the sidebar now, as its own floating card —
 * see `UpdateCard` for why that is the better home. But `Sidebar` renders
 * `null` when collapsed, not a rail and not a sliver, and an update that is
 * invisible because a pane is hidden is an update nobody installs. So this
 * strip stands in, and `App` mounts exactly one of the two. Same state, same
 * actions, one of them on screen at a time.
 *
 * ## Why it is not part of `ErrorSurface`
 *
 * The rows in `ErrorSurface` describe this *window's* failures, live in the
 * store, and stack per incident. An update is none of that: it is a fact about
 * the installation, there is at most one, and every window shows the same one.
 * So the banner spans the full window width the way the header does, and reads
 * the updater directly rather than through the store — see `useUpdateState`.
 *
 * ## What each phase renders
 *
 *  - `idle`       → nothing.
 *  - `available`  → the offer: version, an install action, a dismiss.
 *  - `working`    → a spinner and "keep the app open". No actions; there is
 *                   nothing to decide and nothing safely cancellable.
 *  - `ready`      → the installed update, waiting on the one decision that is
 *                   the user's alone: restart now, or keep working and pick it
 *                   up on the next launch. Nothing here happens on a timer.
 *  - `restarting` → a spinner, one line, gone in a moment.
 *  - `error`      → what happened, the manual path when main supplied one,
 *                   and a dismiss that silences this version.
 *
 * Dismissal names the version — see {@link UpdatesDismissRequest} — so a
 * banner racing a fresh offer can only ever silence the version it showed.
 */

import type { ReactElement } from 'react';
import {
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';

import {
  dismissUpdate,
  installUpdate,
  restartForUpdate,
  updaterChannels,
  useUpdateState,
} from '../hooks/useUpdateState';
import { IconButton } from './disabled-reason';

export function UpdateBanner(): ReactElement | null {
  const state = useUpdateState();

  if (state.phase === 'idle') return null;

  const version = state.version ?? '';

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1.5 font-mono text-2xs leading-snug text-ink"
    >
      {state.phase === 'error' ? (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-signal" />
      ) : state.phase === 'available' ? (
        <DownloadIcon aria-hidden className="size-3.5 shrink-0 text-lunar" />
      ) : state.phase === 'ready' ? (
        <RefreshCwIcon aria-hidden className="size-3.5 shrink-0 text-lunar" />
      ) : (
        <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin text-lunar" />
      )}

      <span className="min-w-0 flex-1 truncate">
        {state.phase === 'available' && <>Artemis {version} is available.</>}
        {state.phase === 'working' && <>Updating to {version}… keep the app open.</>}
        {state.phase === 'ready' && (
          <>Artemis {version} is installed — restart when you're ready.</>
        )}
        {state.phase === 'restarting' && <>Restarting into {version}…</>}
        {state.phase === 'error' && (state.message ?? 'The update could not be installed.')}
      </span>

      {state.phase === 'available' && (
        <button
          type="button"
          className="shrink-0 rounded-sm px-1.5 py-0.5 font-medium text-lunar hover:bg-lunar/10"
          onClick={installUpdate}
        >
          Update now
        </button>
      )}

      {state.phase === 'ready' && (
        <button
          type="button"
          className="shrink-0 rounded-sm px-1.5 py-0.5 font-medium text-lunar hover:bg-lunar/10"
          onClick={restartForUpdate}
        >
          Restart now
        </button>
      )}

      {state.phase === 'error' && state.releaseUrl !== null && (
        // A plain anchor: the window-open guard in `main/security.ts` routes
        // external URLs to the system browser and refuses to navigate this
        // window, so this is already the safe way out.
        <a
          href={state.releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-sm px-1.5 py-0.5 font-medium text-lunar hover:bg-lunar/10"
        >
          Open releases page
        </a>
      )}

      {(state.phase === 'available' || state.phase === 'error') && updaterChannels() !== null && (
        <IconButton
          label="Dismiss"
          size="icon-xs"
          className="shrink-0 text-current"
          onClick={() => dismissUpdate(version)}
        >
          <XIcon />
        </IconButton>
      )}
    </div>
  );
}
