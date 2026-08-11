/**
 * Asking the user something, in both directions.
 *
 * Claude's `AskUserQuestion` parks a run on the permission callback the same
 * way an approval does, so these two functions are the whole difference between
 * a card that shows a person a JSON blob and one that shows them a question:
 * `readQuestionPrompt` decodes what was asked, `withQuestionAnswers` encodes
 * what they said.
 *
 * The encoding is the fiddly half, and it is fiddly because the provider's
 * shape is particular: answers keyed by question text, multi-select joined into
 * one string, prose in `annotations` rather than in the answer, and a sentinel
 * for "typed something, chose nothing". Get any of it wrong and the failure is
 * silent — the model is told the user picked an option they did not pick, or
 * that they answered nothing at all.
 */

import { describe, expect, it } from 'vitest';

import type { JsonObject, QuestionPrompt } from '@rx-artemis/protocol';

import { buildPermissionRequest, readQuestionPrompt, toPermissionResult, withQuestionAnswers } from '../mapper.js';

/** The arguments the tool actually arrives with. */
const INPUT: JsonObject = {
  questions: [
    {
      question: 'Which date library?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Tree-shakeable, function per import.' },
        { label: 'Luxon', description: 'Immutable, good zone support.', preview: 'DateTime.now()' },
      ],
    },
  ],
};

const PROMPT = readQuestionPrompt('AskUserQuestion', INPUT) as QuestionPrompt;

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

describe('readQuestionPrompt', () => {
  it('decodes the questions, options and previews the model wrote', () => {
    expect(PROMPT).toEqual({
      questions: [
        {
          question: 'Which date library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per import.' },
            {
              label: 'Luxon',
              description: 'Immutable, good zone support.',
              preview: 'DateTime.now()',
            },
          ],
        },
      ],
    });
  });

  it('ignores every other tool', () => {
    expect(readQuestionPrompt('Bash', INPUT)).toBeUndefined();
  });

  it.each([
    ['no questions at all', {}],
    ['an empty list', { questions: [] }],
    ['a question with one option, which is not a choice', {
      questions: [{ question: 'Go?', header: 'Go', multiSelect: false, options: [{ label: 'Yes', description: '' }] }],
    }],
    ['a question with no text', {
      questions: [{ question: '', header: 'X', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }],
    }],
    ['options that cannot be told apart', {
      questions: [{ question: 'Which?', header: 'X', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'a', description: '' }] }],
    }],
    ['questions that cannot be told apart, so cannot be answered separately', {
      questions: [
        { question: 'Which?', header: 'X', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] },
        { question: 'Which?', header: 'Y', multiSelect: false, options: [{ label: 'c', description: '' }, { label: 'd', description: '' }] },
      ],
    }],
  ])('gives up entirely on %s', (_why, input) => {
    expect(readQuestionPrompt('AskUserQuestion', input)).toBeUndefined();
  });

  it('leaves the request answerable as a plain approval when it cannot decode', () => {
    // The point of the `undefined`: the UI falls back to the verbatim-arguments
    // card rather than rendering a half-parsed interview, and the run can still
    // be unparked.
    const request = buildPermissionRequest({
      id: 'run-1:perm:1',
      runId: 'run-1',
      toolName: 'AskUserQuestion',
      input: { questions: 'not a list' },
      requestedAt: 1,
    });
    expect(request.question).toBeUndefined();
    expect(request.input).toEqual({ questions: 'not a list' });
  });
});

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

