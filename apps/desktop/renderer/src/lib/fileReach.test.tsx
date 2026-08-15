/**
 * @vitest-environment jsdom
 *
 * The half of file links that needs a disk: which paths are actually there.
 *
 * `filePaths.test.ts` pins the rule about text and `file-viewer.test.tsx` pins
 * what a reader sees. What is left — and what is worth its own file — is the
 * traffic. This module sits between a paragraph full of backticks and the main
 * process, and three of its decisions are the kind that look like nothing and
 * are felt as either a stutter or a stale link:
 *
 *  - **One request per screenful.** A commit's worth of spans coalesces into a
 *    single `files.check`, because the alternative is a round trip per word.
 *  - **A yes is kept and a no is not.** Scrolling a settled transcript must not
 *    re-stat the same twenty files; a file the agent said it would write must
 *    stop being plain text once it has written it.
 *  - **What re-asks a no is new text, not a clock.** The sweep rides along with
 *    the next flush, so a window nobody is typing into does no work at all.
 *
 * Only `Date` is faked. The flush is a real `setTimeout`, so the batching under
 * test is the batching that ships.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

/** Batches the module asked about, in the order it sent them. */
let checked: string[][];
/** Which paths the fake disk has a file at. Mutable mid-test, which is the point. */
let onDisk: Set<string>;
/** Set for the one test about a main process that is not answering. */
let fail = false;

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    files: {
      check: async ({ paths }: { paths: string[] }) => {
        checked.push([...paths]);
        if (fail) return { ok: false, error: { code: 'transport', message: 'no' } };
        return { ok: true, value: { reachable: paths.filter((path) => onDisk.has(path)) } };
      },
    },
  },
});

const { resetFileReach, useReachableFile } = await import('./fileReach');

function One({ path }: { readonly path: string }): ReactElement {
  return <span data-testid={path}>{useReachableFile(path) ? 'link' : 'text'}</span>;
}

function Probe({ paths }: { readonly paths: readonly string[] }): ReactElement {
  return (
    <>
      {paths.map((path) => (
        <One key={path} path={path} />
      ))}
    </>
  );
}

/** Let the flush's `setTimeout(…, 0)` and the reply that follows it land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function verdict(path: string): string {
  return screen.getByTestId(path).textContent ?? '';
}

beforeEach(() => {
  checked = [];
  fail = false;
  onDisk = new Set(['/p/a.ts']);
  resetFileReach();
  // Only `Date`: the flush below is a real timer, so what is under test is the
  // coalescing that actually ships rather than a scheduler the test invented.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('asking about paths', () => {
  it('coalesces a commit’s worth of spans into one request', async () => {
    render(<Probe paths={['/p/a.ts', '/p/b.ts', '/p/c.ts']} />);
    await settle();

    expect(checked).toEqual([['/p/a.ts', '/p/b.ts', '/p/c.ts']]);
    expect(verdict('/p/a.ts')).toBe('link');
    expect(verdict('/p/b.ts')).toBe('text');
  });

  it('asks about a path once, however many spans name it', async () => {
    render(<Twice />);
    await settle();

    expect(checked).toEqual([['/p/a.ts']]);
    expect(screen.getByTestId('twice').textContent).toBe('link');
  });

  it('splits a batch larger than one request will carry, and sends the rest', async () => {
    const many = Array.from({ length: 260 }, (_, i) => `/p/f${String(i)}.ts`);
    render(<Probe paths={many} />);
    await settle();
    // The second request goes out behind the first rather than being dropped,
    // which is the difference between a slow link and a permanently plain one.
    await settle();

    expect(checked).toHaveLength(2);
    expect(checked[0]).toHaveLength(256);
    expect(checked[1]).toHaveLength(4);
  });

  it('says nothing is a link until an answer comes back', () => {
    render(<Probe paths={['/p/a.ts']} />);
    // Before the round trip, and this is the direction it must fail in: a link
    // that appeared and was taken away is one the reader may already have clicked.
    expect(verdict('/p/a.ts')).toBe('text');
  });

  it('treats a main process that will not answer as “not there”', async () => {
    fail = true;
    render(<Probe paths={['/p/a.ts']} />);
    await settle();

    expect(verdict('/p/a.ts')).toBe('text');
    // And does not spin on it: one failed request, not a retry loop.
    expect(checked).toHaveLength(1);
  });
});

describe('what is remembered, and for how long', () => {
  it('keeps a yes, so scrolling back does not re-ask', async () => {
    render(<Probe paths={['/p/a.ts']} />);
    await settle();
    cleanup();

    render(<Probe paths={['/p/a.ts']} />);
    await settle();

    expect(checked).toHaveLength(1);
    expect(verdict('/p/a.ts')).toBe('link');
  });

  it('keeps a fresh no too, so a paragraph of prose is not a round trip a second', async () => {
    render(<Probe paths={['/p/b.ts']} />);
    await settle();

    // A new answer arrives moments later. `/p/b.ts` was just asked about, so it
    // rides on the cached no rather than on a second stat.
    render(<Probe paths={['/p/c.ts']} />);
    await settle();

    expect(checked).toEqual([['/p/b.ts'], ['/p/c.ts']]);
  });

  /*
   * The case the staleness rule exists for: an agent naming a file one turn
   * before it writes it. Without this the path is plain text for the rest of
   * the session, which reads as the feature being broken.
   */
  it('re-asks a stale no when new text arrives, and links it once it is there', async () => {
    render(<Probe paths={['/p/b.ts']} />);
    await settle();
    expect(verdict('/p/b.ts')).toBe('text');

    // The agent goes away and writes the file.
    onDisk.add('/p/b.ts');
    vi.setSystemTime(new Date('2026-08-15T00:01:00Z'));

    // …and says something else, which is what flushes.
    render(<Probe paths={['/p/c.ts']} />);
    await settle();

    expect(checked[1]).toContain('/p/b.ts');
    expect(screen.getAllByTestId('/p/b.ts')[0]?.textContent).toBe('link');
  });

  it('does not go looking on its own, however long nothing happens', async () => {
    render(<Probe paths={['/p/b.ts']} />);
    await settle();

    onDisk.add('/p/b.ts');
    vi.setSystemTime(new Date('2026-08-15T01:00:00Z'));
    await settle();

    // An hour later and no further text: a transcript nobody is adding to costs
    // nothing. The re-check rides on the next answer, not on a clock.
    expect(checked).toHaveLength(1);
  });

  it('leaves an unmounted path out of the sweep', async () => {
    render(<Probe paths={['/p/b.ts']} />);
    await settle();
    cleanup();

    vi.setSystemTime(new Date('2026-08-15T00:01:00Z'));
    render(<Probe paths={['/p/c.ts']} />);
    await settle();

    // `/p/b.ts` is off screen. Re-checking it would be work for a span that no
    // longer exists to be re-rendered.
    expect(checked[1]).toEqual(['/p/c.ts']);
  });
});

/** Two spans naming one path — an answer mentioning the same file twice. */
function Twice(): ReactElement {
  const first = useReachableFile('/p/a.ts');
  const second = useReachableFile('/p/a.ts');
  return <span data-testid="twice">{first && second ? 'link' : 'text'}</span>;
}
