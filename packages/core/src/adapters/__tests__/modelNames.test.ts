/**
 * How a live `ModelInfo` becomes a row in Apollo's model picker.
 *
 * These are regressions, not unit-test box-ticking. The picker was built and
 * verified against a mock catalogue whose `displayName`s were already the short
 * versioned names the UI wanted — so it looked correct everywhere and was wrong
 * the moment it met the real CLI, which reports "Default (recommended)",
 * "Opus (1M context)", "Sonnet", "Haiku": a row that names no model, a
 * parenthetical about a context size that is standard on every current model,
 * and no version numbers at all. Two Sonnet generations were indistinguishable.
 *
 * The fixtures below are that real shape, so the mock cannot flatter us again.
 */

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { isDefaultAlias, shortModelName } from '../claude.js';

const info = (partial: Partial<ModelInfo> & Pick<ModelInfo, 'value' | 'displayName'>): ModelInfo =>
  ({ description: '', ...partial }) as ModelInfo;

describe('shortModelName', () => {
  it('takes the version from the wire id, not the display name', () => {
    // What the CLI actually reports today: a display name with no version in it.
    expect(
      shortModelName(
        info({ value: 'opus', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5' }),
      ),
    ).toBe('Opus 5');
    expect(
      shortModelName(info({ value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' })),
    ).toBe('Sonnet 5');
  });

  it('joins a multi-part version with a dot and drops the dated snapshot', () => {
    expect(
      shortModelName(
        info({
          value: 'haiku',
          displayName: 'Haiku',
          resolvedModel: 'claude-haiku-4-5-20251001',
        }),
      ),
    ).toBe('Haiku 4.5');
  });

  it('names a model the CLI has not shipped to us yet, from its id alone', () => {
    // Nothing here knows what Fable is; the id carries everything needed.
    expect(
      shortModelName(info({ value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5' })),
    ).toBe('Fable 5');
  });

  it('falls back to the display name when the provider publishes no resolution', () => {
    // A provider's own name beats one this function invented.
    expect(shortModelName(info({ value: 'x', displayName: 'Claude Something' }))).toBe('Something');
    expect(shortModelName(info({ value: 'bare-id', displayName: '' }))).toBe('bare-id');
  });
});

describe('isDefaultAlias', () => {
  it('catches the CLI row that points at a model instead of naming one', () => {
    expect(
      isDefaultAlias({ id: 'default', label: 'Default', note: '', displayName: 'Default (recommended)' }),
    ).toBe(true);
  });

  it('catches it by display text too, for a provider that uses another id', () => {
    expect(
      isDefaultAlias({ id: 'auto', label: 'Default', note: '', displayName: 'Default (recommended)' }),
    ).toBe(true);
  });

  it('leaves real models alone', () => {
    expect(isDefaultAlias({ id: 'opus', label: 'Opus 5', note: '', displayName: 'Opus (1M context)' })).toBe(
      false,
    );
    // The word appearing mid-sentence is not the same as the row being one.
    expect(
      isDefaultAlias({ id: 'sonnet', label: 'Sonnet 5', note: '', displayName: 'Sonnet, the default choice' }),
    ).toBe(false);
  });
});