describe('withQuestionAnswers', () => {
  it('keys the answer by question text and keeps the arguments the tool needs', () => {
    const out = withQuestionAnswers(INPUT, PROMPT, [
      { question: 'Which date library?', options: ['date-fns'] },
    ]);
    expect(out['answers']).toEqual({ 'Which date library?': 'date-fns' });
    // `questions` is required by the tool's own schema; dropping it would make
    // the call fail after the user had already answered.
    expect(out['questions']).toEqual(INPUT['questions']);
  });

  it('echoes back the preview the user was looking at when they chose', () => {
    const out = withQuestionAnswers(INPUT, PROMPT, [
      { question: 'Which date library?', options: ['Luxon'] },
    ]);
    expect(out['annotations']).toEqual({ 'Which date library?': { preview: 'DateTime.now()' } });
  });

  it('joins a multi-select answer into the one string the provider expects', () => {
    const input: JsonObject = {
      questions: [
        {
          question: 'Which checks?',
          header: 'Checks',
          multiSelect: true,
          options: [
            { label: 'lint', description: '' },
            { label: 'types', description: '' },
            { label: 'tests', description: '' },
          ],
        },
      ],
    };
    const prompt = readQuestionPrompt('AskUserQuestion', input) as QuestionPrompt;
    const out = withQuestionAnswers(input, prompt, [
      { question: 'Which checks?', options: ['tests', 'lint'] },
    ]);
    expect(out['answers']).toEqual({ 'Which checks?': 'tests, lint' });
    // No preview for a multiple choice: there is no single sample the user was
    // looking at when they chose.
    expect(out['annotations']).toBeUndefined();
  });

  it('sends prose as a note rather than as the answer', () => {
    // An answer that is not one of the offered labels reads to the model as a
    // garbled selection. A note reads as the user talking.
    const out = withQuestionAnswers(INPUT, PROMPT, [
      { question: 'Which date library?', options: ['date-fns'], notes: 'but pin the version' },
    ]);
    expect(out['answers']).toEqual({ 'Which date library?': 'date-fns' });
    expect(out['annotations']).toEqual({
      'Which date library?': { notes: 'but pin the version' },
    });
  });

  it('uses the provider’s sentinel when the user typed something but chose nothing', () => {
    // `(notes only)` is the exact string the tool recognises: it renders such an
    // answer as "(no option selected)" plus the note, rather than telling the
    // model the user picked an option by that name.
    const out = withQuestionAnswers(INPUT, PROMPT, [
      { question: 'Which date library?', options: [], notes: 'neither — use Temporal' },
    ]);
    expect(out['answers']).toEqual({ 'Which date library?': '(notes only)' });
    expect(out['annotations']).toEqual({
      'Which date library?': { notes: 'neither — use Temporal' },
    });
  });

  it('leaves a skipped prompt with no answers at all, which is how the tool reads a skip', () => {
    const out = withQuestionAnswers(INPUT, PROMPT, []);
    expect(out['answers']).toBeUndefined();
    expect(out['annotations']).toBeUndefined();
    expect(out).toEqual(INPUT);
  });

  it.each([
    ['a question that was never asked', { question: 'Something else?', options: ['x'] }],
    ['an option that was never offered', { question: 'Which date library?', options: ['Moment'] }],
    ['an answer that says nothing', { question: 'Which date library?', options: [] }],
  ])('drops %s', (_why, answer) => {
    expect(withQuestionAnswers(INPUT, PROMPT, [answer])['answers']).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

describe('toPermissionResult with a question', () => {
  it('turns the answers into the tool’s updated input, so the UI never has to', () => {
    const { result } = toPermissionResult(
      { behavior: 'allow', answers: [{ question: 'Which date library?', options: ['date-fns'] }] },
      { toolUseID: 'toolu_1', toolName: 'AskUserQuestion', question: PROMPT, input: INPUT },
    );
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { questions: INPUT['questions'], answers: { 'Which date library?': 'date-fns' } },
    });
  });

  it('ignores answers on a request that asked nothing', () => {
    const { result } = toPermissionResult(
      { behavior: 'allow', answers: [{ question: 'Which date library?', options: ['date-fns'] }] },
      { toolUseID: 'toolu_1', toolName: 'Bash' },
    );
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: undefined });
  });

  it('does not overwrite arguments the caller edited by hand', () => {
    // `updatedInput` is the escape hatch for editing a tool call. Silently
    // replacing it with encoded answers would be worse than ignoring them.
    const { result } = toPermissionResult(
      {
        behavior: 'allow',
        updatedInput: { questions: [] },
        answers: [{ question: 'Which date library?', options: ['date-fns'] }],
      },
      { toolUseID: 'toolu_1', toolName: 'AskUserQuestion', question: PROMPT, input: INPUT },
    );
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { questions: [] } });
  });
});
