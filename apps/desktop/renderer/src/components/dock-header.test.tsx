/**
 * @vitest-environment jsdom
 *
 * Every dock pane's bar is the same height.
 *
 * The defect this replaces was not visible in any one file. `FileViewer` used
 * `px-3 py-1.5`, `BrowserPane` `px-1.5 py-1`, `AgentPane` `px-2 py-1` — each
 * reasonable on its own, and together three different bar heights in a panel
 * that switches between them. The body's top edge moved when you changed tabs,
 * in the one surface whose job is to hold still while you read the conversation
 * beside it.
 *
 * So the assertion is not "the markup looks right" but the thing that was
 * actually wrong: two panes, measured, agree. Padding is deliberately not
 * checked — a bar of text and a bar of icon buttons want different insets, and
 * that was never the problem.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DockHeader } from '@/components/DockHeader';

afterEach(cleanup);

/** The dock's tab strip is `h-7`; the bar under it matches, less its border. */
// 30px is 7D's `.dh` — the dock header grew with the round-eight
// dock/navigator pass (2026-08-30).
const HEIGHT = 'h-[30px]';

describe('DockHeader', () => {
  it('is one fixed height whatever it contains', () => {
    const { rerender } = render(
      <DockHeader>
        <span>a line of text</span>
      </DockHeader>,
    );
    const text = screen.getByText('a line of text').parentElement;
    expect(text?.className).toContain(HEIGHT);

    rerender(
      <DockHeader inset="controls">
        <button type="button">a control</button>
      </DockHeader>,
    );
    const controls = screen.getByText('a control').parentElement;
    expect(controls?.className).toContain(HEIGHT);
  });

  it('centres its contents rather than padding them to a height', () => {
    // This is what makes the height hold: a 20px button and an 11px label both
    // sit in the same bar. Vertical padding would give them different ones,
    // which is precisely how the three originals drifted apart.
    render(<DockHeader>x</DockHeader>);
    const bar = screen.getByText('x');
    expect(bar.className).toContain('items-center');
    expect(bar.className).not.toMatch(/\bpy-/);
  });

  it('varies the inset, because that part legitimately differs', () => {
    const { rerender } = render(<DockHeader>text</DockHeader>);
    expect(screen.getByText('text').className).toContain('px-3');

    rerender(<DockHeader inset="controls">controls</DockHeader>);
    expect(screen.getByText('controls').className).toContain('px-1.5');
  });
});
