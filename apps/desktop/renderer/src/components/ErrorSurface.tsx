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
 */

import type { ReactElement } from 'react';
import { InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';

import { dismissBanner, useApp, type Banner } from '../state/store';
import { IconButton } from './disabled-reason';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export function ErrorSurface(): ReactElement | null {
  const banners = useApp((s) => s.banners);
  if (banners.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-px border-b border-line">
      {banners.map((banner) => (
        <BannerRow key={banner.id} banner={banner} />
      ))}
    </div>
  );
}

/**
 * Error still carries its colour; warning no longer does.
 *
 * Not because amber is unusable — it is fine again under a cool accent — but
 * because of what these rows *are*. They are full-bleed and they stack, so a
 * tint here is not a badge, it is the top of the window changing colour. Half
 * the things that raise a warning are ordinary and momentary (an unsupported
 * setting, a directory that is not set yet), and none of them are worth
 * repainting the chrome for.
 *
 * `--signal` keeps its fill because an error is not momentary: something
 * already failed, the row is the only record of it, and rose is 45° from amber
 * so the two never blur.
 *
 * Neutral surface, brighter ink than `info`, and the triangle in amber. Three
 * distinguishable rows and one tinted one: rose fill for error, plain fill and
 * full-strength ink for warning, plain fill and muted ink for information.
 */
const LEVEL_STYLES: Record<Banner['level'], string> = {
  error: 'bg-signal/10 text-signal',
  warn: 'bg-raised text-ink',
  info: 'bg-raised text-ink-muted',
};

function BannerRow({ banner }: { readonly banner: Banner }): ReactElement {
  return (
    <Alert
      // Square, borderless and full-bleed: these stack into a strip under the
      // top bar, and a rounded card per banner would read as a pile of toasts.
      className={cn('rounded-none border-0 px-3 py-1.5', LEVEL_STYLES[banner.level])}
    >
      {banner.level === 'info' ? (
        <InfoIcon />
      ) : (
        // The error row is already rose end to end, so its triangle inherits.
        // The warning row is neutral now, which makes this the only thing
        // carrying the level.
        <TriangleAlertIcon className={banner.level === 'warn' ? 'text-amber' : undefined} />
      )}
      <AlertTitle className="font-mono text-2xs leading-snug break-words whitespace-normal">
        {banner.message}
      </AlertTitle>
      {banner.detail ? (
        <AlertDescription className="font-mono text-2xs leading-snug text-ink-faint">
          {banner.detail}
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
