/**
 * The agent's hands on the browser the user is watching.
 * ============================================================================
 *
 * `browser.ts` draws a page for a person. This gives the *agent* a way to drive
 * that same page — and the emphasis is on **same**. There is no headless
 * instance and no second window: a tool call navigates the view sitting in the
 * dock, so the user sees each step happen. That was the point of the request
 * this answers, and it is what separates this from wiring up a Playwright MCP
 * server, which would give the agent a browser nobody could see.
 *
 * ## Why an in-process MCP server
 *
 * The Agent SDK's `createSdkMcpServer` builds a server whose tool handlers run
 * **in the process that created it** — which for Artemis is the Electron main
 * process, which is exactly where the `WebContentsView` lives. So a tool call
 * reaches the page through a function call rather than through a socket, a port,
 * or a second copy of Chromium. Nothing is spawned and nothing listens.
 *
 * It also means these tools cannot live in `packages/core`: core must never
 * import `electron` (`no-electron.test.ts` enforces it), and every handler here
 * touches a `webContents`. The seam is `ClaudeAdapterOptions.agentToolServers`,
 * which takes a factory and asks no questions about what is behind it.
 *
 * ## Every call goes through the permission prompt, for free
 *
 * An MCP tool is a tool, so `canUseTool` gates it exactly as it gates `Bash`.
 * The user sees `browser_navigate` with its arguments and allows or denies it,
 * and the existing "always allow this tool" machinery works unchanged. Nothing
 * in this file implements a permission model, and that is the point — a second
 * one would be a second thing to get wrong.
 *
 * ## Targeting is by closure, never by argument
 *
 * The factory is called **per run** and closes over that run's id. A tool
 * therefore acts on the browser belonging to *its own* conversation, and the
 * model has no way to name a different one: there is no `browserId` parameter
 * on any tool here. An agent in the left-hand column cannot drive the page in
 * the right-hand one, and it cannot do so precisely because it cannot say which
 * page it means.
 *
 * ## What is deliberately not here
 *
 * **No `browser_evaluate`.** Handing the model an arbitrary-JavaScript tool
 * would make every other rule in this file decorative — `browser_click` could
 * be spelled as a `fetch`, and the scheme gate in `browserUrlFor` could be
 * stepped around with `location.href`. The tools below are verbs a person could
 * perform on a page, which is the level this belongs at.
 *
 * **No cookie, storage or header access.** The session is shared with the
 * browser the user signs into, so a tool that could read it would be a tool
 * that could read the user's live sessions on any site they had visited here.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { browserUrlFor, type BrowserId, type RunId } from '@rx-artemis/protocol';

import type { BrowserHost } from './browser.js';
import { createLogger } from './log.js';

const log = createLogger('browser-tools');

/**
 * Most text this hands back from one page.
 *
 * A page's readable text, not its markup — see {@link readPage} — so this is
 * generous by the standards of prose and mean by the standards of HTML. The
 * bound matters because the alternative is a documentation page with a hundred
 * code samples arriving as a single tool result and consuming the context the
 * agent needed in order to act on it.
 */
const MAX_TEXT = 40_000;

/** How long a tool waits for a navigation to settle before reporting anyway. */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * What the tools need from the app.
 *
 * An interface rather than the concrete host so this file can be exercised
 * against a fake — the handlers are the interesting part, and standing up a
 * `WebContentsView` to test them would test Electron instead.
 */
