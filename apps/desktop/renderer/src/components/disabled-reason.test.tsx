/**
 * @vitest-environment jsdom
 *
 * The disabled-with-reason affordance is a design *rule* — a control that
 * cannot be used always says why — so it gets a test rather than a promise.
 * These assertions are the rule written down: if a future refactor makes a
 * disabled button silent, or lets an "explained" button actually fire, this
 * fails.
 */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconButton, ReasonButton, WithReason } from '@/components/disabled-reason';

/**
 * Plain DOM assertions rather than `@testing-library/jest-dom`'s matchers —
 * the matcher package is not a dependency of this repo and one boolean
 * property does not justify adding it.
 */
function isNativelyDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled;
}

/*
 * Radix positions floating content with Floating UI, which observes the
 * trigger's box. jsdom implements neither observer, and without them the
 * tooltip throws on open instead of rendering.
 */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

afterEach(cleanup);

describe('ReasonButton', () => {
  it('renders a plain, enabled button when nothing is wrong', () => {
    const onClick = vi.fn();
    mount(<ReasonButton onClick={onClick}>Run</ReasonButton>);

    const button = screen.getByRole('button', { name: 'Run' });
    expect(isNativelyDisabled(button)).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('defaults to type="button" so a toolbar control cannot submit a form', () => {
    mount(<ReasonButton>Run</ReasonButton>);
    expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('type', 'button');
  });

  it('lets the caller opt back into a submit button', () => {
    mount(<ReasonButton type="submit">Save</ReasonButton>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('type', 'submit');
  });

  it('ignores a reason while the button is still enabled', async () => {
    mount(<ReasonButton disabledReason="Not while a run is live.">Fork</ReasonButton>);

    const button = screen.getByRole('button', { name: 'Fork' });
    expect(button.getAttribute('aria-disabled')).toBeNull();

    fireEvent.focus(button);
    expect(screen.queryByText('Not while a run is live.')).toBeNull();
  });

  it('explains itself on focus when disabled with a reason', async () => {
    mount(
      <ReasonButton disabled disabledReason="Codex does not support forking a session.">
        Fork
      </ReasonButton>,
    );

    const button = screen.getByRole('button', { name: 'Fork' });

    // Deliberately NOT the native attribute: a `disabled` button takes no
    // focus and fires no pointer events, so the explanation could never be
    // reached. See the module header for the full argument.
    expect(isNativelyDisabled(button)).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');

    fireEvent.focus(button);
    expect(
      await screen.findAllByText('Codex does not support forking a session.'),
    ).not.toHaveLength(0);
  });

  it('swallows activation while disabled with a reason', () => {
    const onClick = vi.fn();
    mount(
      <ReasonButton disabled disabledReason="No provider is available yet." onClick={onClick}>
        Fork
      </ReasonButton>,
    );

    // Covers Enter and Space too: both dispatch a click on a focused button.
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the native disabled attribute when there is nothing to explain', () => {
    mount(<ReasonButton disabled>Fork</ReasonButton>);
    expect(isNativelyDisabled(screen.getByRole('button', { name: 'Fork' }))).toBe(true);
  });

  it('renders exactly one element, so it cannot disturb a flex toolbar', () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <ReasonButton disabled disabledReason="Nope.">
          Fork
        </ReasonButton>
      </TooltipProvider>,
    );
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild?.tagName).toBe('BUTTON');
  });
});

describe('IconButton', () => {
  it('uses its label as both accessible name and tooltip', async () => {
    mount(<IconButton label="Copy run id" />);

    const button = screen.getByRole('button', { name: 'Copy run id' });
    fireEvent.focus(button);
    expect(await screen.findAllByText('Copy run id')).not.toHaveLength(0);
  });

  it('prefers the reason over the label once disabled', async () => {
    mount(<IconButton label="Fork" disabled disabledReason="Forking is unavailable here." />);

    fireEvent.focus(screen.getByRole('button', { name: 'Fork' }));
    expect(await screen.findAllByText('Forking is unavailable here.')).not.toHaveLength(0);
  });
});

describe('WithReason', () => {
  it('adds nothing to the DOM when there is no reason', () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <WithReason>
          <input aria-label="Key" />
        </WithReason>
      </TooltipProvider>,
    );
    expect(container.firstElementChild?.tagName).toBe('INPUT');
  });

  it('wraps a natively disabled control in a focusable trigger', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WithReason reason="Claude Code has no switch for this.">
          <input aria-label="Key" disabled />
        </WithReason>
      </TooltipProvider>,
    );

    const wrapper = document.querySelector('[data-slot="reason-wrapper"]');
    expect(wrapper).not.toBeNull();
    // The disabled input is out of the tab order, so the wrapper takes its
    // place rather than adding a second stop.
    expect(wrapper?.getAttribute('tabindex')).toBe('0');

    fireEvent.focus(wrapper as Element);
    expect(await screen.findAllByText('Claude Code has no switch for this.')).not.toHaveLength(0);
  });
});
