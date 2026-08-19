/**
 * Appearance.
 * ============================================================================
 *
 * A small pane, on purpose — and notably it is not where the theme lives. That
 * control is in the window header next to the settings button (see
 * `ThemeToggle`), because the palette is the one appearance setting whose whole
 * effect is the window itself: everything it changes is already on screen, and
 * putting it behind this dialog would mean covering it up to reach it.
 *
 * Text size is the one that looks like the same kind of claim and is not, so it
 * is worth being precise about what became settable. The type *scale* is still
 * architecture: 11 / 12 / 13 / 14 / 16 / 20 and the ratios between them are
 * fixed, and nothing here can put the transcript at 13 while the chrome labels
 * stay at 11. What the user moves is a single multiplier over the whole scale —
 * the design system's proportions, rendered larger or smaller. That is why it
 * can be offered honestly, and why it is one number rather than a font panel.
 *
 * The rest is genuinely a matter of taste and genuinely wired: how wide the
 * transcript column may grow, whether the model's reasoning is in the thread or
 * folded into the work it belongs to, how much of the block at the end of a run
 * it keeps, whether the sidebar is showing, and which folders the menu above the
 * composer offers. All are persisted and all take effect the moment they are
 * set.
 *
 * The thinking switch is the largest of those and the one that had to earn the
 * word "appearance", because it moves rows rather than restyling them: the
 * transcript folds reasoning into the activity marker on the argument that it is
 * context for the answer rather than the answer, and this is where a reader says
 * that is not their argument. It is still appearance and not behaviour — nothing
 * about the run changes, the blocks were always there — so it belongs here
 * rather than beside the effort picker, which is the control that decides
 * whether there is any reasoning to draw.
 *
 * The folder list is the one entry here that is not a preference but a *record*
 * — the app writes it as you work — which is exactly why it needs a pane: it is
 * the only place a folder can be taken back out. See `RecentFolders` below.
 *
 * That last part is the rule this file is written to. Every control below
 * writes to a store action that something actually reads. A "reduced motion" or
 * "compact density" switch would be easy to add and would silently do nothing,
 * which is worse than not offering it — the user changes it, sees no
 * difference, and stops trusting the rest of the pane. When those become real
 * settings they belong here; until then the note at the foot says plainly that
 * they are not settings rather than leaving a suspicious gap.
 *
 * The word-fade switch is the first of those to graduate. It is deliberately
 * *not* a general "reduce motion" — it governs one animation, the only one in
 * the app that runs continuously while you are reading, and says so. A switch
 * that promised to quiet everything would be back to promising more than it
 * delivers. (Genuine `prefers-reduced-motion` is honoured by the stylesheet and
 * is not a preference this pane owns.)
 */

import { useMemo, useState, type ReactElement } from 'react';
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react';

import { ReasonButton } from '../disabled-reason';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  RECENT_FOLDERS_LIMIT,
  SIDEBAR_DEFAULT_WIDTH,
  forgetFolders,
  setConversationWidth,
  setDockAutoOpen,
  setEscapeStopsRun,
  setFontSize,
  setRunSummary,
  setShowThinking,
  setSidebarCollapsed,
  setSidebarWidth,
  setStreamingWordFade,
  useApp,
  type ConversationWidth,
  type RunSummary,
} from '../../state/store';
import { inferHomeDirectory, lastSegment, shortenPath, sortFoldersByName } from '../../lib/paths';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';

/**
 * The three reading modes.
 *
 * Written as reading modes rather than as sizes because that is what the user
 * is choosing between: a measure tuned for prose, a measure that stops diffs
 * from wrapping, and "use the window". A pixel figure here would be a number
 * nobody can act on.
 */
const WIDTHS: readonly Choice<ConversationWidth>[] = [
  {
    id: 'comfortable',
    label: 'Comfortable',
    note: 'A narrow column, sized for reading. Long lines are the single thing that makes a long transcript tiring.',
  },
  {
    id: 'wide',
    label: 'Wide',
    note: 'Room for diffs, tables and tool output, which wrap badly in a reading column.',
  },
  {
    id: 'full',
    label: 'Full width',
    note: 'Use the whole window. Best on a narrow display, or when the window is already only half the screen.',
  },
];

/**
 * What each setting keeps of the block a run ends with.
 *
 * Every note says what still appears, not what disappears — the question a
 * user has here is "will I lose the error", and the answer is no in all three
 * cases. Trimming is described as trimming; nothing here is described as off.
 */
