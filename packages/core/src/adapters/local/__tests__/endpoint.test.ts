/**
 * Reaching the server a profile actually names.
 * ============================================================================
 *
 * The three local providers are the only ones whose identity is an address
 * rather than an account, and every failure this file pins was a way of
 * ignoring that address:
 *
 *  - **The probe read the flavour's default.** A profile on any other port was
 *    reported unavailable — "nothing is answering at 127.0.0.1:8080" — while
 *    `listModels`, which did honour the profile, listed its models happily.
 *    Two answers to one question, and the wrong one was the one on screen.
 *  - **Nothing sent a key.** `llama-server --api-key` refuses `/v1/models` and
 *    `/v1/chat/completions` alike, so a server with one configured could not be
 *    reached at all, and the refusal arrived as an empty model picker.
 *  - **A refusal read as an absence.** 401 told the user to start a server that
 *    was already running.
 *
 * These drive the adapter through a real local HTTP server rather than a
 * stubbed `fetch`, because the thing under test is what goes out on the wire —
 * a header, a path, an origin — and a stub would be asserting that the test's
 * own idea of the request matches the test's own idea of the request.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalAdapter, LLAMA_CPP, API_KEY_ENV, BASE_URL_ENV } from '../adapter.js';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Every request a test server received, in order. */
interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
}

/**
 * A local server that answers `/v1/models`, recording what it was asked.
 *
 * `status` lets a test be the server that is running and refusing, which is a
 * different thing from no server at all and has to stay different.
 */
async function serve(
  options: { status?: number; body?: unknown } = {},
): Promise<{ origin: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    seen.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const status = options.status ?? 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(options.body ?? { data: [{ id: '/models/qwen3-30b.gguf', object: 'model' }] }),
    );
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

describe('the address a profile names', () => {
  it('probes the profile’s server, not the flavour’s default', async () => {
    // The reported defect. Nothing is listening on 8080 in this test, and the
    // profile's own server is: a probe that reads the default would report a
    // working setup as unavailable, which is what it did.
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    const availability = await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: origin } });

    expect(availability?.available).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(['/v1/models']);
  });

  it('names that address when nothing is answering', async () => {
    // The message is the whole value of the failure: "start llama.cpp" is
    // advice, and the address is what makes it actionable.
    const adapter = createLocalAdapter(LLAMA_CPP);

    const availability = await adapter.checkAvailability?.({
      env: { [BASE_URL_ENV]: 'http://127.0.0.1:9' },
    });

    expect(availability?.available).toBe(false);
    expect(availability?.reason).toContain('http://127.0.0.1:9');
  });

  it('falls back to the default when no profile has been chosen', async () => {
    // `providers:list` probes before any profile exists. The default is still
    // the right guess there; what must not happen is it being the *only* one.
    const adapter = createLocalAdapter(LLAMA_CPP);

    const availability = await adapter.checkAvailability?.();

    // Either answer is legitimate — someone may genuinely be running a server
    // on 8080 — so what is asserted is that it probed without an environment
    // rather than threw.
    expect(typeof availability?.available).toBe('boolean');
  });

  it('lists models from the profile’s server', async () => {
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    const catalogue = await adapter.listModels?.({
      env: { [BASE_URL_ENV]: origin },
      cwd: process.cwd(),
    });

    expect(catalogue?.live).toBe(true);
    expect(catalogue?.models[0]?.id).toBe('/models/qwen3-30b.gguf');
    expect(seen[0]?.url).toBe('/v1/models');
  });

  it('appends its paths cleanly to an address that ended in a slash', async () => {
    // A doubled slash is what a strict reverse proxy answers 404 to, and an
    // address typed with a trailing slash is the ordinary case.
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: `${origin}/` } });

    expect(seen[0]?.url).toBe('/v1/models');
  });
});

describe('a server that wants a key', () => {
  it('sends it as a bearer token on the probe', async () => {
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    await adapter.checkAvailability?.({
      env: { [BASE_URL_ENV]: origin, [API_KEY_ENV]: 'hunter2' },
    });

    expect(seen[0]?.authorization).toBe('Bearer hunter2');
  });

  it('sends it on the model list too', async () => {
    // A keyed server refuses `/v1/models` as readily as it refuses a
    // completion, and an unauthenticated catalogue call is how this failed
    // quietly: an empty picker, and nothing to say why.
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    await adapter.listModels?.({
      env: { [BASE_URL_ENV]: origin, [API_KEY_ENV]: 'hunter2' },
      cwd: process.cwd(),
    });

    expect(seen[0]?.authorization).toBe('Bearer hunter2');
  });

  it('sends no header at all when there is no key', async () => {
    // Not an empty `Authorization`: some proxies answer 401 to that and pass
    // an absent one straight through, so the two are not interchangeable.
    const { origin, seen } = await serve();
    const adapter = createLocalAdapter(LLAMA_CPP);

    await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: origin } });
    await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: origin, [API_KEY_ENV]: '   ' } });

    expect(seen.map((r) => r.authorization)).toEqual([undefined, undefined]);
  });

  it('reports a refusal as a refusal, not as an absent server', async () => {
    // The message decides what the user does next. "Start llama.cpp" sends
    // someone whose server is running to restart it; naming the key sends
    // them to the field that is actually empty.
    const { origin } = await serve({ status: 401 });
    const adapter = createLocalAdapter(LLAMA_CPP);

    const availability = await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: origin } });

    expect(availability?.available).toBe(false);
    expect(availability?.reason).toContain('API key');
    expect(availability?.reason).not.toContain('Start');
  });

  it('still reports an ordinary error as one', async () => {
    const { origin } = await serve({ status: 500 });
    const adapter = createLocalAdapter(LLAMA_CPP);

    const availability = await adapter.checkAvailability?.({ env: { [BASE_URL_ENV]: origin } });

    expect(availability?.available).toBe(false);
    expect(availability?.reason).toContain('500');
    expect(availability?.reason).not.toContain('API key');
  });
});
