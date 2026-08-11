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
 *  - **Images attach by paste, by drop, or from a picker**, and all three land
 *    in the same place. Paste is the one that matters: a screenshot goes to the
 *    clipboard, and the gesture after taking one is Cmd+V.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react';
import {
  CircleStopIcon,
  FileTextIcon,
  GitForkIcon,
  PaperclipIcon,
  SendHorizontalIcon,
  XIcon,
} from 'lucide-react';
import {
  ATTACHMENT_LIMITS,
  attachmentBytes,
  isImageAttachment,
  type Attachment,
} from '@rx-artemis/protocol';

import { useCapability } from '../hooks/useCapability';
import { keyLabel } from '../hooks/useHotkeys';
import {
  denyPendingPermission,
  interruptRun,
  isLive,
  pushBanner,
  setForkOnResume,
  submitPrompt,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { paneState, setPaneState } from '../state/pane';
import {
  attachmentSrc,
  fileKindLabel,
  filesFrom,
  formatBytes,
  readAttachments,
  type AttachmentRejection,
} from '../lib/attachments';
import { ReasonButton, WithReason } from './disabled-reason';
import { WorkingDirectoryChip } from './WorkingDirectory';
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

/**
 * Report what could not be attached.
 *
 * One banner for the batch rather than one per file: dropping a folder of
 * twelve things onto the composer is a single mistake, and twelve banners about
 * it is a second one.
 */
function reportRejections(rejected: readonly AttachmentRejection[]): void {
  if (rejected.length === 0) return;
  const [first] = rejected;
  if (first === undefined) return;
  pushBanner(
    'warn',
    rejected.length === 1
      ? `Could not attach ${first.name}`
      : `Could not attach ${String(rejected.length)} files`,
    rejected.map((entry) => `${entry.name}: ${entry.reason}`).join('\n'),
  );
}

export function Composer(): ReactElement {
  /**
   * How far back through `promptHistory` recall has walked. `null` is "not
   * recalling" — the distinction matters, because index 0 is a real entry.
   */
  const [recall, setRecall] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  /**
   * Whether a drag is currently over the composer.
   *
   * A counter would be the usual fix for `dragleave` firing as the pointer
   * crosses a child element, but the drop target here has no children the
   * pointer can reach — the highlight is drawn on the wrapper and the textarea
   * inside it is the only child. `relatedTarget` handles the rest.
   */
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /*
   * Everything below is this column's, and none of it is the window's. A
   * composer in a split view that read the focused pane would send the right
   * column's prompt into the left column's run the moment focus moved — which
   * is why the pane is taken once, here, and passed to every action rather
   * than left to default.
   */
  const pane = usePaneRef();
  /*
   * The draft lives in the pane, not in `useState` here.
   *
   * Opening or closing a column re-parents the surviving column in the React
   * tree, which unmounts it — so component-local text would be discarded by an
   * action about *the other* conversation. See `SessionState.draft`.
   */
  const text = usePane((s) => s.draft);
  const setText = useCallback(
    (value: string) => setPaneState(pane, { draft: value }),
    [pane],
  );
  const live = usePane(isLive);
  const pending = usePane((s) => s.permissionQueue.length);
  // "Approve" is the wrong word for a question, and pointing at the wrong card
  // is how a user ends up hunting for an Approve button that is not there.
  const asking = usePane((s) => s.permissionQueue.every((r) => r.question !== undefined));
  const steering = useCapability('midRunSteering');
  const images = useCapability('imageInput');
  const files = useCapability('fileInput');
  const resuming = usePane((s) => s.resumeSessionId);
  const fork = usePane((s) => s.forkOnResume);
  const history = usePane((s) => s.promptHistory);

  const locked = live && !steering.supported;

  /** Slots left, per kind — the two have separate budgets. */
  const imageCount = attachments.filter(isImageAttachment).length;
  const slots = {
    images: ATTACHMENT_LIMITS.images - imageCount,
    files: ATTACHMENT_LIMITS.files - (attachments.length - imageCount),
  };
  const full = slots.images <= 0 && slots.files <= 0;
  /** Nothing at all can be attached — the provider takes neither kind. */
  const attachable = images.supported || files.supported;

  /**
   * Take files from wherever they came from.
   *
   * Every entry point funnels through here so that the count limits, the image
   * resizing and the rejection reporting cannot drift apart between paste, drop
   * and the picker.
   */
  const attach = useCallback(
    async (dropped: readonly File[]): Promise<void> => {
      if (dropped.length === 0) return;
      if (!attachable) {
        pushBanner('warn', 'This provider cannot take attachments', images.reason);
        return;
      }

      // Read against the slots free *now*; the state update below re-checks
      // against the slots free when it lands, because reading is async and the
      // user can paste twice in the time it takes. A kind the provider cannot
      // carry gets zero slots, so it is rejected with a reason rather than
      // attached and silently dropped at send time.
      const { accepted, rejected } = await readAttachments(dropped, {
        images: images.supported ? slots.images : 0,
        files: files.supported ? slots.files : 0,
      });
      reportRejections(rejected);
      if (accepted.length === 0) return;
      setAttachments((current) => {
        const merged = [...current, ...accepted];
        const keptImages = merged.filter(isImageAttachment).slice(0, ATTACHMENT_LIMITS.images);
        const keptFiles = merged
          .filter((attachment) => !isImageAttachment(attachment))
          .slice(0, ATTACHMENT_LIMITS.files);
        // Re-ordered so images lead, which is the order they are sent in and
        // the order the strip reads best in — thumbnails, then filenames.
        return [...keptImages, ...keptFiles];
      });
    },
    [attachable, files.supported, images.reason, images.supported, slots.files, slots.images],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const grow = useCallback(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }, []);

  useEffect(grow, [grow, text]);

  /*
   * Swallow drops that miss the composer.
   *
   * Without this the window itself handles the drop, which for a file means a
   * navigation to `file://…`. The main process already refuses that (see
   * `hardenWebContents`), so nothing unsafe happens — but "nothing unsafe" is
   * the whole app going blank in the failure case, and a near-miss on the
   * composer is a normal thing for a person to do with a picture.
   */
  useEffect(() => {
    const swallow = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  const send = useCallback(() => {
    const value = textareaRef.current?.value ?? text;
    if (value.trim().length === 0) return;

    const sent = attachments;
    setText('');
    setRecall(null);
    // Cleared with the text rather than on the round-trip: an attachment
    // belongs to the prompt it went with, and leaving it in the field would put
    // it silently on the next one too.
    setAttachments([]);

    // Into *this* pane. A composer that let the argument default would send the
    // right column's prompt into the left column's run the moment focus moved.
    void submitPrompt(value, sent, pane).then((accepted) => {
      // …but a prompt that never left is a different thing. `submitPrompt`
      // refuses outright when there is no working directory or no profile, and
      // it says so by returning false; the text survives that on Up-arrow
      // recall, and images have no such second chance. Putting them back is the
      // difference between a fixable mistake and a trip back to the screenshot
      // tool.
      //
      // Only into a strip the user has not refilled in the meantime — reading
      // `current` rather than closing over the old value is what makes an image
      // pasted during the round-trip survive.
      if (!accepted && sent.length > 0) {
        setAttachments((current) => (current.length === 0 ? sent : current));
      }
    });
  }, [attachments, text, pane, setText]);

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
    [history, recall, setText],
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

      {/*
        The directory, above the input and aligned to its left edge.

        It is a heading for what follows rather than a setting on it. Everything
        on the status line *under* the composer answers "what will the next
        prompt do"; this answers "where am I", which is the frame the rest sits
        inside. Reading order matches: place, then prompt, then settings.
      */}
      <div className="mx-auto flex w-full max-w-4xl items-center px-3 pt-1.5">
        <WorkingDirectoryChip />
      </div>

      <div className="mx-auto flex w-full max-w-4xl items-end gap-2 px-3 pt-1 pb-1">
        {/*
          The positioning context for Send is this element, not `WithReason`.
          `WithReason` renders its children bare — no wrapper, no `className` —
          whenever there is no reason to show, which is the normal case here. A
          `relative` handed to it would exist only while the composer was
          locked, so the button would fall out of the field in the one state
          nobody is looking at it in.
        */}
        {/*
          The drop target is the whole field wrapper, not the textarea.

          A textarea has its own drag behaviour — a dragged *file* over one shows
          an insertion caret, as though it were about to be typed — and the
          wrapper is what the thumbnail strip lives in anyway, so the highlight
          covers everything a person would aim at.
        */}
        <div
          className={cn(
            'relative min-w-0 flex-1 rounded-md',
            dragging && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
          )}
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            // Both required: without `preventDefault` the browser refuses the
            // drop, and without `dropEffect` the cursor claims it will move the
            // file rather than copy it.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragging(true);
          }}
          onDragLeave={(event: DragEvent<HTMLDivElement>) => {
            // `relatedTarget` is where the pointer went. Still inside means the
            // pointer crossed the textarea, not the edge.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            const files = filesFrom(event.dataTransfer);
            if (files.length === 0) {
              // Dropped something, but nothing we can use. Silence here reads
              // as a broken drop target.
              if (event.dataTransfer.files.length > 0) {
                pushBanner('warn', 'Only images can be attached to a prompt');
              }
              return;
            }
            void attach(files);
          }}
        >
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />

          <WithReason
            reason={locked ? steering.reason : undefined}
            className="w-full"
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
                    ? asking
                      ? 'The agent is waiting on an answer above…'
                      : 'A tool call is waiting for your approval above…'
                    : live
                      ? 'Steer the run…'
                      : resuming
                        ? 'Continue the selected session…'
                        : 'Ask Artemis to do something…'
              }
              onChange={(event) => {
                setText(event.target.value);
                // Any edit leaves recall: the text on screen is no longer a
                // history entry, so Up should start again from the newest.
                setRecall(null);
              }}
              /*
                Paste is the reason this feature exists.

                `preventDefault` runs only when the clipboard actually held an
                image. Copying a *file* in Finder puts both the file and its
                name on the clipboard, and a paste that ate the text as well
                would be a regression for anyone pasting a path — so the text
                keeps its default behaviour and the image is taken alongside it.
              */
              onPaste={(event) => {
                const files = filesFrom(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                void attach(files);
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
                  void denyPendingPermission(pane).then((denied) => {
                    if (!denied && paneState(pane).run?.status !== 'ended') void interruptRun(pane);
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
                // `pr-18` reserves the buttons' lane — two 28px buttons, 4px of
                // inset each side, 2px between them, and 8px of gap before the
                // text. Without it a long single-line prompt runs under the
                // glyphs and its last word is unreadable.
                'max-h-[35vh] min-h-9 w-full resize-none bg-inset py-2 pr-18 pl-2.5 font-mono text-sm leading-relaxed md:text-sm',
                locked && 'cursor-not-allowed',
              )}
            />
          </WithReason>

          {/*
            Inside the field, pinned to its bottom-right.

            Each button is square and *fixed* at 28px, which is the field's 36px
            minimum less 4px of inset each side — so at one line they read as
            filling the height, and when the text wraps they keep that size and
            travel down with the growing edge. Anchoring the row to `bottom`
            rather than centring is what makes that true: centred, they would
            drift to the middle of a tall field and stop lining up with the line
            being typed.

            Ghost, not the accent fill. Send is the default action of the Enter
            key, not a call to action competing with the text — the brightest
            thing in the composer should be what the user is writing.

            Icons only. The words carried nothing the glyphs and the Enter hint
            in the empty state do not; `aria-label` and the titles keep them
            named for anyone not reading the glyph.
          */}
          <div className="absolute right-1 bottom-1 flex items-center gap-0.5">
            {/*
              Attach sits to Send's left, in the same lane and at the same size.

              Ordering is the reading order of the action: pick the picture,
              then send it. It is also the safer of the two arrangements — Send
              stays the rightmost thing in the field, where it has always been,
              so muscle memory does not open a file dialog.

              The hidden input is what actually opens the picker. A native
              dialog through the main process would hand back a *path*, which
              would then have to be read on the renderer's say-so; the input
              element hands over the bytes the user themselves selected and
              needs no new IPC channel to do it.

              No `accept` filter, deliberately. The agent has `Read`, `Grep` and
              a shell, so the set of files it can do something with is wider
              than any list here would stay current with — and an `accept` that
              greys out the user's own `.parquet` in the OS picker is a worse
              answer than attaching it and letting the agent try.
            */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                // Reset first: picking the same file twice in a row fires no
                // `change` at all if the value is still sitting there.
                event.target.value = '';
                void attach(picked);
              }}
            />
            <ReasonButton
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={locked || !attachable || full}
              disabledReason={
                !attachable
                  ? images.reason
                  : full
                    ? `A prompt can carry ${String(ATTACHMENT_LIMITS.images)} images and ${String(ATTACHMENT_LIMITS.files)} files.`
                    : locked
                      ? steering.reason
                      : undefined
              }
              aria-label="Attach a file"
              title="Attach a file — or paste or drop one"
              className="size-7 shrink-0 p-0 text-ink-muted hover:text-ink"
            >
              <PaperclipIcon />
            </ReasonButton>

            <ReasonButton
              variant="ghost"
              onClick={send}
              disabled={locked || text.trim().length === 0}
              disabledReason={locked ? steering.reason : undefined}
              aria-label={`Send the prompt (${keyLabel('enter')})`}
              title={`Send the prompt (${keyLabel('enter')})`}
              className="size-7 shrink-0 p-0 text-ink-muted hover:text-ink"
            >
              <SendHorizontalIcon />
            </ReasonButton>
          </div>
        </div>

        {live ? (
          <Button
            variant="destructive"
            onClick={() => void interruptRun(pane)}
            title={`Stop the run (${keyLabel('escape')})`}
          >
            <CircleStopIcon />
            Stop
          </Button>
        ) : null}
      </div>

    </div>
  );
}

/**
 * What is attached, above the field it will be sent from.
 *
 * Two shapes, because the two kinds answer "which one is this?" differently.
 *
 * An **image** shows its picture. Half of what lands here is a pasted
 * screenshot with no filename at all, and of the half that has one, "Screenshot
 * 2026-08-11 at 14.03.22.png" tells the user nothing about which screenshot it
 * is. The picture is the label.
 *
 * A **file** has nothing to show, so it shows what it is: name, kind and size.
 * The size is there because it is the number that decides whether attaching it
 * was a good idea, and because it is the same number the agent will be told.
 *
 * Nothing renders when there is nothing attached — not an empty row, not a
 * dashed drop zone. The composer is a place to type, and a permanent box
 * advertising a feature you are not using is the chrome this file has spent
 * several rounds removing.
 */
function AttachmentStrip({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly Attachment[];
  readonly onRemove: (id: string) => void;
}): ReactElement | null {
  if (attachments.length === 0) return null;

  return (
    <ul className="mb-1.5 flex flex-wrap items-start gap-1.5" aria-label="Attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="relative">
          {isImageAttachment(attachment) ? (
            <img
              src={attachmentSrc(attachment)}
              // The filename when there is one, so a screen reader and a hover
              // both name the thing. `alt` is not decorative here: this is
              // content the user added and can remove.
              alt={attachment.name ?? 'Attached image'}
              title={attachment.name ?? 'Attached image'}
              className="size-14 rounded-md border border-line object-cover"
            />
          ) : (
            /*
              Sized to the thumbnails' height so the strip keeps one baseline,
              but free to be as wide as the name needs up to a cap — a filename
              squeezed into a square would defeat the point of showing it.
            */
            <div
              title={`${attachment.name} — ${formatBytes(attachmentBytes(attachment))}`}
              className="flex h-14 max-w-56 items-center gap-2 rounded-md border border-line bg-inset px-2.5"
            >
              <FileTextIcon className="size-4 shrink-0 text-ink-muted" />
              <span className="min-w-0">
                {/* `break-all` over `truncate`: the informative half of a
                    filename is often its end (`…-final-v3.csv`), and a middle
                    ellipsis is not something CSS can do. Two lines of a long
                    name beats one line of its prefix. */}
                <span className="line-clamp-2 font-mono text-2xs leading-tight break-all text-ink">
                  {attachment.name}
                </span>
                <span className="block text-2xs text-ink-muted">
                  {fileKindLabel(attachment)} · {formatBytes(attachmentBytes(attachment))}
                </span>
              </span>
            </div>
          )}
          {/*
            Remove is always visible, not hover-only.

            A control that appears on hover is a control that does not exist for
            anyone navigating by keyboard, and the whole point of this strip is
            that something attached by accident — the wrong screenshot, a paste
            into the wrong window — can be taken back before it is sent and
            billed for.
          */}
          <button
            type="button"
            onClick={() => {
              onRemove(attachment.id);
            }}
            aria-label={`Remove ${attachment.name ?? 'this image'}`}
            title="Remove"
            className="absolute -top-1 -right-1 flex size-4.5 items-center justify-center rounded-full border border-line bg-panel text-ink-muted opacity-80 transition-opacity hover:text-ink hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

