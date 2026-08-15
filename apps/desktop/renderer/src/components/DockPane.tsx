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
 * Unlike things share this rail — a file the agent wrote, a shell the user asked
 * for, a page either of them opened — and `state/dock.ts` explains why that is
 * one surface rather than several. This is the drawing half of it.
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
 * ## Every terminal and every browser stays mounted
 *
 * The panel below renders **all** visible terminals and browsers and hides the
 * inactive ones, rather than rendering only the active one. That is not a
 * performance choice — it is what keeps `TerminalView`'s attach/detach cycle
 * from running on every tab click, which would move the live element back to the
 * parking lot and refit it twice per switch. The preview is the opposite: it is
 * cheap to rebuild and expensive to keep, since a hidden `<iframe>` goes on
 * running whatever script it was given.
 *
 * A browser is mounted for a sharper version of the same reason, and hidden a
 * *different* way. Its page is a native view composited above this document, so
 * `hidden` on the element would leave the page painted over an empty pane —
 * the hiding has to happen in the main process, which is why `BrowserPane`
 * takes `visible` rather than reading the active tab itself.
 */

import { useCallback, useRef, type KeyboardEvent, type ReactElement } from 'react';
import {
  BotIcon,
  FileCodeIcon,
  FileTextIcon,
  GlobeIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  TerminalIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import {
  agentViewIsLive,
  closeAgentTab,
  closeFile,
  closePreview,
  closeTasks,
  closeTerminal,
  closeBrowser,
  focusDockTab,
  liveTaskCount,
  openTerminal,
  taskCount,
  sameTab,
  tabKey,
  useApp,
  type DockTab,
  type TerminalRecord,
} from '../state/store';
import { AgentPane } from './AgentPane';
import { FileViewer } from './FileViewer';
import { PreviewPane } from './PreviewPane';
import { TasksPane } from './TasksPane';
import { TerminalView } from './TerminalView';
import { BrowserPane } from './BrowserPane';
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
      {/*
        Still one button, and still a terminal.

        This was briefly a menu when the rail grew a second kind of live thing,
        and a menu is the wrong shape for it: two items behind a click is more
        work than the one action it replaced, and `+` on a strip of tabs already
        means "another of these" everywhere else. The browser has its own
        control in the header beside the terminal's, which is where a reader
        looks for "open a thing" — see `AppHeader`.
      */}
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
  if (tab.kind === 'preview') return <PreviewTabButton active={active} />;
  if (tab.kind === 'file') return <FileTabButton active={active} />;
  if (tab.kind === 'terminal') return <TerminalTabButton id={tab.id} active={active} />;
  if (tab.kind === 'browser') return <BrowserTabButton id={tab.id} active={active} />;
  if (tab.kind === 'tasks') return <TasksTabButton paneId={tab.paneId} active={active} />;
  return <AgentTabButton paneId={tab.paneId} taskId={tab.taskId} active={active} />;
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
  /**
   * What the ✕ does — which is not the same thing on all three tabs. A preview's
   * destroys a snapshot, a terminal's kills a shell, and the delegated list's
   * closes a view of work that goes on running either way.
   */
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

/**
 * The file a link in the transcript opened.
 *
 * Titled with the file's own name and captioned with its path, which is the same
 * pairing the preview tab uses — a strip full of `index.ts` is what you get from
 * titling these with anything longer, and the path is one hover away.
 *
 * Its ✕ is the preview's, not the terminal's: it drops a snapshot the renderer
 * is holding, and the link that opened it is still in the transcript.
 */
function FileTabButton({ active }: { readonly active: boolean }): ReactElement | null {
  const file = useApp((s) => s.file);
  if (file === null) return null;

  return (
    <TabShell
      active={active}
      label={file.title}
      title={file.path}
      icon={<FileCodeIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'file' })}
      onClose={closeFile}
      closeLabel={`Close ${file.title}`}
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

/**
 * A page's tab.
 *
 * Labelled by the page's title, which main falls back to the host for — so a
 * tab says `example.com` while a document is loading and its own name once it
 * has one, which is what a browser does and what keeps two of these apart.
 *
 * The title is page-authored text. It is capped in `main/browser.ts` and
 * rendered here as text, never as markup.
 */
function BrowserTabButton({
  id,
  active,
}: {
  readonly id: string;
  readonly active: boolean;
}): ReactElement | null {
  const record = useApp((s) => s.browsers.find((browser) => browser.info.id === id));
  if (record === undefined) return null;

  const { title, url, loading } = record.info.state;
  const label = title.length > 0 ? title : 'New browser';

  return (
    <TabShell
      active={active}
      label={label}
      title={url.length > 0 ? url : 'No address yet'}
      icon={<GlobeIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'browser', id })}
      onClose={() => closeBrowser(id)}
      closeLabel={`Close ${label}`}
      // Dimmed while the page is on its way, which is the one piece of progress
      // this strip has room for — the address bar has the stop button.
      muted={loading}
    />
  );
}

