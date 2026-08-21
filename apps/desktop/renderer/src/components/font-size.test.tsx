/**
 * @vitest-environment jsdom
 *
 * Text size: the clamp, the stepper, and the variable that actually resizes the app.
 *
 * Three things are worth pinning here, and they fail in different places.
 *
 * The clamp is the safety property. `--font-scale` is written straight onto
 * `<html>`, so an out-of-range value is not a cosmetic bug — it is a window the
 * user may not be able to read well enough to open settings and undo. The store
 * clamps on the way in from preferences *and* in the setter, and both are
 * asserted, because the preferences path is the one a hand edit or a downgrade
 * reaches without going through a button.
 *
 * The stepper is the behavioural property: the buttons move the store, and at
 * the bounds they stop while staying present and explained. `ReasonButton` does
 * not use the native `disabled` attribute when it has a reason to give — it
 * swallows the activation instead — so "does nothing" has to be asserted by
 * clicking and checking the value, not by asserting the attribute.
 *
 * The variable is the wiring property. Everything else can be right and the app
 * still not resize if nothing reaches the document; `index.css` reads exactly
 * one custom property and this is the test that says so by name.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* Radix's slider (the handoff thresholds) needs an observer jsdom lacks. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

import { TooltipProvider } from '@/components/ui/tooltip';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  clampFontSize,
  fontScale,
  setFontSize,
  useApp,
} from '@/state/store';

function renderPane(): void {
  render(
    <TooltipProvider>
      <AppearanceSection />
    </TooltipProvider>,
  );
}

const smaller = (): HTMLElement => screen.getByRole('button', { name: 'Smaller text' });
const larger = (): HTMLElement => screen.getByRole('button', { name: 'Larger text' });

function scaleOnDocument(): string {
  return document.documentElement.style.getPropertyValue('--font-scale');
}

beforeEach(() => {
  setFontSize(FONT_SIZE_DEFAULT);
});

afterEach(() => {
  cleanup();
});

describe('clampFontSize', () => {
  it('keeps a size inside the bounds', () => {
    expect(clampFontSize(FONT_SIZE_MIN - 5)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(FONT_SIZE_MAX + 40)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(16)).toBe(16);
  });

  it('rounds, so a stored fraction cannot produce a half-pixel scale', () => {
    expect(clampFontSize(15.4)).toBe(15);
    expect(clampFontSize(15.6)).toBe(16);
  });

  /*
   * The preferences blob is JSON that a hand edit or an older build can shape
   * however it likes. `Number.isFinite` does not coerce, so a numeric *string*
   * is rejected here rather than reaching `calc()` as `NaN` — which would
   * resolve to an invalid declaration and drop the app back to 100% silently.
   */
  it('falls back to the default for anything that is not a real number', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize('16' as unknown as number)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(null as unknown as number)).toBe(FONT_SIZE_DEFAULT);
  });
});

describe('fontScale', () => {
  it('is exactly 1 at the default, so an unset variable means unchanged', () => {
    expect(fontScale(FONT_SIZE_DEFAULT)).toBe(1);
  });

  it('is the ratio to the default', () => {
    expect(fontScale(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX / FONT_SIZE_DEFAULT);
    expect(fontScale(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN / FONT_SIZE_DEFAULT);
  });

  /*
   * The clamp lives inside `fontScale`, not only in the setter, so the ratio a
   * caller gets can never describe a size the app refuses to be set to.
   */
  it('clamps before dividing, so an out-of-range size cannot escape as a ratio', () => {
    expect(fontScale(999)).toBe(FONT_SIZE_MAX / FONT_SIZE_DEFAULT);
    expect(fontScale(1)).toBe(FONT_SIZE_MIN / FONT_SIZE_DEFAULT);
  });
});

describe('setFontSize', () => {
  it('writes the store and the document together', () => {
    setFontSize(16);
    expect(useApp.getState().fontSize).toBe(16);
    expect(scaleOnDocument()).toBe(String(16 / FONT_SIZE_DEFAULT));
  });

  it('clamps before it reaches the document', () => {
    setFontSize(999);
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_MAX);
    expect(scaleOnDocument()).toBe(String(FONT_SIZE_MAX / FONT_SIZE_DEFAULT));
  });
});

describe('the Appearance stepper', () => {
  it('reports the current size', () => {
    setFontSize(15);
    renderPane();
    expect(screen.getByText('15px')).toBeDefined();
  });

  it('steps one pixel at a time in both directions', () => {
    renderPane();

    fireEvent.click(larger());
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_DEFAULT + 1);

    fireEvent.click(smaller());
    fireEvent.click(smaller());
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_DEFAULT - 1);
  });

  /*
   * At the bound the button stays in the DOM and stays findable — that is the
   * point of `ReasonButton` over a plain `disabled` — so the assertion that it
   * has stopped working is that the value did not move.
   */
  it('stops at the maximum without removing the control', () => {
    setFontSize(FONT_SIZE_MAX);
    renderPane();

    expect(larger().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(larger());
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_MAX);
  });

  it('stops at the minimum without removing the control', () => {
    setFontSize(FONT_SIZE_MIN);
    renderPane();

    expect(smaller().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(smaller());
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_MIN);
  });

  it('resets to the default, and offers no reset once there', () => {
    setFontSize(FONT_SIZE_MAX);
    renderPane();

    fireEvent.click(screen.getByRole('button', { name: 'Reset text size' }));
    expect(useApp.getState().fontSize).toBe(FONT_SIZE_DEFAULT);
    expect(scaleOnDocument()).toBe('1');
    expect(screen.getByRole('button', { name: 'Reset text size' }).getAttribute('aria-disabled')).toBe('true');
  });
});