const RUN_SUMMARIES: readonly Choice<RunSummary>[] = [
  {
    id: 'always',
    label: 'After every run',
    note: 'Duration, turns, tokens and cost. Worth keeping while you are watching spend or comparing models.',
  },
  {
    id: 'failures',
    label: 'Only when a run is cut short',
    note: 'A clean run ends quietly. Errors, interruptions and hitting a turn or budget limit still report — each means the answer above is unfinished.',
  },
  {
    id: 'never',
    label: 'Never',
    note: 'No accounting at all. A failed run still shows its message and code, because this is the only place either appears.',
  },
];

/*
 * REMOVED: the "Plan meter" setting.
 *
 * It chose which single limit the status bar counted down — the 5-hour, the
 * weekly, or the fullest per-model window — and existed only because a bar that
 * width could carry one of them. The bar is three rings now and reports all
 * three at once, so the setting had nothing left to choose between: every
 * answer it offered is on screen. See `PlanUsageMeter`.
 *
 * A persisted `planMeterFocus` from an older build is simply ignored, the same
 * as any other key this pane no longer reads.
 */

/**
 * The text-size row.
 *
 * A stepper rather than a `ChoiceList`, which is the one place this pane breaks
 * its own habit. The other three settings are a short list of named modes whose
 * notes are the entire point — nobody knows what "wide" costs without the
 * sentence. Text size is a scalar with ten positions and no prose to attach:
 * rendering it as ten radio rows would be ten near-identical cards inventing
 * differences between 15px and 16px that do not exist.
 *
 * There is no preview swatch because the pane *is* the preview — the dialog is
 * laid out in the same rem the setting scales, so it resizes under the pointer
 * as the value changes. A sample line showing "the quick brown fox" at the new
 * size would be a smaller, worse copy of what the user is already looking at.
 *
 * Both buttons stay mounted at the bounds and explain themselves through
 * `ReasonButton`, per the rule in `disabled-reason.tsx`: a `+` that silently
 * stopped working at 20px reads as a bug, not as a limit.
 */
function TextSize(): ReactElement {
  const fontSize = useApp((s) => s.fontSize);

  return (
    <Item variant="outline" size="sm" className="items-start border-line bg-panel">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">
          Base text size
          <span className="font-mono text-2xs text-ink-muted">{fontSize}px</span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          Scales the whole window, not just the letters — row heights, padding and the sidebar move
          with it, so the transcript stays as dense as it looks now and only gets larger. Persisted,
          and applied before the first paint, so the app opens at the size you left it.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Smaller text"
          disabled={fontSize <= FONT_SIZE_MIN}
          disabledReason={`${FONT_SIZE_MIN}px is as small as the 11px chrome labels stay readable.`}
          onClick={() => setFontSize(fontSize - 1)}
        >
          <MinusIcon />
        </ReasonButton>
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Larger text"
          disabled={fontSize >= FONT_SIZE_MAX}
          disabledReason={`${FONT_SIZE_MAX}px is as large as the status line fits on a laptop display.`}
          onClick={() => setFontSize(fontSize + 1)}
        >
          <PlusIcon />
        </ReasonButton>
        {/* Named, not just "Reset": the sidebar row below has a reset of its
            own, and two buttons announcing themselves identically in one pane
            is exactly the ambiguity a screen-reader user cannot resolve. The
            visible label stays short; only the accessible name is qualified. */}
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Reset text size"
          disabled={fontSize === FONT_SIZE_DEFAULT}
          disabledReason="Already at the default size."
          onClick={() => setFontSize(FONT_SIZE_DEFAULT)}
        >
          Reset
        </ReasonButton>
      </ItemActions>
    </Item>
  );
}

/**
 * The folder menu's list, editable.
 * ============================================================================
 *
 * The list above the composer fills itself — every directory worked in goes into
 * it — which is what makes it useful and also what makes it need this pane. A
 * folder opened once by mistake, a client's repository that is no longer
 * anyone's business, a throwaway checkout: all of them sit in a menu the user
 * opens twenty times a day, and none of them can be got rid of from that menu.
 *
 * ## Why removal is offered twice
 *
 * The × on a row and the tick-boxes are the same operation and are both here on
 * purpose. Tidying up after a week of experiments means removing five folders at
 * once, and doing that through five separate row buttons — each one reflowing
 * the list under the cursor as it goes — is the interaction people misclick.
 * Wanting *one* gone, on the other hand, is the common case, and making that
 * cost a tick, a scroll to a button and a click would be worse than the problem.
 *
 * So: the × is the shortcut, the boxes are the batch, and both call
 * `forgetFolders`, which writes and persists once regardless of how many folders
 * it is given.
 *
 * ## No confirmation, deliberately
 *
 * Forgetting a folder destroys nothing — not the directory, not its sessions,
 * not the transcript. The folder comes back the next time it is opened. A
 * confirmation step here would teach the user that this dialog's buttons are
 * dangerous, which is a lesson worth saving for the ones that are.
 */
