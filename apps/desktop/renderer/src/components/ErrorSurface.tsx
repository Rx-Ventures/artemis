/**
 * The visible error surface.
 *
 * IPC never rejects — it resolves a typed failure — which means a failure that
 * is not rendered is a failure nobody ever sees. Everything the store learns
 * about lands here: a failed handler, a `run.end` carrying an error, a run the
 * main process refused to start.
 *
 * Banners, not toasts, and that is a decision rather than an omission. A toast
 * disappears; these describe a state the user has to act on ("pick a profile",
 * "the provider fell over") and they stay until dismissed. Sonner is mounted
 * for the transient case — see `components/providers.tsx` — and is deliberately
 * not used for anything that is still true after four seconds.
 *
 * They are cards inset into the working area, not a full-bleed strip welded
 * under the top bar. The strip was what forced the old colour rule: a tint on
 * something edge-to-edge is the window changing colour, so warnings had to give
 * theirs up. A card can be tinted — the fill is bounded by a border, at the
 * same inset as the pane below it — so each level says what it is again, and
 * two banners stack as two cards rather than as a growing band of chrome.
 */

import type { ReactElement } from 'react';
import { InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';

import { dismissBanner, useApp, type Banner } from '../state/store';
import { IconButton } from './disabled-reason';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ErrorSurface(): ReactElement | null {
  const banners = useApp((s) => s.banners);
  if (banners.length === 0) return null;
  return (
    // The padding is the working area's own: a banner is inset to the same
    // vertical rule as the pane it sits above, so the column below does not
    // look like it starts further in than the thing reporting about it.
    <div className="mb-[7px] flex shrink-0 flex-col gap-1.5">
      {banners.map((banner) => (
        <BannerRow key={banner.id} banner={banner} />
      ))}
    </div>
  );
}

/**
 * A tone each, now that a banner is a card.
 *
 * The border carries the level at 45% alpha and the fill at a tenth — enough to
 * name the card across a window, nowhere near enough to compete with the text
 * on it. Error and warning are 60° apart (rose at 25, amber at 85), so the two
 * never blur even side by side.
 *
 * Information gets the neutral pair — a hairline and a wash — because there is
 * no third alarm colour and inventing one would say something is wrong when the
 * banner is only telling you a thing. It reads as quieter than the other two,
 * which is the correct order.
 */
const LEVEL_STYLES: Record<Banner['level'], string> = {
  error: 'border-signal/45 bg-signal/10 text-ink',
  warn: 'border-amber/45 bg-amber/10 text-ink',
  info: 'border-hairline bg-wash text-ink-muted',
};

function BannerRow({ banner }: { readonly banner: Banner }): ReactElement {
  return (
    <Alert
      // A card at the working area's radius, not a strip: banners stack, and a
      // stack of cards reads as a stack of separate reports where a stack of
      // full-bleed rows read as one growing band of chrome.
      className={cn('rounded-lg px-3 py-2', LEVEL_STYLES[banner.level])}
    >
      {banner.level === 'info' ? (
        <InfoIcon />
      ) : (
        // The card's text is plain ink so the message stays the most legible
        // thing on it; the triangle is where the level's own colour is spent,
        // beside a border of the same hue.
        <TriangleAlertIcon
          className={banner.level === 'warn' ? 'text-amber' : 'text-signal'}
        />
      )}
      <AlertTitle className="font-mono text-2xs leading-snug break-words whitespace-normal">
        {banner.message}
      </AlertTitle>
      {banner.detail ? (
        <AlertDescription className="font-mono text-2xs leading-snug text-ink-faint">
          {banner.detail}
        </AlertDescription>
      ) : null}
      {banner.action ? (
        /*
          In the body rather than beside the dismiss ✕: the action is an answer
          to the sentence above it ("Continue on Work" under "the 5-hour limit
          is reached"), and the corner is where banners are killed, not where
          they are acted on. Dismissed after running — the offer was about the
          state the banner reported, and acting on it consumes it.
        */
        <AlertDescription>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 border-hairline-strong px-2 font-sans text-2xs text-ink"
            onClick={() => {
              banner.action?.run();
              dismissBanner(banner.id);
            }}
          >
            {banner.action.label}
          </Button>
        </AlertDescription>
      ) : null}
      <AlertAction className="top-1 right-1">
        <IconButton
          label="Dismiss"
          size="icon-xs"
          onClick={() => dismissBanner(banner.id)}
          className="text-current"
        >
          <XIcon />
        </IconButton>
      </AlertAction>
    </Alert>
  );
}
