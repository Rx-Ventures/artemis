/**
 * The dock: a tab strip, and whatever is under the tab in front.
 * ============================================================================
 *
 *     ╭─────────────────────────────────────────────╮
 *     │ ◱ sales.html ✕ │ ▸ zsh ✕ │ ▸ pnpm ✕ │ +     │  ← the strip
 *     ├─────────────────────────────────────────────┤
 *     │                                             │
 *     │   ~/libra ❯ pnpm dev                        │
 *     │   ▸ ready in 412ms                          │
 *     ╰─────────────────────────────────────────────╯
 *
 * Two unlike things share this rail — a file the agent wrote, and a shell the
 * user asked for — and `state/dock.ts` explains why that is one surface rather
 * than two. This is the drawing half of it.
 *
 * ## The strip is hand-rolled, and `ui/tabs.tsx` is right there
 *
 * shadcn's `Tabs` wraps Radix, which gives correct roving focus and correct
 * `aria-controls` wiring for free — and has no notion of a tab that can be
 * closed. The ✕ is not decoration here; it is the control the whole feature was
 * asked for, and putting an interactive element inside a Radix `TabsTrigger`
 * means a button inside a button: invalid markup, and a click target that
 * activates the tab on its way to closing it.
 *
 * So the roles are written out by hand — `tablist`, `tab`, `tabpanel`,
 * `aria-selected`, arrow-key navigation — and the ✕ is a sibling of the tab's
 * label rather than a child of the tab. That is the same trade the sidebar's
 * resize handle makes, and for the same reason: the library is not wrong, it is
 * solving a different problem.
 *
 * ## Chrome's rules, because they are the ones people have learned
 *
 * The ✕ shows on the active tab and on hover, never on all of them at once — a
 * strip of four terminals with four ✕s reads as a warning rather than as tabs.
 * Middle-click closes, because it does everywhere else. And the strip never
 * reorders itself: see {@link visibleTabs}.
 *
 * ## Every terminal stays mounted
 *
 * The panel below renders **all** visible terminals and hides the inactive ones
 * with `hidden`, rather than rendering only the active one. That is not a
 * performance choice — it is what keeps `TerminalView`'s attach/detach cycle
 * from running on every tab click, which would move the live element back to the
 * parking lot and refit it twice per switch. The preview is the opposite: it is
 * cheap to rebuild and expensive to keep, since a hidden `<iframe>` goes on
 * running whatever script it was given.
 */

