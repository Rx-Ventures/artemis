/**
 * The settings surface.
 * ============================================================================
 *
 * One large dialog with its own section nav, replacing what used to be a
 * full-screen profiles page laid over the conversation.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIALOG AND NOT A SCREEN
 * ---------------------------------------------------------------------------
 *
 * The old surface was `absolute inset-0` over the app: it hid the conversation
 * completely, it had no relationship to what the user was doing when they
 * opened it, and every new settings pane made it look more like a second
 * application. A modal keeps the conversation visible behind it, which is the
 * honest picture — settings change the *next* run, and the run they are about
 * to change is right there.
 *
 * The cost of a modal is that it is usually too small, and a cramped dialog
 * would be a straight regression from a full screen. So this one is
 * deliberately large — most of the window, capped against the viewport — and
 * the height is fixed rather than content-driven, because a dialog that
 * changes size when you switch section makes the nav feel like it is moving
 * under the pointer.
 *
 * ---------------------------------------------------------------------------
 * ONE SCROLL CONTAINER
 * ---------------------------------------------------------------------------
 *
 * The content pane scrolls; the dialog does not, and neither does the nav. That
 * is the whole reason for the `min-h-0` on the flex row — without it a tall
 * pane grows the flex item instead of scrolling inside it, the dialog exceeds
 * the viewport, and the page behind starts scrolling instead. Panes are written
 * to assume they are inside this one scroller and never make another.
 *
 * ---------------------------------------------------------------------------
 * STATE LIVES IN THE STORE
 * ---------------------------------------------------------------------------
 *
 * Open/closed is `screen === 'profiles'` — the historical name for "settings is
 * open", kept because every existing `setScreen('profiles')` call site is a
 * correct request to open this — and the pane is `settingsSection`. Neither is
 * local state: the command palette, the model picker's "manage models" link and
 * the ⌘, hotkey all need to open this dialog *on a particular pane*, and a
 * component that owned its own section could not be aimed from outside.
 */

import type { ReactElement } from 'react';
import { BoxesIcon, KeyRoundIcon, PaletteIcon, ShieldIcon } from 'lucide-react';

import { ProfilesSection } from '../ProfilesScreen';
import { AppearanceSection } from './AppearanceSection';
import { ModelsSection } from './ModelsSection';
import { PermissionsSection } from './PermissionsSection';
import { closeSettings, setSettingsSection, useApp, type SettingsSection } from '../../state/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface SectionEntry {
  readonly id: SettingsSection;
  readonly label: string;
  /** Four words at most — the nav is 13rem wide and this sits under the label. */
  readonly hint: string;
  readonly icon: ReactElement;
}

/**
 * The nav, in the order the panes were designed to be met.
 *
 * Profiles first because without one nothing else in this dialog can be
 * answered: the model catalogue is fetched with a profile's credential, and the
 * permission modes come from the provider that profile names.
 */
const SECTIONS: readonly SectionEntry[] = [
  {
    id: 'profiles',
    label: 'Profiles',
    hint: 'Accounts and sign-in',
    icon: <KeyRoundIcon aria-hidden="true" />,
  },
  {
    id: 'models',
    label: 'Models',
    hint: 'Catalogue and quick access',
    icon: <BoxesIcon aria-hidden="true" />,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    hint: 'Width and layout',
    icon: <PaletteIcon aria-hidden="true" />,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    hint: 'What runs without asking',
    icon: <ShieldIcon aria-hidden="true" />,
  },
];

export function SettingsDialog(): ReactElement {
  const open = useApp((s) => s.screen === 'profiles');
  const section = useApp((s) => s.settingsSection);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only the close direction is handled here. Radix asks to *open* when a
        // trigger is activated, and this dialog has no trigger — every entry
        // point goes through `openSettings`, which can also aim it at a pane.
        if (!next) closeSettings();
      }}
    >
      <DialogContent
        // `sm:max-w-*` has to be restated: the base content class pins itself to
        // `sm:max-w-sm` at every breakpoint above mobile, which would quietly
        // shrink this to a tooltip-sized box on any real window.
        className="flex h-[min(46rem,calc(100dvh-3rem))] w-[calc(100vw-3rem)] max-w-[68rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[68rem]"
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-line px-4 py-3">
          <DialogTitle className="text-sm font-semibold tracking-tight text-ink">
            Settings
          </DialogTitle>
          <DialogDescription className="text-2xs leading-snug">
            Everything here applies to the next run. Nothing changes a run already in flight.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Settings sections"
            className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line p-2"
          >
            {SECTIONS.map((entry) => {
              const active = entry.id === section;
              return (
                <Button
                  key={entry.id}
                  // Not `variant="secondary"` for the active row, which is what
                  // this reached for first: `--secondary` resolves to the
                  // `raised` surface, and inside a popover — which is one step
                  // *above* raised — the "selected" fill came out darker than
                  // the panel it sits on and read as nothing at all. Brass is
                  // the app's selection colour everywhere else (the active
                  // profile card, the chosen option in a `ChoiceList`), so the
                  // nav uses it too rather than inventing a third language.
                  variant="ghost"
                  size="lg"
                  // `aria-current` rather than `aria-pressed`: these are
                  // navigation, not toggles. A screen reader should say "current
                  // page", not "pressed".
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-left',
                    // A border rather than a ring: `Button` already draws
                    // `border border-transparent`, so colouring it costs no
                    // layout, while `ring-*` on this component collides with
                    // the focus ring it declares for itself.
                    active
                      ? 'border-ember/30 bg-ember/10 text-ink hover:bg-ember/15'
                      : 'text-ink-muted',
                  )}
                  onClick={() => setSettingsSection(entry.id)}
                >
                  <span className={cn('shrink-0', active ? 'text-ember' : 'text-ink-faint')}>
                    {entry.icon}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs leading-snug font-medium">{entry.label}</span>
                    <span className="text-2xs leading-snug font-normal text-ink-faint">
                      {entry.hint}
                    </span>
                  </span>
                </Button>
              );
            })}
          </nav>

          {/* `min-h-0` on the row above plus this one is what makes the scroll
              land here instead of on the dialog. Removing either turns the
              content pane into a growing box and the modal into a page. */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-3xl px-6 py-5">
              <SectionBody section={section} />
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Only the visible pane is mounted.
 *
 * Not an optimisation — the profiles pane holds an in-progress form, and
 * unmounting it when the user navigates away is the behaviour that keeps a
 * half-typed credential from surviving in the background where nothing on
 * screen suggests it still exists.
 */
function SectionBody({ section }: { readonly section: SettingsSection }): ReactElement {
  switch (section) {
    case 'models':
      return <ModelsSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'profiles':
      return <ProfilesSection />;
  }
}
