/**
 * The composer.
 * ============================================================================
 *
 * One auto-growing textarea pinned between the transcript and the status line.
 * Everything that used to sit in a settings strip under it — permission mode,
 * the fork switch — has moved to the status line and the command palette, so
 * this is what it looks like: a place to type.
 *
 * Five behaviours are load-bearing:
 *
 *  - **Enter sends, Shift+Enter breaks the line.** With `isComposing` honoured,
 *    so an IME candidate selection does not fire the prompt.
 *  - **Up on an empty composer recalls the previous prompt**, and keeps walking
 *    back; Down walks forward and off the end back to empty. Only when the
 *    composer is empty *and* the caret is at the start, so Up inside a
 *    half-written multi-line prompt still moves the caret.
 *  - **Escape denies a parked permission prompt if there is one, and otherwise
 *    interrupts the run.** Both meanings unblock a stuck agent, which is what
 *    the key is for here; denying takes precedence because a parked run cannot
 *    be interrupted into a clean state while a decision is owed.
 *  - **It stays usable mid-run** when the provider advertises `midRunSteering`.
 *    When it does not, the field is disabled *with the reason attached* rather
 *    than quietly swallowing keystrokes, and Send says the same thing.
 *  - **Stop is always available while a run is live**, and is not
 *    capability-gated. A run that cannot be stopped is a wedged app.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  CircleStopIcon,
  GitForkIcon,
  SendHorizontalIcon,
} from 'lucide-react';

import { useCapability } from '../hooks/useCapability';
import { keyLabel } from '../hooks/useHotkeys';
import {
  denyPendingPermission,
  interruptRun,
  isLive,
  setForkOnResume,
  submitPrompt,
  useApp,
} from '../state/store';
import { ReasonButton, WithReason } from './disabled-reason';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Chromium sizes a textarea to its content natively with `field-sizing`, which
 * is what the `field-sizing-content` class on shadcn's `Textarea` asks for. The
 * manual fallback below only runs where that is unsupported — running both
 * would mean JS fighting the layout engine for the element's height.
 */
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

export function Composer(): ReactElement {
  const [text, setText] = useState('');
  /**
   * How far back through `promptHistory` recall has walked. `null` is "not
   * recalling" — the distinction matters, because index 0 is a real entry.
   */
  const [recall, setRecall] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const live = useApp(isLive);
  const status = useApp((s) => s.run?.status ?? null);
  const pending = useApp((s) => s.permissionQueue.length);
  const steering = useCapability('midRunSteering');
  const resuming = useApp((s) => s.resumeSessionId);
  const fork = useApp((s) => s.forkOnResume);
  const history = useApp((s) => s.promptHistory);

  const locked = live && !steering.supported;

  const grow = useCallback(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }, []);

  useEffect(grow, [grow, text]);

  const send = useCallback(() => {
    const value = textareaRef.current?.value ?? text;
    if (value.trim().length === 0) return;
    void submitPrompt(value);
    setText('');
    setRecall(null);
  }, [text]);

  /**
   * Walk the prompt history.
   *
   * `delta` of -1 is "older". Walking past the newest entry lands on an empty
   * composer rather than sticking on the last prompt, so Down is a way out of
   * recall and not a trap.
   */
  const walk = useCallback(
    (delta: number): boolean => {
      if (history.length === 0) return false;
      const current = recall ?? history.length;
      const next = current + delta;
      if (next < 0) return false;
      if (next >= history.length) {
        setRecall(null);
        setText('');
        return true;
      }
      setRecall(next);
      setText(history[next] ?? '');
      return true;
    },
    [history, recall],
  );

  // Nothing renders under the input row, deliberately: two rows lived there —
  // a resume banner and a keyboard-hint strip — and both were permanent chrome
  // restating what a user learns once.
  //
  // One real control went with them: the fork toggle. Fork is still settable
  // from the command palette, but it is no longer visible or reversible here,
  // so a session set to fork gives no sign of it until it branches. If that
  // bites, the toggle needs its own home; don't bring the whole row back.
  /*
   * No panel fill and no top border.
   *
   * The composer used to sit in a darker bar drawn across the foot of the
   * window, which read as a second surface the transcript ended at. It is the
   * same document: the input is the last thing in the column, not furniture
   * beneath it. So the input carries its own border (see `Textarea`) and floats
   * on the window background, with the status line under it — nothing boxes
   * either of them in.
   *
   * The run bar stays, but hairline-thin and only while a run is live. It is
   * the one piece of chrome here that reports something.
   */
  return (
    <div className="shrink-0">
      {live ? (
        <div className="relative h-px overflow-hidden bg-line">
          <span className="runbar absolute inset-0 block" />
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-4xl items-end gap-2 px-3 pt-2 pb-1">
        <WithReason
          reason={locked ? steering.reason : undefined}
          className="min-w-0 flex-1"
          side="top"
        >
          <Textarea
            ref={textareaRef}
            value={text}
            disabled={locked}
            rows={1}
            spellCheck={false}
            aria-label="Prompt"
            placeholder={
              locked
                ? `Waiting for the run to finish — ${steering.reason}`
                : pending > 0
                  ? 'A tool call is waiting for your approval above…'
                  : live
                    ? 'Steer the run…'
                    : resuming
                      ? 'Continue the selected session…'
                      : 'Ask Apollo to do something…'
            }
            onChange={(event) => {
              setText(event.target.value);
              // Any edit leaves recall: the text on screen is no longer a
              // history entry, so Up should start again from the newest.
              setRecall(null);
            }}
            onKeyDown={(event) => {
              const el = event.currentTarget;

              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
                return;
              }

              // Escape from inside the composer, because the global handler
              // deliberately ignores text fields and this is the one place the
              // user is guaranteed to be typing.
              if (event.key === 'Escape') {
                event.preventDefault();
                void denyPendingPermission().then((denied) => {
                  if (!denied && useApp.getState().run?.status !== 'ended') void interruptRun();
                });
                return;
              }

              // Recall only from the very start of the field. Anywhere else Up
              // and Down are caret movement, and stealing them would make a
              // multi-line prompt unnavigable.
              const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
              if (event.key === 'ArrowUp' && atStart && (text.length === 0 || recall !== null)) {
                if (walk(-1)) event.preventDefault();
                return;
              }
              if (event.key === 'ArrowDown' && recall !== null && atStart) {
                if (walk(1)) event.preventDefault();
              }
            }}
            className={cn(
              'max-h-[35vh] min-h-9 w-full resize-none bg-inset px-2.5 py-2 font-mono text-sm leading-relaxed md:text-sm',
              locked && 'cursor-not-allowed',
            )}
          />
        </WithReason>

        {live ? (
          <Button
            variant="destructive"
            onClick={() => void interruptRun()}
            title={`Stop the run (${keyLabel('escape')})`}
          >
            <CircleStopIcon />
            Stop
          </Button>
        ) : null}

        {/*
          Icon only. The word was carrying nothing the icon and the Enter hint
          in the empty state do not already carry, and it made the widest
          control on this row the one that says the least. `aria-label` and the
          title keep it named for anyone not reading the glyph.
        */}
        <ReasonButton
          size="icon"
          onClick={send}
          disabled={locked || text.trim().length === 0}
          disabledReason={locked ? steering.reason : undefined}
          aria-label={`Send the prompt (${keyLabel('enter')})`}
          title={`Send the prompt (${keyLabel('enter')})`}
        >
          <SendHorizontalIcon />
        </ReasonButton>
      </div>

    </div>
  );
}
