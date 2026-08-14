/**
 * @vitest-environment jsdom
 *
 * The palette: what resolves it, what it writes, and what keeps answering.
 *
 * Four properties, and they fail in four different places.
 *
 * *Resolution* is the pure part — `'system'` is an instruction, not a palette,
 * and turning it into one is the only place the OS is consulted. Asserted
 * against a fake `matchMedia` in both directions, because a resolver that
 * always returned `'dark'` would look correct on every machine this is likely
 * to be developed on.
 *
 * *Application* is the wiring, and specifically that it writes **both** classes
 * rather than adding one. `index.html` ships `class="dark"` as a deliberate
 * fallback, so a pass that only added `light` would leave both classes on
 * `<html>` — the light palette rendering underneath every `dark:` variant a
 * registry component ships. That reads as a handful of unrelated components
 * being broken and not as a theme bug, which is why it is pinned by name here.
 *
 * *Persistence* is what makes the choice survive a launch, and it goes through
 * the same coercion every other preference does — a value that reaches
 * `classList` is one where a hand-edited blob deserves a guard.
 *
 * *Following* is the one nothing else in the app does: `'system'` has to keep
 * answering after the dialog closes, because machines change appearance on a
 * schedule. The listener is registered once at module load, so the fake
 * `matchMedia` below is installed in a `vi.hoisted` block — it has to exist
 * before the store module is evaluated, not before the first test runs.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/ThemeToggle';
import { DEFAULT_THEME, resolveTheme, setTheme, useApp } from '@/state/store';

/**
 * A `matchMedia` the test can move, installed before the store is imported.
 *
 * jsdom does not implement `matchMedia` at all, so without this the store's
 * listener is never registered and "System follows the OS" would pass by
 * vacuously never being exercised.
 */
const os = vi.hoisted(() => {
  type Listener = (event: { matches: boolean; media: string }) => void;

  // Keyed by query, because this is not the only `matchMedia` caller in the
  // renderer under test — xterm registers one of its own for device pixel
  // ratio, and it reads `event.matches` off what it is handed. Firing every
  // listener for every change would push a colour-scheme answer into it.
  const listeners = new Map<string, Set<Listener>>();
  let dark = true;

  const isColourScheme = (query: string): boolean => query.includes('prefers-color-scheme');

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      // Read per call, not captured: `prefersDark` asks a fresh object every
      // time, which is what lets the answer change between assertions.
      get matches() {
        return isColourScheme(query) ? query.includes('dark') === dark : false;
      },
      media: query,
      addEventListener: (_event: string, fn: Listener) => {
        const set = listeners.get(query) ?? new Set<Listener>();
        set.add(fn);
        listeners.set(query, set);
      },
      removeEventListener: (_event: string, fn: Listener) => {
        listeners.get(query)?.delete(fn);
      },
    }),
  });

  return {
    /** Move the OS and fire its listeners, as a real appearance change would. */
    set(next: boolean): void {
      dark = next;
      for (const [query, set] of listeners) {
        if (!isColourScheme(query)) continue;
        for (const fn of [...set]) fn({ matches: query.includes('dark') === dark, media: query });
      }
    },
  };
});

const PREFS_KEY = 'artemis.prefs.v1';

const classes = (): string[] => [...document.documentElement.classList];
const storedTheme = (): unknown => {
  const raw = globalThis.localStorage.getItem(PREFS_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as { theme?: unknown }).theme;
};

beforeEach(() => {
  os.set(true);
  setTheme(DEFAULT_THEME);
});

afterEach(() => {
  cleanup();
});

