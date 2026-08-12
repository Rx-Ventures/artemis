/**
 * The bug report form.
 *
 *      ╭──────────────────────────────────────╮
 *      │ Report a bug                         │
 *      │ Opens GitHub with this filled in.    │
 *      │                                      │
 *      │ Summary                              │
 *      │ [ Dock tab loses focus on resize   ] │
 *      │ What happened                        │
 *      │ [                                  ] │
 *      │ Steps to reproduce  (optional)       │
 *      │ [                                  ] │
 *      │ ☑ Include Artemis 0.6.0 · macOS      │
 *      │                                      │
 *      │              [ Cancel ] [ Continue ] │
 *      ╰──────────────────────────────────────╯
 *
 * Three fields and a checkbox, because the form has to be worth filling in at
 * the moment something has just gone wrong. `Summary` and `What happened` are
 * required — see `isSubmittable` — and steps are not, since a bug someone cannot
 * reproduce on demand is still worth hearing about and demanding a repro is how
 * you get an empty issues tab.
 *
 * ## Continue, not Submit
 *
 * The button does not file anything: it opens GitHub's own `issues/new` with all
 * of this prefilled, and the user presses *Create* there. Calling it *Submit*
 * would misreport what the click does and lose the reporter the one thing this
 * arrangement is good for — a last read of what is about to be public, on a
 * public repository. `lib/bugReport.ts` documents why the hand-off is the
 * mechanism at all.
 *
 * ## The environment line is opt-out, and it is only two facts
 *
 * Version and platform, both already on screen elsewhere in the app, both the
 * first things anyone triaging would ask for. No logs, no transcript, no paths,
 * no working directory — this window can see a lot that a bug report has no
 * business carrying by default, and the checkbox exists so the two harmless
 * facts do not have to be typed by hand rather than to imply a choice about
 * anything larger.
 */

import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { BugIcon } from 'lucide-react';

import { buildIssueUrl, isSubmittable, platformLabel } from '../lib/bugReport';
import { useApp } from '../state/store';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function BugReportDialog({ onClose }: { readonly onClose: () => void }): ReactElement {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);

  const [title, setTitle] = useState('');
  const [whatHappened, setWhatHappened] = useState('');
  const [steps, setSteps] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);

  const draft = { title, whatHappened, steps, includeDiagnostics };
  const ready = isSubmittable(draft);
  const built = buildIssueUrl(draft, { version, platform });

  /**
   * Hand off to the browser.
   *
   * The navigation itself is the anchor's, not this handler's — `main/security.ts`
   * routes an external URL to the system browser and refuses to navigate this
   * window, which is what makes a plain link the safe way out (the same reasoning
   * `UpdateCard` follows for its releases link). This runs alongside it: park the
   * untrimmed body on the clipboard when the URL could not carry all of it, then
   * close.
   */
  const handoff = (): void => {
    // `?.` on the clipboard itself, not just the write: it is absent under a
    // non-secure context and in jsdom, and a missing clipboard must not take the
    // report down with it — the trimmed body is already in the URL.
    if (built.trimmed && navigator.clipboard !== undefined) {
      void navigator.clipboard
        .writeText(built.body)
        .then(() => {
          toast('Full report copied', {
            description: 'The link could not carry all of it — paste into the GitHub form to restore the rest.',
          });
        })
        .catch(() => {
          // The trimmed body still went out and still says it was trimmed. A
          // failed clipboard write is not worth blocking the report over.
          toast('Report was shortened to fit', {
            description: 'Some of the text could not be carried over. Add it in the GitHub form.',
          });
        });
    }
    onClose();
  };

  const environment = `Artemis ${version === '' ? 'unknown version' : version} · ${platformLabel(platform)}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink">
            <BugIcon aria-hidden="true" className="size-4 text-lunar" />
            Report a bug
          </DialogTitle>
          <DialogDescription className="text-2xs leading-snug">
            This opens GitHub with everything below filled in — you press <em>Create</em> there. The
            issue is public, and posted from your own GitHub account.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bug-title" className="text-2xs text-ink-muted">
              Summary
            </Label>
            <Input
              id="bug-title"
              autoFocus
              value={title}
              maxLength={160}
              placeholder="One line: what went wrong"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bug-what" className="text-2xs text-ink-muted">
              What happened
            </Label>
            <Textarea
              id="bug-what"
              value={whatHappened}
              rows={4}
              placeholder="What you expected, and what happened instead."
              className="text-sm"
              onChange={(event) => setWhatHappened(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bug-steps" className="text-2xs text-ink-muted">
              Steps to reproduce{' '}
              <span className="font-normal text-ink-faint">— optional</span>
            </Label>
            <Textarea
              id="bug-steps"
              value={steps}
              rows={3}
              placeholder="If you can make it happen again, how?"
              className="text-sm"
              onChange={(event) => setSteps(event.target.value)}
            />
          </div>

          <Label
            htmlFor="bug-diagnostics"
            className="cursor-pointer items-start gap-2 text-2xs font-normal leading-snug text-ink-muted"
          >
            <Checkbox
              id="bug-diagnostics"
              checked={includeDiagnostics}
              onCheckedChange={(checked) => setIncludeDiagnostics(checked === true)}
              className="mt-px"
            />
            <span>
              Include <span className="text-ink">{environment}</span>
            </span>
          </Label>

          {/*
            Said before the click, not after. The trim is decided by the URL's
            length, which is knowable while the user is still typing — telling
            them here means the clipboard note is a confirmation rather than a
            surprise arriving after the form has closed.
          */}
          {ready && built.trimmed && (
            <p role="status" className="text-2xs leading-snug text-ink-faint">
              This is longer than a link can carry. The full text will be copied to your clipboard
              so you can paste it into the GitHub form.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {/*
            An anchor when there is something to send and a disabled button when
            there is not: an `<a>` has no disabled state, and one styled to look
            inert still navigates on click and still takes the keyboard.
          */}
          {ready ? (
            <Button asChild size="sm">
              <a href={built.url} target="_blank" rel="noreferrer" onClick={handoff}>
                Continue on GitHub
              </a>
            </Button>
          ) : (
            <Button size="sm" disabled>
              Continue on GitHub
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
