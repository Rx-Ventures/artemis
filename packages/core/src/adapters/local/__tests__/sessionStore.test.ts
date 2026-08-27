/**
 * The transcript store, on its own.
 * ============================================================================
 *
 * Driven against a real directory rather than a mocked filesystem, because
 * every claim this module makes is about files: that a session lands where
 * Claude's layout says it should, that a listing reads the directory a session
 * *ran* in rather than the one its name encodes to, and that a half-written
 * line costs one message instead of the conversation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProfileId, ProviderId, RunId, SessionId } from '@rx-artemis/protocol';

import { encodeProjectDir } from '../../claudeSessionSpawn.js';
import {
  appendTurn,
  count,
  list,
  listAll,
  LOCAL_PROFILE_DIR_ENV,
  readEvents,
  readMessages,
  remove,
  setTitle,
  tag,
} from '../sessionStore.js';
import type { StoredTurnMessage } from '../sessionStore.js';

const LLAMACPP = 'llamacpp' as ProviderId;
const PROFILE = 'profile-1' as ProfileId;
const RUN = 'run-1' as RunId;
const SESSION = 'session-abc' as SessionId;

let profileDir: string;
let cwd: string;
let env: Record<string, string>;

/** One message and the single event it replays as. */
function said(role: 'user' | 'assistant', text: string): StoredTurnMessage {
  return {
    message: { role, content: text },
    events: [{ type: 'text.complete', messageId: `m-${text}`, role, text } as never],
  };
}

/** The file one session's transcript is expected to be at. */
function transcript(sessionId = SESSION, at = cwd): string {
  return path.join(profileDir, 'sessions', encodeProjectDir(at), `${String(sessionId)}.jsonl`);
}

beforeEach(async () => {
  profileDir = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-store-')));
  cwd = path.join(profileDir, 'project');
  await mkdir(cwd, { recursive: true });
  env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };
});

afterEach(async () => {
  await rm(profileDir, { recursive: true, force: true });
});

describe('where a transcript goes', () => {
  it('writes one JSONL file per session under the encoded working directory', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'hello')],
    });

    // The layout is asserted literally, not recomputed: it mirrors another
    // program's convention, and a test that derived it the same way the code
    // does would prove nothing about the convention.
    const written = await readFile(
      path.join(profileDir, 'sessions', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-abc.jsonl'),
      'utf8',
    );
    expect(written.trim().split('\n')).toHaveLength(1);
  });

  it('records the real working directory inside the first record', async () => {
    // The directory name is lossy — `/src/my-app` and `/src/my/app` encode the
    // same — so a listing that decoded it could resume an agent somewhere the
    // user has never been. The record is the authoritative copy.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'hello')],
    });

    const first: unknown = JSON.parse((await readFile(transcript(), 'utf8')).split('\n')[0] ?? '');
    expect((first as { cwd: string }).cwd).toBe(cwd);
  });

  it('writes nothing when the environment names no profile directory', async () => {
    // A misconfigured profile is a run that still works, with no history.
    await expect(
      appendTurn({
        env: {},
        sessionId: SESSION,
        cwd,
        providerId: LLAMACPP,
        messages: [said('user', 'hello')],
      }),
    ).resolves.toBeUndefined();
    await expect(readMessages({ env: {}, sessionId: SESSION })).resolves.toEqual([]);
  });
});

