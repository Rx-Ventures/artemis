/**
 * The fold, observed from the transcript.
 *
 * A queued message is consumed by the CLI without a word on its stream: the
 * only record is the `queue-operation` row appended to the session's own
 * `.jsonl`. These tests pin the watcher that tails that file — the entry is
 * matched on the row's exact text and delivered as `message.delivered`, an
 * `enqueue` row is not a delivery, and a row older than the entry cannot
 * deliver it.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, MessageId } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
}));

const { createClaudeAdapter } = await import('../claude.js');
const { AsyncQueue } = await import('../stream.js');
type ResolvedRunInput = import('../types.js').ResolvedRunInput;

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }

  interrupt(): Promise<{ still_queued: string[] }> {
    return Promise.resolve({ still_queued: [] });
  }

  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

function installQuery(): { harness: () => FakeQuery } {
  let captured: FakeQuery | undefined;
  sdkMock.onQuery = () => {
    captured = new FakeQuery();
    return captured;
  };
  return {
    harness: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured;
    },
  };
}

const SESSION_ID = 'sess-fold';

const initMessage = (cwd: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    cwd,
    model: 'claude-opus-4',
    tools: [],
    slash_commands: [],
    permissionMode: 'default',
    claude_code_version: '2.1.226',
    mcp_servers: [],
    apiKeySource: 'user',
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'uuid-init',
  }) as unknown as SDKMessage;

/** The transcript file the CLI would write for this cwd + session. */
function transcriptFile(configDir: string, cwd: string): string {
  const projectDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  return join(projectDir, `${SESSION_ID}.jsonl`);
}

const row = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

describe('queued-message delivery from the transcript', () => {
  const roots: string[] = [];

  const makeRoots = (): { configDir: string; cwd: string } => {
    const configDir = mkdtempSync(join(tmpdir(), 'artemis-claude-config-'));
    const cwd = mkdtempSync(join(tmpdir(), 'artemis-claude-work-'));
    roots.push(configDir, cwd);
    return { configDir, cwd };
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    sdkMock.onQuery = undefined;
  });

  it('emits message.delivered when the CLI records the remove', async () => {
    const { configDir, cwd } = makeRoots();
    const file = transcriptFile(configDir, cwd);
    // History from before the watch: an old remove with different words, which
    // must not satisfy anything.
    writeFileSync(
      file,
      row({
        type: 'queue-operation',
        operation: 'remove',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        content: 'an earlier message entirely',
      }),
    );

    const { harness } = installQuery();
    const input: ResolvedRunInput = {
      runId: 'run-fold-1',
      providerId: 'claude',
      profileId: 'prof-1',
      cwd,
      prompt: 'work on something slow',
      env: { CLAUDE_CONFIG_DIR: configDir },
    };
    const run = await createClaudeAdapter().createRun(input);
    const fake = harness();
    fake.messages.push(initMessage(cwd));

    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'session.started')).toBe(true);
    });

    const text = 'also, please look at the failing test';
    await run.send(text, undefined, 'msg-fold-1' as MessageId);

    // The enqueue row carries the same words and means the opposite.
    appendFileSync(
      file,
      row({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        content: text,
      }),
    );

    // Two poll ticks' worth of patience: the enqueue alone must not deliver.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(events.some((event) => event.type === 'message.delivered')).toBe(false);

    appendFileSync(
      file,
      row({
        type: 'queue-operation',
        operation: 'remove',
        timestamp: new Date().toISOString(),
        content: text,
      }),
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'message.delivered', messageId: 'msg-fold-1' }),
        );
      },
      { timeout: 5_000 },
    );

    fake.close();
    await reading;
  });

  it('accepts the queued_command attachment row as the same fact', async () => {
    const { configDir, cwd } = makeRoots();
    const file = transcriptFile(configDir, cwd);
    writeFileSync(file, '');

    const { harness } = installQuery();
    const input: ResolvedRunInput = {
      runId: 'run-fold-2',
      providerId: 'claude',
      profileId: 'prof-1',
      cwd,
      prompt: 'work on something slow',
      env: { CLAUDE_CONFIG_DIR: configDir },
    };
    const run = await createClaudeAdapter().createRun(input);
    const fake = harness();
    fake.messages.push(initMessage(cwd));

    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'session.started')).toBe(true);
    });

    const text = 'and one more thing';
    await run.send(text, undefined, 'msg-fold-2' as MessageId);

    appendFileSync(
      file,
      row({
        type: 'attachment',
        uuid: 'row-uuid',
        timestamp: new Date().toISOString(),
        attachment: { type: 'queued_command', prompt: text, source_uuid: 'whatever' },
      }),
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'message.delivered', messageId: 'msg-fold-2' }),
        );
      },
      { timeout: 5_000 },
    );

    fake.close();
    await reading;
  });
});
