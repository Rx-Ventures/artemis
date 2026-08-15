/**
 * Put something on the clipboard, and say so for a moment.
 * ============================================================================
 *
 * Lifted out of the sign-in card, which held the renderer's only clipboard
 * write until code blocks grew one too. What is worth having in one place is not
 * `writeText` — that is a single line — but the two rules around it, both of
 * which were arrived at the hard way and neither of which is visible in the
 * call site once it is written.
 *
 * ## The tick waits for the write
 *
 * `copied` is set *after* the promise resolves, never beside the call. A denied
 * clipboard permission is otherwise completely silent: the button gives its
 * tick, the paste that follows is whatever the user copied last, and the two are
 * far enough apart that the button is never the suspect. A failure says so
 * instead, and says what to do about it.
 *
 * ## A missing clipboard is a failure, not a success
 *
 * `navigator.clipboard` is absent outside a secure context and under jsdom, so
 * the property access itself throws — which is exactly why the call sits inside
 * the `try` rather than behind a `?.`. Optional chaining would resolve to
 * `undefined`, take the success path, and report a copy that never happened.
 *
 * ## One timer, and it is cleared
 *
 * A transcript holds one of these per code block, so the tick has to be
 * cancellable: cleared before each new one, and cleared on unmount. Scrolling a
 * long answer past a button that was clicked a second ago is an ordinary thing
 * to do, and a timer that outlives its row is how that turns into a stray write.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** How long the tick stays up before the control goes back to offering. */
const TICK_MS = 1_500;

/** What to say when the clipboard refuses. */
export interface CopyFailure {
  readonly title: string;
  readonly description?: string;
}

const DEFAULT_FAILURE: CopyFailure = {
  title: 'Could not copy',
  description: 'Select the text and copy it by hand.',
};

/**
 * `[copied, copy]` — whether the tick is showing, and the thing to call.
 *
 * A tuple rather than an object, matching {@link useFold}: both are one piece of
 * state and one way to change it, and naming them at the call site reads better
 * than destructuring a record with the same two keys every time.
 *
 * Copying an empty string is a no-op rather than an error. The affordance is
 * usually rendered from data, and "there is nothing here yet" is a state the
 * caller should not have to special-case.
 */
export function useCopy(
  text: string,
  failure: CopyFailure = DEFAULT_FAILURE,
): readonly [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const { title, description } = failure;
  const copy = useCallback(() => {
    if (text.length === 0) return;
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast(title, { description });
        return;
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), TICK_MS);
    })();
  }, [text, title, description]);

  return [copied, copy] as const;
}