describe('one conversation, one file', () => {
  /**
   * The split this guards against is silent and total: the reader finds the
   * first file and the writer creates a second, so the conversation stops
   * growing without anything failing.
   */
  async function say(at: string, text: string): Promise<void> {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd: at,
      providerId: LLAMACPP,
      messages: [said('user', text)],
    });
  }

  it('appends to the existing transcript when the directory is spelled differently', async () => {
    await say(cwd, 'first');
    // The spellings a resume actually arrives with: a trailing slash from a
    // client, and a path that resolved differently on the way in.
    await say(`${cwd}/`, 'second');
    await say(path.join(cwd, 'sub', '..'), 'third');

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
  });

  it('leaves one row and one count, not two of each', async () => {
    await say(cwd, 'first');
    await say(`${cwd}/`, 'second');

    // A second file under a second encoded name would show the same id twice
    // in the sidebar and answer two different counts to the two callers that
    // ask — the registry with the run's cwd, the renderer with the summary's.
    const everywhere = await listAll({ profiles: [{ profileId: PROFILE, env }] }, LLAMACPP);
    expect(everywhere.sessions.filter((session) => session.id === SESSION)).toHaveLength(1);
    expect(everywhere.sessions[0]?.messageCount).toBe(2);

    expect(await count({ env, sessionId: SESSION, cwd })).toBe(2);
    expect(await count({ env, sessionId: SESSION, cwd: `${cwd}/` })).toBe(2);
  });

  it('destroys the whole conversation rather than half of it', async () => {
    await say(cwd, 'first');
    await say(`${cwd}/`, 'second');

    expect(await remove({ env, sessionId: SESSION, cwd: `${cwd}/` })).toBe(true);
    expect(await readMessages({ env, sessionId: SESSION })).toEqual([]);
  });

  it('refuses to store a conversation with no directory at all', async () => {
    // It would land loose in `sessions/`, where no listing walks and nothing
    // can be resumed from.
    await expect(
      appendTurn({
        env,
        sessionId: SESSION,
        cwd: '   ',
        providerId: LLAMACPP,
        messages: [said('user', 'nowhere')],
      }),
    ).rejects.toThrow(/directory it ran in/);
  });

  it('finds a project directory that is a symlink', async () => {
    // `readdir` reports a linked directory as a link, not a directory, so a
    // store assembled with `ln -s` enumerated as empty.
    const real = path.join(profileDir, 'real-project');
    await mkdir(real, { recursive: true });
    await say(real, 'in the real one');
    await rename(
      path.join(profileDir, 'sessions', encodeProjectDir(real)),
      path.join(profileDir, 'moved'),
    );
    await symlink(
      path.join(profileDir, 'moved'),
      path.join(profileDir, 'sessions', encodeProjectDir(real)),
      // A junction on Windows: `ln -s` is what a user assembles this with on
      // POSIX, and neither is a directory to `readdir`, which is the whole point.
      process.platform === 'win32' ? 'junction' : undefined,
    );

    // Found by a walk that has to follow the link to see anything at all.
    expect(await readMessages({ env, sessionId: SESSION })).toHaveLength(1);
    const everywhere = await listAll({ profiles: [{ profileId: PROFILE, env }] }, LLAMACPP);
    expect(everywhere.sessions.map((session) => session.id)).toEqual([SESSION]);
  });
});

describe('a conversation the model can be sent', () => {
  /** A file written by a turn whose tool results never landed. */
  async function withDanglingCall(): Promise<void> {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        said('user', 'run the tests'),
        {
          message: {
            role: 'assistant',
            content: 'on it',
            tool_calls: [
              { id: 'call_0', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
          },
          events: [],
        },
      ],
    });
  }

  it('drops a tool call nothing ever answered', async () => {
    // Every one of these servers answers 400 to an unanswered `tool_calls`,
    // which this adapter reports as `provider_unavailable` — so one failed
    // append would tell the user their running server is down, for good.
    await withDanglingCall();

    const messages = await readMessages({ env, sessionId: SESSION, cwd });

    expect(messages.some((message) => message.tool_calls !== undefined)).toBe(false);
    // The text the model produced is still what it said.
    expect(messages).toEqual([
      { role: 'user', content: 'run the tests' },
      { role: 'assistant', content: 'on it' },
    ]);
  });

  it('drops the assistant turn entirely when the calls were all it was', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        said('user', 'run the tests'),
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_0', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
          },
          events: [],
        },
      ],
    });

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([
      { role: 'user', content: 'run the tests' },
    ]);
  });

  it('keeps a call that was answered', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        {
          message: {
            role: 'assistant',
            content: 'on it',
            tool_calls: [
              { id: 'call_0', type: 'function', function: { name: 'shell', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
          },
          events: [],
        },
        { message: { role: 'tool', tool_call_id: 'call_0', content: 'passed' }, events: [] },
      ],
    });

    const messages = await readMessages({ env, sessionId: SESSION, cwd });

    // The answered half survives with its result; the unanswered half does not.
    expect(messages[0]?.tool_calls?.map((call) => call.id)).toEqual(['call_0']);
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'passed' });
  });

  it('drops a result for a call the array never made', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        said('user', 'hello'),
        { message: { role: 'tool', tool_call_id: 'call_9', content: 'orphan' }, events: [] },
      ],
    });

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });
});

