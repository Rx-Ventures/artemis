/**
 * `menu.ts` reaches for `Menu`, `dialog`, `app` and `BrowserWindow` at import
 * time, so this is the first main-process test that has to stand something in
 * for Electron. Only the two pure exports are exercised; the mock exists to get
 * the module loaded, not to be asserted against.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { name: 'Artemis', getVersion: () => '0.4.0' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: () => undefined },
}));

const { applicationMenuTemplate, checkOutcomeNotice } = await import('./menu');

type Item = { label?: string; role?: string; type?: string; enabled?: boolean; id?: string };

function template(checking = false) {
  return applicationMenuTemplate({ appName: 'Artemis', checking, onCheckForUpdates: () => {} });
}

function submenuOf(label: string, checking = false): Item[] {
  const menu = template(checking).find((entry) => entry.label === label);
  return (menu?.submenu ?? []) as Item[];
}

/** Every role in a submenu, separators dropped. */
function rolesOf(label: string): string[] {
  return submenuOf(label)
    .map((item) => item.role)
    .filter((role): role is string => role !== undefined);
}

describe('applicationMenuTemplate', () => {
  it('puts Check for Updates… in the app menu, under About and above Services', () => {
    const items = submenuOf('Artemis');
    const about = items.findIndex((item) => item.role === 'about');
    const check = items.findIndex((item) => item.id === 'check-for-updates');
    const services = items.findIndex((item) => item.role === 'services');

    expect(check).toBeGreaterThan(about);
    expect(check).toBeLessThan(services);
    expect(items[check]?.label).toBe('Check for Updates…');
  });

  it('calls back when the item is clicked', () => {
    const onCheckForUpdates = vi.fn();
    const items = applicationMenuTemplate({ appName: 'Artemis', checking: false, onCheckForUpdates })
      .find((entry) => entry.label === 'Artemis')?.submenu as { id?: string; click?: () => void }[];

    items.find((item) => item.id === 'check-for-updates')?.click?.();

    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it('disables the item and says so while a check is running', () => {
    const item = submenuOf('Artemis', true).find((entry) => entry.id === 'check-for-updates');
    expect(item?.enabled).toBe(false);
    expect(item?.label).toBe('Checking for Updates…');
  });

  /*
   * The regression this file mostly exists for. Installing any menu at all
   * replaces Electron's default, and on macOS the default is what binds ⌘C,
   * ⌘V, ⌘Z and ⌘A — they are menu items, not something Chromium provides. A
   * template trimmed down to "the app menu, because that is the one I needed"
   * takes copy and paste out of the composer, and nothing about the symptom
   * points back at this file.
   */
  it('keeps the editing roles that carry ⌘C, ⌘V, ⌘Z and ⌘A', () => {
    expect(rolesOf('Edit')).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
    );
  });

  it('keeps the window and quit roles that carry ⌘W, ⌘M and ⌘Q', () => {
    expect(rolesOf('Artemis')).toContain('quit');
    expect(rolesOf('File')).toContain('close');
    expect(rolesOf('Window')).toContain('minimize');
  });

  /*
   * `mod+n` and `mod+,` belong to the renderer's `useHotkeys`. A menu
   * accelerator beats a keydown listener, so a File → New or a Preferences item
   * here would take the key away from the code that implements it.
   */
  it('claims neither ⌘N nor ⌘, from the renderer', () => {
    const labels = template()
      .flatMap((menu) => (menu.submenu ?? []) as Item[])
      .map((item) => `${item.role ?? ''} ${item.label ?? ''}`.toLowerCase());

    expect(labels.some((label) => label.includes('new'))).toBe(false);
    expect(labels.some((label) => label.includes('preferences'))).toBe(false);
  });
});

describe('checkOutcomeNotice', () => {
  it('says nothing when an update was found — the card is the answer', () => {
    expect(checkOutcomeNotice({ kind: 'offered', version: '0.5.0' }, '0.4.0')).toBeNull();
  });

  it('names the running version when there is nothing newer', () => {
    const notice = checkOutcomeNotice({ kind: 'current' }, '0.4.0');
    expect(notice?.message).toBe('Artemis is up to date.');
    expect(notice?.detail).toContain('0.4.0');
  });

  it('points at the network when the feed could not be reached', () => {
    // It used to point at `gh`, which was the only route to a private
    // repository's releases. Public releases need no account, so the advice that
    // can actually help is about reaching github.com at all.
    const detail = checkOutcomeNotice({ kind: 'unreachable' }, '0.4.0')?.detail ?? '';
    expect(detail).toContain('github.com');
    expect(detail).toContain('releases page');
  });

  it('answers every outcome that leaves the screen unchanged', () => {
    // The point of the dialog: these three are indistinguishable from a menu
    // item that did nothing, so none of them may return null.
    for (const kind of ['current', 'unreachable', 'busy', 'unsupported'] as const) {
      expect(checkOutcomeNotice({ kind }, '0.4.0')).not.toBeNull();
    }
  });
});