/**
 * The one tab nobody opens, and the one whose ✕ costs nothing.
 *
 * Its label is the count, so the strip answers "is anything still running" while
 * the pane is shut — which is the question the transcript answered wrongly by
 * saying "delegated to 3 agents" in the past tense while they worked.
 *
 * The ✕ closes the view and leaves the work alone. That is worth saying plainly
 * because the two tabs to its left have taught the opposite: a preview's ✕
 * destroys the snapshot, a terminal's kills the shell. This pane owns nothing —
 * the rows live on the conversation, the subagents live in the provider — so
 * dismissing it is closer to collapsing a panel than to closing a document.
 * `closeTasks` writes down what was on screen so it stays shut; the next thing
 * delegated brings it back, the same way the first one did.
 */
function TasksTabButton({
  paneId,
  active,
}: {
  readonly paneId: string;
  readonly active: boolean;
}): ReactElement | null {
  // Two numbers rather than one object: a selector that allocates returns a new
  // identity every call, which zustand reads as a change and React resolves by
  // re-rendering for ever.
  const total = useApp((s) => taskCount(s, paneId));
  const live = useApp((s) => liveTaskCount(s, paneId));
  if (total === 0) return null;

  return (
    <TabShell
      active={active}
      label={live === 0 ? 'Delegated' : `${String(live)} running`}
      title={
        live === 0
          ? `${String(total)} finished task${total === 1 ? '' : 's'}`
          : `${String(live)} of ${String(total)} still running`
      }
      icon={<UsersIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'tasks', paneId })}
      onClose={() => closeTasks(paneId)}
      // "Hide" rather than "Close", because the ✕ beside it on a terminal ends a
      // process and this one ends nothing. The word is the only warning the user
      // gets before they click.
      closeLabel="Hide delegated work"
      // Nothing is running: the tab is a record rather than a readout, and it
      // reads as one.
      muted={live === 0}
    />
  );
}

/**
 * One agent's own conversation, opened from a row in the tab to its left.
 *
 * Named after the work rather than the agent type, because that is what the
 * user clicked: the row said "Audit scripts, CI, packaging" and the tab that
 * opens from it should say the same thing. The type — `Explore`, a workflow's
 * name — is in the row and in the transcript's own first turn.
 *
 * Its ✕ is the weakest in the strip: this tab owns nothing, not even a view of
 * something running. It is a read of a file, so closing it stops a poll and
 * nothing else. The agent keeps working, the row keeps its ⏹, and clicking the
 * row again reopens exactly this.
 */
function AgentTabButton({
  paneId,
  taskId,
  active,
}: {
  readonly paneId: string;
  readonly taskId: string;
  readonly active: boolean;
}): ReactElement | null {
  const key = `${paneId}:${taskId}`;
  const title = useApp((s) => s.agentViews.find((one) => one.key === key)?.title);
  const live = useApp((s) => agentViewIsLive(s, key));
  if (title === undefined) return null;

  return (
    <TabShell
      active={active}
      label={title}
      title={live ? `${title} — still running` : `${title} — finished`}
      icon={<BotIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'agent', paneId, taskId })}
      onClose={() => closeAgentTab(paneId, taskId)}
      closeLabel={`Close ${title}`}
      // Struck through once the agent has finished, the same way an exited
      // shell's tab is: the transcript is a record now rather than a readout.
      muted={!live}
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
  const file = useApp((s) => s.file);
  const showPreview = active?.kind === 'preview';

  return (
    <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showPreview ? <PreviewPane /> : null}
      {/*
       * Keyed by path, so following a second link scrolls the new file from its
       * own top rather than inheriting where the reader had got to in the last
       * one — and so the jump to a `:line` runs again for the new file.
       */}
      {active?.kind === 'file' ? <FileViewer key={file?.path ?? ''} /> : null}
      {active?.kind === 'tasks' ? <TasksPane paneId={active.paneId} /> : null}
      {/*
       * Only the active one, unlike the terminals below. An agent tab holds no
       * live element to re-parent — its transcript lives in the store, not in
       * the DOM — so unmounting costs a re-render and keeps the poll in the one
       * tab the user is actually reading.
       */}
      {active?.kind === 'agent' ? (
        <AgentPane key={tabKey(active)} viewKey={`${active.paneId}:${active.taskId}`} />
      ) : null}
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
      {/*
       * Mounted for every browser, like the terminals above, and for a stronger
       * version of the same reason. A terminal that unmounted would re-parent a
       * live xterm; a browser that unmounted would tell main to detach the view
       * and lose the rectangle, so the page would vanish on every tab switch
       * and come back a frame late at the wrong size.
       *
       * `visible` is what does the hiding, and it goes to main rather than to
       * CSS: a native view is composited above this document, so `hidden` on
       * this element would leave the page painted over an empty pane.
       */}
      {tabs.map((tab) => {
        if (tab.kind !== 'browser') return null;
        const shown = active?.kind === 'browser' && active.id === tab.id;
        return (
          <div
            key={tab.id}
            className={cn('min-h-0 min-w-0 flex-1 flex-col', shown ? 'flex' : 'hidden')}
          >
            <BrowserPane id={tab.id} visible={shown} />
          </div>
        );
      })}
    </div>
  );
}