describe('reading a conversation back', () => {
  it('replays the messages in the order they were written', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'first'), said('assistant', 'answer')],
    });
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'second')],
    });

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('finds a session without being told which project it ran in', async () => {
    // A window that has moved still has to be able to open the conversation.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'first')],
    });

    expect(await readMessages({ env, sessionId: SESSION })).toHaveLength(1);
  });

  it('answers empty for a session that was never written', async () => {
    expect(await readMessages({ env, sessionId: 'nope' as SessionId, cwd })).toEqual([]);
    expect(await count({ env, sessionId: 'nope' as SessionId, cwd })).toBe(0);
  });

  it('stamps replayed events with the run that asked for them', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'first'), said('assistant', 'answer')],
    });

    const { events, hasMore } = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN });

    expect(hasMore).toBe(false);
    expect(events.map((event) => [event.runId, event.seq])).toEqual([
      [RUN, 0],
      [RUN, 1],
    ]);
    // The protocol has a flag for text the user is reading back rather than
    // watching arrive, so the UI never has to infer it.
    expect(events.every((event) => (event as { replay?: boolean }).replay === true)).toBe(true);
  });

  it('pages in the same unit it counts in', async () => {
    // The whole value of `countSessionMessages` is that `limit: historyOffset`
    // stops exactly where a resumed run's own output begins. Two units would
    // make that number silently wrong.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'one'), said('assistant', 'two'), said('user', 'three')],
    });

    expect(await count({ env, sessionId: SESSION, cwd })).toBe(3);

    const page = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN, limit: 2 });
    expect(page.events.map((event) => (event as { text: string }).text)).toEqual(['one', 'two']);
    expect(page.hasMore).toBe(true);

    const rest = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN, offset: 2 });
    expect(rest.events.map((event) => (event as { text: string }).text)).toEqual(['three']);
    expect(rest.hasMore).toBe(false);
  });

  it('keeps a stored tool call and its outcome together', async () => {
    // A tool result reads the same whether the command worked or failed, which
    // is why the events are stored rather than derived from the messages.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        {
          message: { role: 'tool', tool_call_id: 'c1', content: 'boom' },
          events: [
            { type: 'tool.start', toolCallId: 'c1', name: 'shell', input: {} } as never,
            { type: 'tool.end', toolCallId: 'c1', name: 'shell', status: 'error' } as never,
          ],
        },
      ],
    });

    const { events } = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN });
    expect(events.map((event) => event.type)).toEqual(['tool.start', 'tool.end']);
    expect((events[1] as { status: string }).status).toBe('error');
  });

  it('gives every replayed tool call an id of its own', async () => {
    // These servers omit the call id, so the accumulator stands its index in —
    // making every turn's first call `call_0`. The renderer keys tool rows on
    // that id and replaces the row when it repeats, so a reopened four-turn
    // session showed one tool card holding the last turn's output.
    const turn = (output: string): StoredTurnMessage => ({
      message: { role: 'tool', tool_call_id: 'call_0', content: output },
      events: [
        { type: 'tool.start', toolCallId: 'call_0', name: 'shell', input: {} } as never,
        { type: 'tool.end', toolCallId: 'call_0', name: 'shell', status: 'ok' } as never,
      ],
    });
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [turn('first output'), turn('second output')],
    });

    const { events } = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN });
    const ids = events.map((event) => (event as { toolCallId: string }).toolCallId);

    // Two rows, each with its start and end still paired to each other.
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);

    // And stable when the same records are read a page at a time, or the
    // second page would rename the rows the first one drew.
    const second = await readEvents({ env, sessionId: SESSION, cwd, runId: RUN, offset: 1 });
    expect((second.events[0] as { toolCallId: string }).toolCallId).toBe(ids[2]);
  });

  it('leaves the ids in the replayed message array exactly as the server issued them', async () => {
    // The uniquifying is for display only: in the message array the id has a
    // job — pairing a result to the call — and rewriting it would change what
    // the model is told it said.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_0', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
          },
          events: [],
        },
        { message: { role: 'tool', tool_call_id: 'call_0', content: 'done' }, events: [] },
      ],
    });

    const messages = await readMessages({ env, sessionId: SESSION, cwd });
    expect(messages[0]?.tool_calls?.[0]?.id).toBe('call_0');
    expect(messages[1]?.tool_call_id).toBe('call_0');
  });
});

