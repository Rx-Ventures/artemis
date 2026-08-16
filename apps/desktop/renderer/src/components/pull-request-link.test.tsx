/**
 * @vitest-environment jsdom
 *
 * What happens to a link in an answer when it points at a pull request.
 *
 * The behaviour worth pinning is mostly a *non*-behaviour: every link still
 * renders as the anchor it was. This feature adds a hover card and must not
 * change what a link is, because the failure mode of the whole thing — no `gh`,
 * no sign-in, no network — has to be the link you already had (#130).
 *
 * The two halves are asserted separately:
 *
 *  1. **The wiring**, here. A PR link gains a trigger and every other link does
 *     not, and both keep their `href` and their text. Driving Radix's hover
 *     timers in jsdom to assert card *contents* would be a test of Radix.
 *  2. **The reading**, in `main/github.test.ts`, against fixtures of real `gh`
 *     output — which is where the judgement actually lives.
 *
 * `parsePullRequestUrl` decides which links are which, and it has its own file
 * in the protocol package. The cases here are the ones that would break if the
 * component stopped calling it, not a second copy of its table.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Markdown } from './Markdown';
import { resetPullRequests } from '../lib/pullRequests';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

afterEach(() => {
  cleanup();
  resetPullRequests();
});

function draw(markdown: string): void {
  render(
    <TooltipProvider delayDuration={0}>
      <Markdown>{markdown}</Markdown>
    </TooltipProvider>,
  );
}

describe('a link that is a pull request', () => {
  it('is still an anchor, pointing where it did', () => {
    draw('Opened [#141](https://github.com/Rx-Ventures/artemis/pull/141) just now.');

    const link = screen.getByRole('link', { name: '#141' });
    expect(link.getAttribute('href')).toBe('https://github.com/Rx-Ventures/artemis/pull/141');
  });

  it('carries a hover trigger', () => {
    draw('[#141](https://github.com/Rx-Ventures/artemis/pull/141)');

    // Radix marks its trigger on the element it was given via `asChild`, which
    // is the anchor itself — so this asserts the card is reachable from the
    // link without asserting anything about when Radix decides to open it.
    const link = screen.getByRole('link', { name: '#141' });
    expect(link.getAttribute('data-slot')).toBe('tooltip-trigger');
  });

  it('works on an autolinked bare URL, which is how an agent writes one', () => {
    // remark-gfm turns a bare URL into an anchor, and that is overwhelmingly
    // the form these arrive in — an agent pastes the URL, it does not write
    // markdown link syntax around it.
    draw('Opened https://github.com/Rx-Ventures/artemis/pull/141 just now.');

    const link = screen.getByRole('link');
    expect(link.getAttribute('data-slot')).toBe('tooltip-trigger');
  });

  it('recognises the sub-page forms', () => {
    draw('[files](https://github.com/o/r/pull/7/files)');

    expect(screen.getByRole('link').getAttribute('data-slot')).toBe('tooltip-trigger');
  });
});

describe('every other link', () => {
  it('is untouched', () => {
    draw('See [the docs](https://example.com/guide) for more.');

    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/guide');
    expect(link.getAttribute('data-slot')).toBeNull();
  });

  it('includes GitHub pages that are not pull requests', () => {
    draw('[an issue](https://github.com/Rx-Ventures/artemis/issues/146)');

    expect(screen.getByRole('link').getAttribute('data-slot')).toBeNull();
  });

  it('includes a host that merely looks like GitHub', () => {
    // The anchored-pattern case, asserted here too because this is the layer a
    // reader would actually be fooled at.
    draw('[nope](https://github.com.evil.example/o/r/pull/1)');

    expect(screen.getByRole('link').getAttribute('data-slot')).toBeNull();
  });

  it('does not set target, so Electron opens it once', () => {
    // `security.ts` intercepts navigation and hands it to `shell.openExternal`.
    // A `target="_blank"` would ask for a second window on the way to the same
    // place.
    draw('[#141](https://github.com/Rx-Ventures/artemis/pull/141) and [docs](https://example.com)');

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBeNull();
    }
  });
});