import { useCallback, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { FileTextIcon, PlusIcon, SquareArrowOutUpRightIcon, TerminalIcon, XIcon } from 'lucide-react';

import {
  closePreview,
  closeTerminal,
  focusDockTab,
  openTerminal,
  sameTab,
  tabKey,
  useApp,
  type DockTab,
  type TerminalRecord,
} from '../state/store';
import { PreviewPane } from './PreviewPane';
import { TerminalView } from './TerminalView';
import { IconButton } from './disabled-reason';
import { cn } from '@/lib/utils';

export function DockPane(): ReactElement | null {
  const tabs = useApp((s) => s.visibleDockTabs);
  const active = useApp((s) => s.activeDockTab);
  if (tabs.length === 0) return null;

  return (
    <section aria-label="Dock" className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel/40">
      <DockStrip tabs={tabs} active={active} />
      <DockBody tabs={tabs} active={active} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

function DockStrip({
  tabs,
  active,
}: {
  readonly tabs: readonly DockTab[];
  readonly active: DockTab | null;
}): ReactElement {
  const strip = useRef<HTMLDivElement>(null);

  /*
   * Left/right move between tabs, Home/End jump to the ends — what a `tablist`
   * is expected to do, and what Radix would have given us. Focus is moved as
   * well as selection, because a roving tabindex that selects without focusing
   * strands the keyboard on the tab that has gone quiet.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();

      const at = tabs.findIndex((tab) => sameTab(tab, active));
      const last = tabs.length - 1;
      const to =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : event.key === 'ArrowLeft'
              ? Math.max(0, at - 1)
              : Math.min(last, at + 1);

      const next = tabs[to];
      if (next === undefined) return;
      focusDockTab(next);
      strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
    },
    [tabs, active],
  );

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Dock tabs"
      onKeyDown={onKeyDown}
      // Same height and border as a pane's caption, so the two read as one row
      // rather than as two applications side by side — the rule `PreviewPane`
      // set when it was the only thing in this rail.
      className="flex h-7 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line pr-1"
    >
      {tabs.map((tab) => (
        <DockTabButton key={tabKey(tab)} tab={tab} active={sameTab(tab, active)} />
      ))}
      <IconButton
        label="Open another terminal"
        size="icon-xs"
        onClick={() => void openTerminal()}
        className="my-0.5 ml-0.5 shrink-0 self-center text-ink-faint"
      >
        <PlusIcon />
      </IconButton>
    </div>
  );
}

function DockTabButton({
  tab,
  active,
}: {
  readonly tab: DockTab;
  readonly active: boolean;
}): ReactElement | null {
  return tab.kind === 'preview' ? (
    <PreviewTabButton active={active} />
  ) : (
    <TerminalTabButton id={tab.id} active={active} />
  );
}

/**
 * The shared shell of a tab: the button, the ✕, and Chrome's hover rules.
 *
 * A `group` so the ✕ can appear on hover of the whole tab rather than only on
 * hover of itself — a two-pixel target that has to be hovered before it is
 * visible is not a target.
 */
function TabShell({
  active,
  label,
  title,
  icon,
  onSelect,
  onClose,
  closeLabel,
  muted,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly title: string;
  readonly icon: ReactElement;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly muted?: boolean;
}): ReactElement {
  return (
    <div
      className={cn(
        'group flex min-w-0 shrink items-center gap-1.5 border-r border-line px-2 text-2xs',
        active ? 'bg-raised/60 text-ink' : 'text-ink-faint hover:bg-raised/30',
      )}
      // Middle-click closes, as it does on every other tab strip. On `auxiliary`
      // rather than `click` because a middle button never produces a `click`.
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // Roving tabindex: one stop for the whole strip, arrows move within it.
        tabIndex={active ? 0 : -1}
        title={title}
        onClick={onSelect}
        className="flex min-w-0 items-center gap-1.5 py-1 outline-none"
      >
        {icon}
        <span className={cn('min-w-0 max-w-40 truncate', muted === true && 'line-through')}>
          {label}
        </span>
      </button>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
        className={cn(
          'grid size-3.5 shrink-0 place-items-center rounded-xs text-ink-faint transition-opacity hover:bg-line-strong/60 hover:text-ink',
          // Chrome's rule: the active tab always offers its ✕, the others offer
          // it on hover. Kept focusable throughout — `opacity-0` hides it from
          // the eye, and `focus-visible` brings it back for the keyboard.
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <XIcon className="size-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function PreviewTabButton({ active }: { readonly active: boolean }): ReactElement | null {
  const preview = useApp((s) => s.preview);
  if (preview === null) return null;

  return (
    <TabShell
      active={active}
      label={preview.title}
      title={preview.path}
      // The glyph says which of the two this is, which is also the difference
      // between what will and will not run. Kept from `PreviewPane`'s old header.
      icon={
        preview.kind === 'frame' ? (
          <SquareArrowOutUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <FileTextIcon className="size-3 shrink-0" aria-hidden="true" />
        )
      }
      onSelect={() => focusDockTab({ kind: 'preview' })}
      onClose={closePreview}
      closeLabel={`Close ${preview.title}`}
    />
  );
}

function TerminalTabButton({
  id,
  active,
}: {
  readonly id: string;
  readonly active: boolean;
}): ReactElement | null {
  const record = useApp((s) => s.terminals.find((terminal) => terminal.info.id === id));
  if (record === undefined) return null;

  return (
    <TabShell
      active={active}
      label={record.title}
      title={`${record.info.shell} · ${record.info.cwd}`}
      icon={<TerminalIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'terminal', id })}
      onClose={() => closeTerminal(id)}
      closeLabel={`Close ${record.title}`}
      // A shell that has ended keeps its tab so its last words stay readable —
      // struck through, so it is plain that nothing is listening any more.
      muted={record.exited}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The body                                                                   */
/* -------------------------------------------------------------------------- */

function DockBody({
  tabs,
  active,
}: {
  readonly tabs: readonly DockTab[];
  readonly active: DockTab | null;
}): ReactElement {
  const terminals = useApp((s) => s.terminals);
  const showPreview = active?.kind === 'preview';

  return (
    <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showPreview ? <PreviewPane /> : null}
      {tabs.map((tab) => {
        if (tab.kind !== 'terminal') return null;
        const record = terminals.find((one) => one.info.id === tab.id);
        if (record === undefined) return null;
        const shown = active?.kind === 'terminal' && active.id === tab.id;
        return (
          <div
            key={tab.id}
            // `hidden` rather than unmounting: see the file header. An inactive
            // terminal keeps its element in this slot and simply stops being
            // painted, so switching tabs never re-parents a live xterm.
            hidden={!shown}
            className={cn('min-h-0 min-w-0 flex-1 flex-col', shown ? 'flex' : 'hidden')}
          >
            <TerminalView id={record.info.id} />
          </div>
        );
      })}
    </div>
  );
}