function RecentFolders(): ReactElement {
  const platform = useApp((s) => s.platform);
  const recentFolders = useApp((s) => s.recentFolders);
  /*
   * Selection is by path and is *derived* against the live list rather than
   * stored as truth. Folders leave this list while the pane is open — the ×
   * removes one, and the window itself keeps recording as sessions move — and a
   * tick left behind for a path that is gone would put a stale count on the
   * remove button.
   */
  const [ticked, setTicked] = useState<readonly string[]>([]);

  const folders = useMemo(() => sortFoldersByName(recentFolders), [recentFolders]);
  const home = useMemo(() => inferHomeDirectory(folders, platform), [folders, platform]);
  const selected = useMemo(() => folders.filter((f) => ticked.includes(f)), [folders, ticked]);

  const toggle = (path: string, on: boolean): void => {
    setTicked((current) =>
      on ? [...current.filter((f) => f !== path), path] : current.filter((f) => f !== path),
    );
  };

  const remove = (paths: readonly string[]): void => {
    forgetFolders(paths);
    setTicked((current) => current.filter((f) => !paths.includes(f)));
  };

  if (folders.length === 0) {
    return (
      <p className="text-2xs leading-relaxed text-ink-faint">
        No folders remembered yet. Every directory you work in is added here, up to{' '}
        {RECENT_FOLDERS_LIMIT} — after that the one you have not opened in the longest makes way.
      </p>
    );
  }

  return (
    <>
      <ItemGroup className="gap-2">
        {folders.map((folder) => {
          const name = lastSegment(folder);
          const checked = ticked.includes(folder);
          return (
            <Item
              key={folder}
              variant="outline"
              size="sm"
              className="items-center border-line bg-panel"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) => toggle(folder, next === true)}
                // The whole path, not the name. A column of unlabelled boxes is
                // unusable by ear, and two checkouts of one repository — the
                // case that put the path on the row in the first place — would
                // otherwise be two boxes announced identically.
                aria-label={`Select ${folder}`}
                className="shrink-0"
              />
              <ItemContent>
                <ItemTitle className="text-xs text-ink">{name}</ItemTitle>
                <ItemDescription
                  className="line-clamp-none font-mono text-2xs text-ink-faint"
                  title={folder}
                >
                  {shortenPath(folder, { home, platform, max: 44 })}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  // Same rule as the checkbox beside it: the path is what makes
                  // one row's remove button distinguishable from another's.
                  aria-label={`Forget ${folder}`}
                  title={`Forget ${name}`}
                  onClick={() => remove([folder])}
                >
                  <XIcon />
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>

      <div className="mt-1 flex items-center gap-2">
        <ReasonButton
          size="xs"
          variant="outline"
          disabled={selected.length === 0}
          disabledReason="Tick the folders you want removed first."
          onClick={() => remove(selected)}
        >
          {selected.length > 1 ? `Remove ${selected.length} folders` : 'Remove selected'}
        </ReasonButton>
        <ReasonButton
          size="xs"
          variant="ghost"
          disabled={selected.length === folders.length}
          disabledReason="Every folder is already ticked."
          onClick={() => setTicked(folders)}
        >
          Select all
        </ReasonButton>
        <span className="text-2xs text-ink-faint">
          Forgetting a folder leaves it, and its sessions, exactly where they are.
        </span>
      </div>
    </>
  );
}

export function AppearanceSection(): ReactElement {
  const width = useApp((s) => s.conversationWidth);
  const runSummary = useApp((s) => s.runSummary);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const wordFade = useApp((s) => s.streamingWordFade);
  const showThinking = useApp((s) => s.showThinking);
  const dockAutoOpen = useApp((s) => s.dockAutoOpen);
  const escapeStopsRun = useApp((s) => s.escapeStopsRun);

  return (
    <SettingsPane
      title="Appearance"
      description="How big the app is, how much room the conversation gets, whether you watch the model think, how much it reports when a run ends, whether the sidebar is in the way, whether the side pane may open itself, what Escape does, and which folders the composer offers."
    >
      <SettingsGroup label="Text size">
        <ItemGroup className="gap-2">
          <TextSize />
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Conversation width">
        <ChoiceList
          label="Conversation width"
          value={width}
          choices={WIDTHS}
          onChange={setConversationWidth}
        />
      </SettingsGroup>

      <SettingsGroup label="Thinking">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Show the model’s reasoning</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Reasoning lands in the conversation as it is written, in muted text beside a sage
                rule so it never reads as the answer. Off, it stays where it has always been —
                folded into the activity marker with the work it was reasoning about, one click
                away. Either way a single block can be collapsed on its own, and moving this
                rearranges the conversation already on screen rather than only the next one.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-show-thinking"
                aria-label="Show the model’s reasoning"
                checked={showThinking}
                onCheckedChange={setShowThinking}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
        <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
          {/* Said here rather than left to be discovered, because the switch is
              the obvious thing to blame for an empty transcript: it governs
              where thinking is drawn, and cannot conjure a block the provider
              never sent. */}
          Only shows what the provider sends. A model set to a low thinking effort, or one that
          encrypts its reasoning, has little or nothing to show — the effort is set beside the model
          in the status line.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Run summary">
        <ChoiceList
          label="Run summary"
          value={runSummary}
          choices={RUN_SUMMARIES}
          onChange={setRunSummary}
        />
      </SettingsGroup>

      <SettingsGroup label="Streaming text">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Fade in each word</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                An answer arrives in whatever chunk the provider sent in the last frame, which lands
                as a block. This fades those in a word at a time instead. It never paces behind the
                model — whatever is waiting is on screen within a tenth of a second — but if you
                read faster than it resolves, turn it off and text appears exactly as it arrives.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-streaming-word-fade"
                aria-label="Fade in each word"
                checked={wordFade}
                onCheckedChange={setStreamingWordFade}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Side pane">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Open on its own</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                The side pane opens itself when the agent produces something to look at: the first
                artifact of a conversation, delegated work, a page the agent is browsing. Turn this
                off and none of that appears without a click — an artifact waits behind its tile's
                Open button, delegated work behind the header's Delegated button, and anything that
                arrived unseen is revealed by turning this back on.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-dock-auto-open"
                aria-label="Open the side pane on its own"
                checked={dockAutoOpen}
                onCheckedChange={setDockAutoOpen}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Keyboard">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Escape stops the run</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Escape interrupts whatever the agent is doing. It is the fastest way to stop a run
                and, for the same reason, the easiest to hit by accident — reaching for it to
                dismiss something that is no longer on screen stops the work instead.
                <br />
                <br />
                Off, Escape still closes dialogs and the command palette, and still denies a
                permission the agent is waiting on. It simply stops short of stopping the run, which
                the composer&rsquo;s Stop button still does.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-escape-stops-run"
                aria-label="Escape stops the run"
                checked={escapeStopsRun}
                onCheckedChange={setEscapeStopsRun}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Recent folders">
        <RecentFolders />
      </SettingsGroup>

      <SettingsGroup label="Sidebar">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Hide the sidebar</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Persisted, so the app opens the way you left it. It stays hidden until you bring it
                back — nothing reopens it for you.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-sidebar-collapsed"
                aria-label="Hide the sidebar"
                checked={collapsed}
                onCheckedChange={setSidebarCollapsed}
              />
            </ItemActions>
          </Item>

          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">
                Width
                <span className="font-mono text-2xs text-ink-muted">{sidebarWidth}px</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                {/* No slider here on purpose: the sidebar is resized by dragging
                    its edge, which is both more direct and already implemented.
                    A second control for the same number would be a way to
                    disagree with the drag handle. This is the undo. */}
                Drag the sidebar’s edge to resize it. This is where you undo that.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ReasonButton
                size="xs"
                variant="outline"
                aria-label="Reset sidebar width"
                disabled={sidebarWidth === SIDEBAR_DEFAULT_WIDTH}
                disabledReason="Already at the default width."
                onClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              >
                Reset
              </ReasonButton>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <p className="text-2xs leading-relaxed text-ink-faint">
        The theme is not here — it is in the window header, next to the settings button, so you can
        see the app change as you pick. Density is not a setting at all: the transcript uses one
        spacing scale so that message boundaries stay readable at a glance, and text size moves that
        whole scale at once rather than loosening it. There is no global motion switch either — the
        only animations in the app are the ones that show something arriving, and the one that runs
        continuously is the switch above.
      </p>
    </SettingsPane>
  );
}
