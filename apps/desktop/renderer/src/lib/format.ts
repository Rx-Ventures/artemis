import type { JsonValue, TokenUsage, UsageSnapshot } from '@libra/protocol';

/** `1234` → `1.2k`. Token counts get large and column width does not. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Cost, with enough precision that sub-cent runs do not all read as `$0.00`. */
export function formatUsd(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Wall-clock duration in the smallest unit that still reads clearly. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Coarse "when", for session lists. */
export function formatRelative(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '';
  const delta = Math.max(0, now - ts);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Clock time, for transcript gutters. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Last path segment, for a cwd chip. Handles both separators. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/** Collapse whitespace and clip, for one-line summaries. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const MAX_JSON_CHARS = 20_000;

/**
 * Pretty JSON for the inspector panes.
 *
 * Tool results can be megabytes (a `Read` of a large file, a `Bash` that
 * cats a log). Rendering that as one text node janks the whole transcript, so
 * the payload is clipped and the clip is announced rather than hidden.
 */
export function formatJson(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > MAX_JSON_CHARS
    ? `${text.slice(0, MAX_JSON_CHARS)}\n\n… clipped (${text.length.toLocaleString()} characters total)`
    : text;
}

/**
 * A one-line gloss of a tool's arguments for the collapsed row.
 *
 * Provider-neutral: it looks for the handful of argument names that show up
 * across every agent CLI, then falls back to the first short scalar.
 */
export function summarizeToolInput(input: Record<string, JsonValue> | undefined): string {
  if (!input) return '';
  const preferred = [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'prompt',
    'description',
    'notebook_path',
  ];
  for (const key of preferred) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value, 96);
  }
  for (const [, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length <= 96) return oneLine(value, 96);
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }` : '';
}

/** Total billable input tokens, cached and uncached. */
export function totalInputTokens(t: TokenUsage | undefined): number | undefined {
  if (!t) return undefined;
  return t.inputTokens + (t.cacheReadInputTokens ?? 0) + (t.cacheCreationInputTokens ?? 0);
}

/** Context fill as a 0–1 ratio, when the provider reports both halves. */
export function contextRatio(usage: UsageSnapshot | undefined): number | undefined {
  if (!usage?.contextTokens || !usage.contextWindow) return undefined;
  return Math.min(1, usage.contextTokens / usage.contextWindow);
}
