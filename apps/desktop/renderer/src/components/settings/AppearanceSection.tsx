/**
 * Appearance.
 * ============================================================================
 *
 * The smallest pane, on purpose. Artemis is a dark-only app with one palette and
 * one type scale — those are architecture, not preferences, and a settings pane
 * that offered to change them would be promising something the design system
 * does not support.
 *
 * What is left is genuinely a matter of taste and genuinely wired: how wide the
 * transcript column may grow, how much of the block at the end of a run it
 * keeps, whether the sidebar is showing, and which folders the menu above the
 * composer offers. All are persisted and all take effect the moment they are
 * set.
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
 */

import { useMemo, useState, type ReactElement } from 'react';
import { XIcon } from 'lucide-react';

import { ReasonButton } from '../disabled-reason';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  RECENT_FOLDERS_LIMIT,
  SIDEBAR_DEFAULT_WIDTH,
  forgetFolders,
  setConversationWidth,
  setPlanMeterFocus,
  setRunSummary,
  setSidebarCollapsed,
  setSidebarWidth,
  useApp,
  type ConversationWidth,
  type PlanMeterFocus,
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

/**
 * Which limit the status-bar meter counts down.
 *
 * One window, not all of them: the meter is a single bar in a status line, and
 * the version that showed "whichever is closest to full" never understated the
 * pressure but also never answered a specific question — the number could be
 * any window at any moment, so it could not be watched.
 *
 * The trade is stated in the last note rather than hidden: a comfortable
 * focused window says nothing about the others.
 */
const METERS: readonly Choice<PlanMeterFocus>[] = [
  {
    id: 'five_hour',
    label: '5-hour limit',
    note: 'The one that interrupts work. A weekly limit is something you budget around over days; this is the one that stops you mid-task.',
  },
  {
    id: 'seven_day',
    label: 'Weekly limit',
    note: 'The whole plan’s 7-day window. Worth watching in the back half of a heavy week.',
  },
  {
    id: 'model',
    label: 'Per-model weekly',
    note: 'The weekly window for the model closest to full — Fable and Opus are metered separately from the plan total on some accounts. Shows a dash if your plan has no per-model limits.',
  },
];

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
  const planMeterFocus = useApp((s) => s.planMeterFocus);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const sidebarWidth = useApp((s) => s.sidebarWidth);

  return (
    <SettingsPane
      title="Appearance"
      description="How much room the conversation gets, how much it reports when a run ends, whether the sidebar is in the way, and which folders the composer offers."
    >
      <SettingsGroup label="Conversation width">
        <ChoiceList
          label="Conversation width"
          value={width}
          choices={WIDTHS}
          onChange={setConversationWidth}
        />
      </SettingsGroup>

      <SettingsGroup label="Run summary">
        <ChoiceList
          label="Run summary"
          value={runSummary}
          choices={RUN_SUMMARIES}
          onChange={setRunSummary}
        />
      </SettingsGroup>

      <SettingsGroup label="Plan meter">
        <ChoiceList
          label="Plan meter"
          value={planMeterFocus}
          choices={METERS}
          onChange={setPlanMeterFocus}
        />
        <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
          The meter reports this one window. Being comfortable here does not mean the others are —
          click it for every limit your plan reports.
        </p>
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
        Theme, density and motion are not settings. Artemis is dark-only by design, the transcript
        uses one spacing scale so that message boundaries stay readable at a glance, and the only
        animations in the app are the ones that show something arriving.
      </p>
    </SettingsPane>
  );
}
