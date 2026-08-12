/**
 * The bug report URL builder.
 *
 * What matters here is that a report survives the trip: the fields land in the
 * query string the GitHub form reads, the optional ones stay out when empty, and
 * — the case with teeth — a long report produces a URL that is under the length
 * GitHub refuses rather than one that 414s on arrival. The ceiling is enforced by
 * measuring the assembled URL, so these tests measure it too.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_URL_LENGTH,
  buildIssueUrl,
  composeIssueBody,
  isSubmittable,
  platformLabel,
} from './bugReport';

const DIAGNOSTICS = { version: '0.6.0', platform: 'darwin' } as const;

const draft = (patch: Partial<Parameters<typeof buildIssueUrl>[0]> = {}) => ({
  title: 'Dock tab loses focus',
  whatHappened: 'Resizing the dock moves focus to the transcript.',
  steps: '',
  includeDiagnostics: true,
  ...patch,
});

/** The `body` parameter as GitHub would read it back off the query string. */
function bodyOf(url: string): string {
  return new URL(url).searchParams.get('body') ?? '';
}

describe('isSubmittable', () => {
  it('requires a title and a description, neither of them blank', () => {
    expect(isSubmittable(draft())).toBe(true);
    expect(isSubmittable(draft({ title: '   ' }))).toBe(false);
    expect(isSubmittable(draft({ whatHappened: '' }))).toBe(false);
    // Steps are optional on purpose: a bug nobody can reproduce on demand is
    // still worth filing.
    expect(isSubmittable(draft({ steps: '' }))).toBe(true);
  });
});

describe('platformLabel', () => {
  it('names the platform the way a person would write it', () => {
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('linux')).toBe('Linux');
  });
});

describe('composeIssueBody', () => {
  it('carries the description, the steps and the environment', () => {
    const body = composeIssueBody(draft({ steps: '1. Drag the divider' }), DIAGNOSTICS);
    expect(body).toContain('Resizing the dock moves focus');
    expect(body).toContain('## Steps to reproduce');
    expect(body).toContain('1. Drag the divider');
    expect(body).toContain('Artemis 0.6.0');
    expect(body).toContain('macOS');
  });

  it('omits the steps heading entirely when there are none', () => {
    const body = composeIssueBody(draft({ steps: '   ' }), DIAGNOSTICS);
    expect(body).not.toContain('Steps to reproduce');
  });

  it('omits the environment when the reporter unchecked it', () => {
    const body = composeIssueBody(draft({ includeDiagnostics: false }), DIAGNOSTICS);
    expect(body).not.toContain('Artemis 0.6.0');
    expect(body).not.toContain('## Environment');
  });

  it('says so rather than lying when the version is not known', () => {
    const body = composeIssueBody(draft(), { version: '', platform: 'linux' });
    expect(body).toContain('Artemis unknown');
  });
});

describe('buildIssueUrl', () => {
  it('points at the org repository, prefilled and labelled', () => {
    const { url, trimmed } = buildIssueUrl(draft(), DIAGNOSTICS);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/Rx-Ventures/artemis/issues/new');
    expect(parsed.searchParams.get('title')).toBe('Dock tab loses focus');
    expect(parsed.searchParams.get('labels')).toBe('bug');
    expect(bodyOf(url)).toContain('Resizing the dock moves focus');
    expect(trimmed).toBe(false);
  });

  it('trims the title of stray whitespace', () => {
    const { url } = buildIssueUrl(draft({ title: '  spaced  ' }), DIAGNOSTICS);
    expect(new URL(url).searchParams.get('title')).toBe('spaced');
  });

  it('leaves an ordinary report untrimmed', () => {
    const { url, trimmed } = buildIssueUrl(
      draft({ whatHappened: 'x'.repeat(1500), steps: 'y'.repeat(500) }),
      DIAGNOSTICS,
    );
    expect(trimmed).toBe(false);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('keeps a very long report under the ceiling, and says it trimmed it', () => {
    const long = 'The dock detaches whenever I resize the window. '.repeat(400);
    const { url, body, trimmed } = buildIssueUrl(draft({ whatHappened: long }), DIAGNOSTICS);

    expect(trimmed).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    // The untrimmed body comes back for the clipboard, so nothing the user typed
    // is lost by the trim itself.
    expect(body).toContain(long.trim());
    expect(bodyOf(url)).toContain('Trimmed to fit');
    expect(bodyOf(url).length).toBeLessThan(body.length);
  });

  it('holds the ceiling when the text is all multi-byte characters', () => {
    // Percent encoding is where a naive character count goes wrong: one of these
    // costs nine characters of URL, not one.
    const { url, trimmed } = buildIssueUrl(
      draft({ whatHappened: '🔭'.repeat(2000) }),
      DIAGNOSTICS,
    );
    expect(trimmed).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('holds the ceiling when the title is enormous too', () => {
    const { url } = buildIssueUrl(
      draft({ title: 'T'.repeat(400), whatHappened: 'W'.repeat(9000) }),
      DIAGNOSTICS,
    );
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });
});
