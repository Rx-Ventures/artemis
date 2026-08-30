/**
 * Appearance.
 * ============================================================================
 *
 * A small pane, on purpose, and smaller than it used to be: the run summary
 * and the handover rules moved to Runs (they shape what a run *reports and
 * does*, not how the window looks) and the recent-folders list moved to This
 * machine (it is a record the installation keeps, not a taste anyone holds).
 * What is left is genuinely how the app looks and reads.
 *
 * Text size is the one that looks like a bigger claim than it is, so it is
 * worth being precise about what became settable. The type *scale* is still
 * architecture: 11 / 12 / 13 / 14 / 16 / 20 and the ratios between them are
 * fixed, and nothing here can put the transcript at 13 while the chrome labels
 * stay at 11. What the user moves is a single multiplier over the whole scale —
 * the design system's proportions, rendered larger or smaller. That is why it
 * can be offered honestly, and why it is one number rather than a font panel.
 *
 * The rest is a matter of taste and genuinely wired: the theme, how wide the
 * transcript column may grow, whether the model's reasoning is in the thread or
 * folded into the work it belongs to, whether the sidebar is showing. All are
 * persisted and all take effect the moment they are set.
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
 * The rule this file is written to: every control below writes to a store
 * action that something actually reads. A "reduced motion" or "compact
 * density" switch would be easy to add and would silently do nothing, which is
 * worse than not offering it — the user changes it, sees no difference, and
 * stops trusting the rest of the pane. When those become real settings they
 * belong here; until then the note at the foot says plainly that they are not
 * settings rather than leaving a suspicious gap.
 *
 * The word-fade switch is the first of those to graduate. It is deliberately
 * *not* a general "reduce motion" — it governs one animation, the only one in
 * the app that runs continuously while you are reading, and says so. A switch
 * that promised to quiet everything would be back to promising more than it
 * delivers. (Genuine `prefers-reduced-motion` is honoured by the stylesheet and
 * is not a preference this pane owns.)
 */

import { type ReactElement } from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';

import { ReasonButton } from '../disabled-reason';
import { ThemeToggle } from '../ThemeToggle';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIDEBAR_DEFAULT_WIDTH,
  setConversationWidth,
  setDockAutoOpen,
  setEscapeStopsRun,
  setFontSize,
  setShowThinking,
  setSidebarCollapsed,
  setSidebarWidth,
  setStreamingWordFade,
  useApp,
  type ConversationWidth,
} from '../../state/store';
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
    <Item size="sm" className="items-start">
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

export function AppearanceSection(): ReactElement {
  const width = useApp((s) => s.conversationWidth);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const wordFade = useApp((s) => s.streamingWordFade);
  const showThinking = useApp((s) => s.showThinking);
  const dockAutoOpen = useApp((s) => s.dockAutoOpen);
  const escapeStopsRun = useApp((s) => s.escapeStopsRun);

  return (
    <SettingsPane
      title="Appearance"
      description="How the app looks and reads: its palette, how big it is, how much room the conversation gets, whether you watch the model think, whether the sidebar is in the way, whether the side pane may open itself, and what Escape does."
    >
      <SettingsGroup label="Theme">
        <ItemGroup className="gap-0 divide-y divide-hairline">
          {/*
            The second door to a control that also lives in the window header,
            and the duplication is deliberate — the same judgment the header
            makes for its own doubled doors (its rail toggles beside the strip
            they mirror). The header is the *right* home: the palette's whole
            effect is the window you are looking at, and a modal covers what it
            changes. But "theme" is also the first word anyone types into a
            settings surface, and a pane called Appearance that answered "not
            here" to it would be correct and unhelpful. One control, two doors,
            one store value — `ThemeToggle` reads and writes the same `theme`
            either way, so the two can never disagree.
          */}
          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Theme</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                System follows the OS and keeps following it after you walk away; light and dark
                stay put. The same control sits in the window header, where you can watch the app
                change as you pick — this row exists so the answer is also where you would look
                for it.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ThemeToggle />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Text size">
        <ItemGroup className="gap-0 divide-y divide-hairline">
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
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Show the model’s reasoning</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Reasoning lands in the conversation as it is written, in muted text beside a sage
                rule so it never reads as the answer. Off, each block collapses to a single line
                where it happened — still in the thread, one click from the text. Either way a
                single block can be collapsed on its own, and moving this opens or closes the
                conversation already on screen rather than only the next one.
                <br />
                <br />
                <span className="text-ink-muted">
                  Some models do not return their reasoning at all.
                </span>{' '}
                The provider keeps the block and withholds its text, and there is nothing for this
                switch to show — the conversation looks the same on and off. That is the provider’s
                choice about that model, not a setting here, and it can differ between two models
                on one account.
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
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          {/* Said here rather than left to be discovered, because the switch is
              the obvious thing to blame for an empty transcript: it governs
              where thinking is drawn, and cannot conjure a block the provider
              never sent. */}
          Only shows what the provider sends. A model set to a low thinking effort, or one that
          encrypts its reasoning, has little or nothing to show — the effort is set beside the model
          in the status line.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Streaming text">
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
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
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
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
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
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

      <SettingsGroup label="Sidebar">
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
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

          <Item size="sm" className="items-start">
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
        Density is not a setting: the transcript uses one spacing scale so that message boundaries
        stay readable at a glance, and text size moves that whole scale at once rather than
        loosening it. There is no global motion switch either — the only animations in the app are
        the ones that show something arriving, and the one that runs continuously is the switch
        above.
      </p>
    </SettingsPane>
  );
}