describe('a transcript that was damaged', () => {
  it('skips a line that does not parse rather than losing the conversation', async () => {
    // What a process killed mid-write leaves behind. One truncated record must
    // cost one message, not the whole session.
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'first')],
    });
    await appendFile(transcript(), '{"kind":"message","cwd":"/x",\n');
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('assistant', 'second')],
    });

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
  });

  it('ignores a line that is valid JSON but not one of ours', async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'first')],
    });
    await appendFile(transcript(), `${JSON.stringify({ kind: 'from-a-newer-build' })}\n\n`);

    expect(await count({ env, sessionId: SESSION, cwd })).toBe(1);
  });

  it('reads nothing out of a store that is not there', async () => {
    const missing = { [LOCAL_PROFILE_DIR_ENV]: path.join(profileDir, 'never-created') };

    expect(await readMessages({ env: missing, sessionId: SESSION })).toEqual([]);
    expect(await list({ profileId: PROFILE, cwd, env: missing }, LLAMACPP)).toEqual({
      sessions: [],
      hasMore: false,
    });
  });
});

describe('listing', () => {
  beforeEach(async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      model: 'qwen3',
      messages: [said('user', 'how do I build this?'), said('assistant', 'like so')],
    });
    await appendTurn({
      env,
      sessionId: 'session-def' as SessionId,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'a second conversation')],
    });
  });

  it('reports a session with everything a sidebar row needs', async () => {
    const { sessions } = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    const row = sessions.find((session) => session.id === SESSION);

    expect(row).toMatchObject({
      providerId: LLAMACPP,
      profileId: PROFILE,
      // From the record, never from the directory name above it.
      cwd,
      title: 'how do I build this?',
      firstPrompt: 'how do I build this?',
      messageCount: 2,
      model: 'qwen3',
    });
    expect(row?.titleIsCustom).toBeUndefined();
    expect(row?.sizeBytes).toBeGreaterThan(0);
  });

  it('cuts a long opening message without splitting a character in half', async () => {
    // Slicing by code unit lands mid-surrogate and renders as a replacement
    // glyph, and an opening message is exactly where an emoji turns up.
    await appendTurn({
      env,
      sessionId: 'session-emoji' as SessionId,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', '🙂'.repeat(200))],
    });

    const { sessions } = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    const title = sessions.find((session) => session.id === 'session-emoji')?.title ?? '';

    expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(title).toBe(`${'🙂'.repeat(80)}…`);
  });

  it('pages a project’s conversations', async () => {
    const page = await list({ profileId: PROFILE, cwd, env, limit: 1 }, LLAMACPP);

    expect(page.sessions).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('lists another project’s conversations separately', async () => {
    const other = path.join(profileDir, 'elsewhere');
    await appendTurn({
      env,
      sessionId: 'session-other' as SessionId,
      cwd: other,
      providerId: LLAMACPP,
      messages: [said('user', 'different project')],
    });

    const here = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    expect(here.sessions.map((session) => session.id)).not.toContain('session-other');

    const everywhere = await listAll({ profiles: [{ profileId: PROFILE, env }] }, LLAMACPP);
    expect(everywhere.sessions.map((session) => session.id)).toContain('session-other');
    expect(everywhere.sessions.find((s) => s.id === 'session-other')?.cwd).toBe(other);
  });

  it('names a profile whose store cannot be located instead of failing the query', async () => {
    // One broken profile must not blank the sidebar for the rest.
    const aggregated = await listAll(
      {
        profiles: [
          { profileId: PROFILE, env },
          { profileId: 'profile-2' as ProfileId, env: {} },
        ],
      },
      LLAMACPP,
    );

    expect(aggregated.sessions.length).toBeGreaterThan(0);
    expect(aggregated.unreadableProfiles).toEqual(['profile-2']);
  });

  it('skips a file holding no messages at all', async () => {
    // A row for it could be neither opened nor resumed.
    await writeFile(path.join(profileDir, 'sessions', encodeProjectDir(cwd), 'empty.jsonl'), '');

    const { sessions } = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    expect(sessions.map((session) => session.id)).not.toContain('empty');
  });
});