export interface BrowserToolContext {
  /** Open a page for this run, returning its id. Reuses one when it exists. */
  ensure(runId: RunId, url: string | undefined): Promise<BrowserId>;
  /** The browser this run is driving, or `null` when it has none yet. */
  current(runId: RunId): BrowserId | null;
  readonly host: Pick<BrowserHost, 'contentsFor' | 'stateFor' | 'navigate'>;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** An MCP tool result carrying one block of text. */
function say(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * A failure the model should read and act on, rather than an exception.
 *
 * MCP distinguishes "the tool threw" from "the tool ran and the answer is no",
 * and almost everything here is the second: a selector that matched nothing, a
 * page that would not load. Throwing would surface a stack trace as the tool
 * result and tell the agent nothing it could use to try something else.
 */
function refuse(text: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { ...say(text), isError: true as const };
}

/* -------------------------------------------------------------------------- */
/* Page access                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The page's readable text, the way a reader would meet it.
 *
 * `innerText` rather than `innerHTML`, and that is the load-bearing choice.
 * Markup is mostly attributes, class names and framework noise — a page whose
 * prose is two kilobytes is routinely four hundred kilobytes of HTML — and the
 * agent is nearly always asking "what does this page say", not "how is it
 * built". `innerText` also honours `display: none`, so it omits what the reader
 * cannot see, which is the same answer a screenshot would give.
 */
const READ_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return '';
  return body.innerText;
})()`;

/**
 * Run one expression in the page and return its value.
 *
 * The single place this file talks to a page's world, kept private so that the
 * set of things a *tool* can ask a page to do stays the list in
 * {@link browserToolServer} — see the header on why there is no `evaluate` tool.
 *
 * `userGesture` is false: these are not clicks by a person, and a page that
 * gates `window.open` or fullscreen on a real gesture should keep gating them.
 */
async function inPage(
  context: BrowserToolContext,
  id: BrowserId,
  expression: string,
): Promise<unknown> {
  const contents = context.host.contentsFor(id);
  if (contents === null) throw new Error('That browser is no longer open.');
  return contents.executeJavaScript(expression, false);
}

/**
 * Wait for the page to stop loading.
 *
 * Bounded, and resolving rather than rejecting on timeout: a page that is still
 * streaming after twenty seconds is usually a page whose useful content arrived
 * nineteen seconds ago and whose analytics beacon is still open. Reporting what
 * is there beats refusing to report anything.
 */
async function settle(context: BrowserToolContext, id: BrowserId): Promise<void> {
  const contents = context.host.contentsFor(id);
  if (contents === null || !contents.isLoading()) return;

  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      contents.off('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    contents.once('did-stop-loading', done);
  });
}

/** Where the page is, for a tool result that says what happened. */
function whereIs(context: BrowserToolContext, id: BrowserId): string {
  const state = context.host.stateFor(id);
  if (state === null) return 'an unknown page';
  return state.title.length > 0 ? `${state.title} (${state.url})` : state.url;
}

/**
 * A CSS selector, as JavaScript source.
 *
 * `JSON.stringify` rather than quotes-and-hope: a selector is model output, it
 * routinely contains quotes (`[data-id="save"]`), and concatenating one into a
 * script is the injection this file would otherwise be full of. This is the
 * only way a selector reaches a page anywhere below.
 */
function asLiteral(value: string): string {
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* The server                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build one run's browser tools.
 *
 * Called once per run by the composition root in `engine.ts`, closing over the
 * run id — see the header on why targeting is a closure rather than a parameter.
 */
export function browserToolServer(runId: RunId, context: BrowserToolContext): McpServerConfig {
  return createSdkMcpServer({
    name: 'artemis-browser',
    version: '1',
    instructions: INSTRUCTIONS,
    tools: browserTools(runId, context),
  });
}

/**
 * The tool definitions themselves, before the SDK packages them.
 *
 * The return type is inferred rather than written out: each tool's `handler`
 * is typed against its own Zod schema, and any annotation broad enough to hold
 * all six would be contravariantly incompatible with every one of them. The
 * inferred union is both more accurate and the thing `createSdkMcpServer`
 * actually accepts.
 *
 * Split from {@link browserToolServer} because `createSdkMcpServer` consumes
 * this list into an opaque `McpServer` — the handlers are reachable through a
 * transport afterwards and not through the object. Keeping the definitions
 * addressable means the decisions in them (what is refused, what reaches a
 * page, and how) can be asserted directly, rather than by standing up an MCP
 * client to ask a fake browser a question.
 */
export function browserTools(runId: RunId, context: BrowserToolContext) {
  /** Resolve the run's browser, or explain that there is not one yet. */
  const required = (): BrowserId => {
    const id = context.current(runId);
    if (id === null) {
      throw new Error('No browser is open for this conversation. Use browser_open first.');
    }
    return id;
  };

  return [
      tool(
        'browser_open',
        'Open the embedded browser tab in the Artemis dock for this ' +
          'conversation, optionally at an address. Reuses the tab if one is ' +
          'already open. The user sees this tab inside the Artemis window — ' +
          'it is not their own browser.',
        { url: z.string().optional().describe('Address to open, e.g. http://localhost:5173') },
        async ({ url }) => {
          if (url !== undefined && browserUrlFor(url) === null) {
            return refuse(`“${url}” is not an http or https address.`);
          }
          try {
            const id = await context.ensure(runId, url);
            await settle(context, id);
            return say(`Browser open at ${whereIs(context, id)}.`);
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),

      tool(
        'browser_navigate',
        'Go to an address in this conversation’s embedded dock browser tab.',
        { url: z.string().describe('Address to open. Must be http or https.') },
        async ({ url }) => {
          try {
            const id = required();
            context.host.navigate(id, url);
            await settle(context, id);
            const state = context.host.stateFor(id);
            if (state?.failure !== undefined) return refuse(state.failure);
            return say(`Now at ${whereIs(context, id)}.`);
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),

      tool(
        'browser_read',
        'Read the visible text of the current page. Cheaper and more reliable ' +
          'than a screenshot for anything that is not about appearance.',
        {},
        async () => {
          try {
            const id = required();
            await settle(context, id);
            const text = await inPage(context, id, READ_SCRIPT);
            const body = typeof text === 'string' ? text : '';
            if (body.trim().length === 0) {
              return say(`${whereIs(context, id)} has no readable text (it may still be rendering).`);
            }
            const clipped = body.length > MAX_TEXT;
            return say(
              `${whereIs(context, id)}\n\n${body.slice(0, MAX_TEXT)}` +
                (clipped ? `\n\n[truncated at ${String(MAX_TEXT)} characters]` : ''),
            );
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),

      tool(
        'browser_screenshot',
        'Capture what the page looks like right now, as an image. Use when the ' +
          'question is about layout or appearance; otherwise use browser_read.',
        {},
        async () => {
          try {
            const id = required();
            await settle(context, id);
            const contents = context.host.contentsFor(id);
            if (contents === null) return refuse('That browser is no longer open.');
            const image = await contents.capturePage();
            if (image.isEmpty()) {
              // A detached view has no surface to capture from, which is what a
              // hidden tab is — say so rather than returning a blank image the
              // model would try to read.
              return refuse(
                'Could not capture the page. The browser tab may be hidden — ask the user to bring it forward.',
              );
            }
            return {
              content: [
                {
                  type: 'image' as const,
                  data: image.toPNG().toString('base64'),
                  mimeType: 'image/png',
                },
              ],
            };
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),

      tool(
        'browser_click',
        'Click the first element matching a CSS selector.',
        { selector: z.string().describe('CSS selector, e.g. button[type="submit"]') },
        async ({ selector }) => {
          try {
            const id = required();
            const clicked = await inPage(
              context,
              id,
              `(() => {
                 const el = document.querySelector(${asLiteral(selector)});
                 if (!el) return false;
                 el.scrollIntoView({ block: 'center' });
                 el.click();
                 return true;
               })()`,
            );
            if (clicked !== true) return refuse(`Nothing matches ${selector} on this page.`);
            // A click very often navigates, so the tool that follows should not
            // have to guess whether it is looking at the old page.
            await settle(context, id);
            return say(`Clicked ${selector}. Now at ${whereIs(context, id)}.`);
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),

      tool(
        'browser_type',
        'Put text into the first input or textarea matching a CSS selector.',
        {
          selector: z.string().describe('CSS selector for an input, textarea or contenteditable'),
          text: z.string().describe('Text to enter. Replaces what is there.'),
        },
        async ({ selector, text }) => {
          try {
            const id = required();
            /*
             * The events matter as much as the value. React, Vue and every
             * other framework listen for `input`; setting `.value` alone
             * updates the DOM and leaves the application's state untouched, so
             * the field looks right and submits empty.
             */
            const typed = await inPage(
              context,
              id,
              `(() => {
                 const el = document.querySelector(${asLiteral(selector)});
                 if (!el) return false;
                 el.focus();
                 if (el.isContentEditable) el.textContent = ${asLiteral(text)};
                 else el.value = ${asLiteral(text)};
                 el.dispatchEvent(new Event('input', { bubbles: true }));
                 el.dispatchEvent(new Event('change', { bubbles: true }));
                 return true;
               })()`,
            );
            if (typed !== true) return refuse(`Nothing matches ${selector} on this page.`);
            return say(`Typed into ${selector}.`);
          } catch (error) {
            return refuse(messageOf(error));
          }
        },
      ),
  ];
}

/**
 * What the model is told this server is for.
 *
 * The second sentence exists because of a real failure: asked to open a page
 * "in my Chrome", an agent used these tools and assured the user it had —
 * the embedded tab looked, from inside the run, like a browser like any
 * other. The instructions are the one place to say whose browser this is
 * *before* that mistake is made, and what to say instead when the user wants
 * their own.
 */
const INSTRUCTIONS =
  'Drives the EMBEDDED browser tab in the Artemis dock — a pane inside the ' +
  'Artemis window itself, which the user can see. This is NOT the user’s ' +
  'own Chrome or default browser: it has none of their logins, extensions or ' +
  'open tabs, and nothing done here appears in their browser. Never tell the ' +
  'user a page was opened in their browser when you used these tools. If the ' +
  'user asks for a page in THEIR browser (e.g. “my Chrome”) and these are ' +
  'your only browser tools, say that this session can only drive the embedded ' +
  'dock browser — they can enable “Browse with your Chrome” or “Open pages ' +
  'in your default browser” under Settings → Permissions. ' +
  'Prefer browser_read over browser_screenshot: it is far cheaper and is ' +
  'usually enough. Reach for a screenshot when the question is about ' +
  'layout, styling, or something that went wrong visually.';

/* -------------------------------------------------------------------------- */
/* The external variant                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The browser tools for a user who prefers their own browser.
 *
 * One tool, same name, same server name. The name is the contract: permission
 * rules and skills address `mcp__artemisBrowser__browser_open`, and a user
 * flipping a preference must not invalidate an allow-list they built under the
 * other mode. What changes is what the tool *does* — the page opens in the
 * user's default browser, with their logins and their password manager —
 * and what is no longer offered: `browser_read`, `browser_screenshot`,
 * `browser_click` and `browser_type` only make sense against a page this
 * process owns, and registering them just to refuse would spend context
 * teaching the model tools it must not use. Absent tools are the honest
 * signal, and the open tool's own description says what became of them.
 */
export function externalBrowserToolServer(
  openExternal: (url: string) => void | Promise<void>,
): McpServerConfig {
  return createSdkMcpServer({
    name: 'artemis-browser',
    version: '1',
    instructions: EXTERNAL_INSTRUCTIONS,
    tools: externalBrowserTools(openExternal),
  });
}

/** The external variant's tool definitions. Addressable for the same reason {@link browserTools} is. */
export function externalBrowserTools(openExternal: (url: string) => void | Promise<void>) {
  return [
    tool(
      'browser_open',
      'Open an address in the user’s own browser, in a new tab they can see. ' +
        'You cannot read, screenshot, or interact with that page — the user has ' +
        'chosen to browse with their own logins. To verify a page yourself, use ' +
        'other means (logs, tests, curl for public pages) or ask the user what ' +
        'they see.',
      { url: z.string().describe('Address to open, e.g. http://localhost:5173') },
      async ({ url }) => {
        // The same gate the embedded browser applies, for the same reason —
        // and with more riding on it: this URL leaves the sandbox for the
        // user's real browser, so a scheme like file: or javascript: must
        // stop here, not there.
        if (browserUrlFor(url) === null) {
          return refuse(`“${url}” is not an http or https address.`);
        }
        try {
          await openExternal(url);
          return say(
            `Opened ${url} in the user’s browser. You cannot see that page; ` +
              'ask the user if you need to know what it shows.',
          );
        } catch (error) {
          return refuse(messageOf(error));
        }
      },
    ),
  ];
}

/** What the model is told when the user prefers their own browser. */
const EXTERNAL_INSTRUCTIONS =
  'Opens pages in the user’s own browser — their logins, their tabs. ' +
  'The page is visible to the user, not to you: there is no way to read or ' +
  'screenshot it from here. Open a page when the user should look at ' +
  'something; verify your own work through logs and tests instead.';

/* -------------------------------------------------------------------------- */
/* Which tools a run gets                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one decision table for a run's browser tools.
 *
 * | `chromeBrowser` | `externalBrowser` | The agent gets                      |
 * |-----------------|-------------------|-------------------------------------|
 * | true            | —                 | nothing from Artemis — the CLI's own Chrome bridge |
 * | false           | true              | the open-only external server       |
 * | false           | false             | the embedded dock browser           |
 *
 * Chrome wins over external because it is the stronger form of the same
 * preference: both mean "the user's own browser", and the bridge can also read
 * what it opened. Handing the CLI's tool set a sibling `browser_open` would
 * give the model two tools with one name's worth of purpose and let it pick
 * the one that cannot see.
 *
 * A function of the input rather than inline in the composition root so the
 * table is testable without Electron — the builders are injected precisely so
 * a test can hand in markers and assert which one was asked for.
 */
export function agentBrowserServers(
  input: { readonly chromeBrowser?: boolean; readonly externalBrowser?: boolean },
  build: {
    readonly embedded: () => McpServerConfig;
    readonly external: () => McpServerConfig;
  },
): Record<string, McpServerConfig> | undefined {
  if (input.chromeBrowser === true) return undefined;
  return { artemisBrowser: input.externalBrowser === true ? build.external() : build.embedded() };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  log.debug('A browser tool failed with a non-Error', error);
  return 'The browser tool failed.';
}
