/**
 * @vitest-environment jsdom
 *
 * The bug report card and its form.
 *
 * Two things are worth pinning. The first is placement, for the reason
 * the update chip's tests give about the row it replaced: this card is the only place
 * the app offers to report anything, and a card that silently stopped being
 * mounted looks exactly like an app nobody has bugs with. So the sidebar case
 * asserts it is *there*, unconditionally — no update pushed, nothing pending.
 *
 * The second is the hand-off. Nothing here files an issue; the whole mechanism is
 * a link to GitHub's own form, so the assertions follow the link: it appears only
 * when there is something to send, and its `href` carries the fields the reporter
 * typed. That is the contract with `lib/bugReport.ts`, which owns the URL and is
 * unit-tested on its own.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { BugReportCard } from '@/components/BugReportCard';
import { Sidebar } from '@/components/Sidebar';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

function renderCard() {
  return render(
    <TooltipProvider>
      <BugReportCard />
    </TooltipProvider>,
  );
}

/** Open the form and hand back the fields, found the way a reporter would. */
async function openForm() {
  renderCard();
  await act(async () => {
    screen.getByRole('button', { name: 'Report a bug' }).click();
  });
  return {
    title: screen.getByLabelText('Summary'),
    what: screen.getByLabelText('What happened'),
    steps: screen.getByLabelText(/Steps to reproduce/),
  };
}

/** Type into a controlled field. */
function type(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

/** The prefilled `body`, as GitHub would read it back off the link. */
function bodyOfLink(): string {
  const href = screen.getByRole('link', { name: /Continue on GitHub/ }).getAttribute('href') ?? '';
  return new URL(href).searchParams.get('body') ?? '';
}

beforeEach(() => {
  seedApp({ cwd: '/w', sessions: [], sidebarCollapsed: false, version: '0.6.0', platform: 'darwin' });
});

afterEach(cleanup);

describe('BugReportCard', () => {
  it('sits in the sidebar with nothing pending', async () => {
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    await act(async () => {});
    // Unconditional: no update was pushed and no state was seeded for it.
    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeTruthy();
  });

  it('opens the form on click and closes it on cancel', async () => {
    await openForm();
    expect(screen.getByRole('dialog')).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('will not hand off until there is a summary and a description', async () => {
    const fields = await openForm();
    // A disabled button rather than a link: an anchor cannot be disabled, so the
    // component swaps the element rather than styling one to look inert.
    expect(screen.getByRole('button', { name: /Continue on GitHub/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Continue on GitHub/ })).toBeNull();

    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
    });
    expect(screen.queryByRole('link', { name: /Continue on GitHub/ })).toBeNull();

    await act(async () => {
      type(fields.what, 'Focus jumps to the transcript when I resize.');
    });
    expect(screen.getByRole('link', { name: /Continue on GitHub/ })).toBeTruthy();
  });

  it('carries the typed fields into the GitHub link', async () => {
    const fields = await openForm();
    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
      type(fields.what, 'Focus jumps to the transcript when I resize.');
      type(fields.steps, '1. Drag the divider');
    });

    const href = screen.getByRole('link', { name: /Continue on GitHub/ }).getAttribute('href') ?? '';
    const parsed = new URL(href);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://github.com/seth-torrence/artemis/issues/new',
    );
    expect(parsed.searchParams.get('title')).toBe('Dock tab loses focus');
    expect(parsed.searchParams.get('labels')).toBe('bug');
    const body = parsed.searchParams.get('body') ?? '';
    expect(body).toContain('Focus jumps to the transcript');
    expect(body).toContain('1. Drag the divider');
  });

  it('includes the environment by default and drops it when unchecked', async () => {
    const fields = await openForm();
    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
      type(fields.what, 'Focus jumps.');
    });
    expect(bodyOfLink()).toContain('Artemis 0.6.0');
    expect(bodyOfLink()).toContain('macOS');

    await act(async () => {
      screen.getByRole('checkbox').click();
    });
    expect(bodyOfLink()).not.toContain('Artemis 0.6.0');
  });

  it('opens externally rather than navigating this window', async () => {
    const fields = await openForm();
    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
      type(fields.what, 'Focus jumps.');
    });
    // `main/security.ts` routes an external target to the system browser and
    // refuses to navigate the window; `_blank` is what puts it on that path.
    const link = screen.getByRole('link', { name: /Continue on GitHub/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('warns before the click when the report is too long for a link', async () => {
    const fields = await openForm();
    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
      type(fields.what, 'The dock detaches whenever I resize the window. '.repeat(400));
    });
    // Said while they are still typing, not after the form has closed.
    expect(screen.getByText(/full text will be copied to your clipboard/)).toBeTruthy();
  });

  it('closes after handing off', async () => {
    const fields = await openForm();
    await act(async () => {
      type(fields.title, 'Dock tab loses focus');
      type(fields.what, 'Focus jumps.');
    });
    await act(async () => {
      screen.getByRole('link', { name: /Continue on GitHub/ }).click();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