describe('naming, tagging and destroying', () => {
  beforeEach(async () => {
    await appendTurn({
      env,
      sessionId: SESSION,
      cwd,
      providerId: LLAMACPP,
      messages: [said('user', 'hello')],
    });
  });

  it('renames a session without touching its messages', async () => {
    expect(await setTitle({ env, sessionId: SESSION, cwd }, 'Build notes')).toBe(true);

    const { sessions } = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    expect(sessions[0]).toMatchObject({ title: 'Build notes', titleIsCustom: true });
    // Append-only: a rename must not be able to truncate a conversation.
    expect(await readMessages({ env, sessionId: SESSION, cwd })).toHaveLength(1);
  });

  it('keeps the last name written', async () => {
    await setTitle({ env, sessionId: SESSION, cwd }, 'First');
    await setTitle({ env, sessionId: SESSION, cwd }, 'Second');

    const { sessions } = await list({ profileId: PROFILE, cwd, env }, LLAMACPP);
    expect(sessions[0]?.title).toBe('Second');
  });

  it('tags a session, and clears the tag with null', async () => {
    expect(await tag({ env, sessionId: SESSION, cwd }, 'archived')).toBe(true);
    expect((await list({ profileId: PROFILE, cwd, env }, LLAMACPP)).sessions[0]?.tag).toBe(
      'archived',
    );

    await tag({ env, sessionId: SESSION, cwd }, null);
    expect((await list({ profileId: PROFILE, cwd, env }, LLAMACPP)).sessions[0]?.tag).toBeUndefined();
  });

  it('destroys a transcript rather than hiding it', async () => {
    // `Capabilities.deleteSession` lets the UI confirm this as irreversible, so
    // it has to actually be.
    expect(await remove({ env, sessionId: SESSION, cwd })).toBe(true);

    expect(await readMessages({ env, sessionId: SESSION, cwd })).toEqual([]);
    expect((await list({ profileId: PROFILE, cwd, env }, LLAMACPP)).sessions).toEqual([]);
  });

  it('answers false for a session that is not there', async () => {
    const absent = { env, sessionId: 'nope' as SessionId, cwd };

    expect(await setTitle(absent, 'x')).toBe(false);
    expect(await tag(absent, 'archived')).toBe(false);
    expect(await remove(absent)).toBe(false);
  });
});
