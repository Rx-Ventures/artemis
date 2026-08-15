/**
 * @vitest-environment jsdom
 *
 * Copying a code block out of an answer.
 *
 * The complaint behind this was "I have to select the SQL by hand", so the
 * assertions are about what a reader can reach and what lands on the clipboard —
 * not about which element the button is nested in.
 *
 * Four of them are load-bearing rather than incidental:
 *
 *  1. **A fenced block gets a control, a backticked word does not.** That split
 *     is the entire reason the override is on `pre` rather than `code`, and it
 *     is invisible in the implementation once you stop looking at the tag names.
 *  2. **What is copied is the block's source**, trailing newline removed. The
 *     parser adds that newline; pasting it into a shell runs the command.
 *  3. **A refused clipboard does not tick.** The regression this guards against
 *     is silent by construction — the tick appears, the paste is stale, and the
 *     button is never suspected. `shared-claude-config.test.tsx` pins the same
 *     rule for the sharing script; it is pinned here too because both now run
 *     through one hook and a change to it would break them together.
 *  4. **Each block copies its own text.** A single shared `copied` flag, or a
 *     button that closes over the first block's source, both pass a one-block
 *     test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Markdown } from './Markdown';

/** Clipboard writes the component actually made. */
let written: string[];
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  written = [];
  writeText = vi.fn((text: string) => {
    written.push(text);
    return Promise.resolve();
  });
  // jsdom has no clipboard at all, and `navigator.clipboard` is not writable,
  // so it is stubbed the way `shared-claude-config.test.tsx` stubs it.
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const copyButtons = (): HTMLElement[] => screen.queryAllByRole('button', { name: 'Copy this code' });

describe('copying a code block', () => {
  it('offers a copy control on a fenced block', () => {
    render(<Markdown>{'```sql\nSELECT 1;\n```'}</Markdown>);
    expect(copyButtons()).toHaveLength(1);
  });

  it('offers nothing on inline code in a sentence', () => {
    render(<Markdown>{'Call `writeText` when you mean it.'}</Markdown>);
    expect(copyButtons()).toHaveLength(0);
  });

  it('copies the block source without the parser’s trailing newline', async () => {
    render(<Markdown>{'```sql\nSELECT 1;\n```'}</Markdown>);
    fireEvent.click(copyButtons()[0]!);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(written).toEqual(['SELECT 1;']);
  });

  it('keeps the indentation inside a block', async () => {
    render(<Markdown>{'```ts\nif (x) {\n  go();\n}\n```'}</Markdown>);
    fireEvent.click(copyButtons()[0]!);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(written[0]).toBe('if (x) {\n  go();\n}');
  });

  it('gives each block its own text', async () => {
    render(<Markdown>{'```\nfirst\n```\n\ntext\n\n```\nsecond\n```'}</Markdown>);
    const buttons = copyButtons();
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(written).toEqual(['second']));
  });

  it('confirms only once the write has resolved', async () => {
    render(<Markdown>{'```\ndone\n```'}</Markdown>);
    fireEvent.click(copyButtons()[0]!);

    // The accessible name is the confirmation: the icon swap is invisible to a
    // screen reader, so the name is what has to change.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('does not confirm a write the clipboard refused', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<Markdown>{'```\nnope\n```'}</Markdown>);
    fireEvent.click(copyButtons()[0]!);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    // Still offering, so the reader can try again rather than being told it worked.
    expect(copyButtons()).toHaveLength(1);
  });

  it('leaves the rendered code alone', () => {
    render(<Markdown>{'```sql\nSELECT 1;\n```'}</Markdown>);
    // The button is a sibling of the `<pre>`, not a child: its label must not
    // become part of the text someone selects and copies by hand.
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toBe('SELECT 1;\n');
  });
});