describe('resolveTheme', () => {
  it('passes an explicit choice through, whatever the machine says', () => {
    os.set(true);
    expect(resolveTheme('light')).toBe('light');
    os.set(false);
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('follows the machine for "system", in both directions', () => {
    os.set(true);
    expect(resolveTheme('system')).toBe('dark');
    os.set(false);
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('setTheme', () => {
  it('writes the store and the document together', () => {
    setTheme('light');
    expect(useApp.getState().theme).toBe('light');
    expect(classes()).toContain('light');
  });

  /*
   * The regression the `index.html` fallback makes possible. `class="dark"` is
   * on the document before any of this runs, so "add the class that applies"
   * leaves both — and `@custom-variant dark` keys off `.dark` being present.
   */
  it('leaves exactly one palette class behind, never both', () => {
    setTheme('dark');
    expect(classes()).toContain('dark');
    expect(classes()).not.toContain('light');

    setTheme('light');
    expect(classes()).toContain('light');
    expect(classes()).not.toContain('dark');
  });

  it('resolves "system" on the way to the document', () => {
    os.set(false);
    setTheme('system');
    // The stored instruction stays `'system'` — only what is painted resolves.
    expect(useApp.getState().theme).toBe('system');
    expect(classes()).toContain('light');
    expect(classes()).not.toContain('dark');
  });

  it('persists the instruction rather than the resolved palette', () => {
    os.set(false);
    setTheme('system');
    // `'light'` here would be the bug: it would freeze the answer the machine
    // happened to be giving at the moment the user chose to defer to it.
    expect(storedTheme()).toBe('system');

    setTheme('dark');
    expect(storedTheme()).toBe('dark');
  });
});

describe('following the system appearance', () => {
  it('repaints when the OS changes and the choice is "system"', () => {
    setTheme('system');
    expect(classes()).toContain('dark');

    os.set(false);
    expect(classes()).toContain('light');
    expect(classes()).not.toContain('dark');

    os.set(true);
    expect(classes()).toContain('dark');
  });

  /*
   * The half that is easy to leave out. A listener with no guard would drag a
   * user who explicitly chose Light into dark at sunset — the one outcome an
   * explicit choice exists to prevent.
   */
  it('ignores the OS once a palette has been chosen explicitly', () => {
    setTheme('light');
    os.set(true);
    expect(classes()).toContain('light');
    expect(classes()).not.toContain('dark');
  });

  it('starts following again when the choice returns to "system"', () => {
    setTheme('dark');
    os.set(false);
    expect(classes()).toContain('dark');

    setTheme('system');
    expect(classes()).toContain('light');
  });
});

describe('the theme toggle', () => {
  // `TooltipProvider` because the segments are tooltipped like every other
  // control in the header, and Radix's `Tooltip.Root` throws without one — the
  // same contract `ArtemisProviders` satisfies in the running app.
  const renderToggle = (): void => {
    render(
      <TooltipProvider>
        <ThemeToggle />
      </TooltipProvider>,
    );
  };

  const option = (name: string): HTMLElement => screen.getByRole('radio', { name });

  it('offers exactly the three choices, as one radiogroup', () => {
    renderToggle();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeDefined();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('shows which one is in force', () => {
    setTheme('light');
    renderToggle();
    expect(option('Light theme').getAttribute('aria-checked')).toBe('true');
    expect(option('Dark theme').getAttribute('aria-checked')).toBe('false');
  });

  it('changes the palette when a segment is pressed', () => {
    setTheme('dark');
    renderToggle();

    fireEvent.click(option('Light theme'));
    expect(useApp.getState().theme).toBe('light');
    expect(classes()).toContain('light');

    fireEvent.click(option('System theme'));
    expect(useApp.getState().theme).toBe('system');
  });

  /*
   * The segments are icon-only, so the accessible name is the *only* name they
   * have — there is no visible label to fall back on. A screen reader reaching
   * an unnamed one would announce "radio" and nothing else.
   */
  it('names every segment, since none of them carry visible text', () => {
    renderToggle();
    for (const name of ['System theme', 'Light theme', 'Dark theme']) {
      expect(option(name)).toBeDefined();
    }
    // Nothing here renders text; if that changes, the naming contract above
    // stops being the only thing standing between this and an unusable control.
    expect(screen.getByRole('radiogroup').textContent).toBe('');
  });
});
