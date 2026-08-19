/**
 * Prompt content blocks for OpenCode.
 *
 * The behaviour under test is mostly about *not losing things*. The adapter
 * previously sent a text block and nothing else while declaring `imageInput:
 * true`, so an attached image disappeared without a word — the model answered
 * about a picture it had never received. Each case below is a way that could
 * happen again.
 *
 * The capability values are real: `opencode acp` 1.18.18 advertises
 * `promptCapabilities: { embeddedContext: true, image: true }`.
 */

import { describe, expect, it } from 'vitest';
import type { Attachment } from '@rx-artemis/protocol';

import { buildPromptBlocks } from '../opencode/blocks.js';

const BOTH = { image: true, embeddedContext: true };
const NEITHER = { image: false, embeddedContext: false };

const image = (id = 'i1'): Attachment => ({
  kind: 'image',
  id,
  mediaType: 'image/png',
  data: 'aGVsbG8=',
});

const file = (name = 'notes.md', id = 'f1'): Attachment => ({
  kind: 'file',
  id,
  name,
  mediaType: 'text/markdown',
  data: '# Notes',
});

describe('buildPromptBlocks', () => {
  it('sends the prompt when there is nothing attached', () => {
    expect(buildPromptBlocks('hello', undefined, BOTH)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('LEADS with the text, because the first block reads as the instruction', () => {
    const blocks = buildPromptBlocks('describe this', [image()], BOTH);

    expect(blocks[0]).toMatchObject({ type: 'text' });
  });

  it('REGRESSION: an image actually reaches the agent', () => {
    // The bug this file exists for: declared supported, never sent.
    const blocks = buildPromptBlocks('describe this', [image()], BOTH);

    expect(blocks[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('sends a file as an embedded resource, with no path on disk', () => {
    // ACP has somewhere to put the bytes, so unlike Claude and Codex nothing is
    // staged and there is no directory to grant or clean up.
    const [, resource] = buildPromptBlocks('summarise', [file()], BOTH);

    expect(resource).toMatchObject({
      type: 'resource',
      resource: { mimeType: 'text/markdown', text: '# Notes' },
    });
  });

  it('names the file in a uri that does not claim to be a path', () => {
    // `file:` would name something that does not exist and invite the agent to
    // go and read it.
    const [, resource] = buildPromptBlocks('summarise', [file('quarterly sales.csv')], BOTH);
    const uri = (resource as { resource: { uri: string } }).resource.uri;

    expect(uri.startsWith('attachment:')).toBe(true);
    expect(uri).toContain('quarterly%20sales.csv');
  });

  it('keeps two files with the same name apart', () => {
    const blocks = buildPromptBlocks('compare', [file('a.md', 'f1'), file('a.md', 'f2')], BOTH);
    const uris = blocks.slice(1).map((b) => (b as { resource: { uri: string } }).resource.uri);

    expect(new Set(uris).size).toBe(2);
  });

  it('omits a media type it was not given rather than guessing one', () => {
    // A wrong content type is worse than an absent one.
    const bare: Attachment = { kind: 'file', id: 'f9', name: 'x.bin', data: 'AAAA' };
    const [, resource] = buildPromptBlocks('what is this', [bare], BOTH);

    expect('mimeType' in (resource as { resource: object }).resource).toBe(false);
  });

  it('preserves order across mixed attachments', () => {
    const blocks = buildPromptBlocks('both', [image(), file()], BOTH);

    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'resource']);
  });
});

describe('an agent that cannot take an attachment', () => {
  it('SAYS SO in the prompt rather than dropping it silently', () => {
    // A model told "an image was attached but this agent cannot accept images"
    // can say so. One sent nothing answers confidently about something it never
    // received, which is the worse failure.
    const [text] = buildPromptBlocks('describe this', [image()], NEITHER);

    expect((text as { text: string }).text).toContain('could not attach an image');
  });

  it('names a refused file, since the user knows which one they attached', () => {
    const [text] = buildPromptBlocks('read it', [file('budget.csv')], NEITHER);

    expect((text as { text: string }).text).toContain('budget.csv');
  });

  it('sends nothing but text when everything was refused', () => {
    const blocks = buildPromptBlocks('hi', [image(), file()], NEITHER);

    expect(blocks).toHaveLength(1);
  });

  it('takes what it can and reports only the rest', () => {
    // Half-support is the realistic case: images yes, embedded content no.
    const blocks = buildPromptBlocks('mixed', [image(), file('notes.md')], {
      image: true,
      embeddedContext: false,
    });

    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect((blocks[0] as { text: string }).text).toContain('notes.md');
    expect((blocks[0] as { text: string }).text).not.toContain('an image');
  });
});
