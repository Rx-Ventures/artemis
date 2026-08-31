/**
 * Reading another Artemis's model catalogue.
 *
 * `GET /api/v0/models` answers with `ServerModelsBody`: every route the
 * connection may use, across every profile the serving Artemis holds. The
 * mapping that matters is `route` → {@link ProviderModelOption.id} — the route
 * (`work-max/opus`) is what `POST /v1/chat/completions` takes as `model`, so
 * carrying it as the option id means the picker's choice is already the wire
 * value and nothing above the adapter has to know routes exist.
 *
 * Validated leniently, like the local catalogue parsers: this reads a body
 * from a server that may be a newer or older build than this one, and a row it
 * cannot read is dropped rather than failing the list.
 */

import type { ProviderModelOption } from '@rx-artemis/protocol';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Map a `ServerModelsBody` onto picker options. Unreadable rows are dropped. */
export function parseServerModels(body: unknown): readonly ProviderModelOption[] {
  const record = asRecord(body);
  const models = record === undefined ? undefined : record['models'];
  if (!Array.isArray(models)) return [];

  const options: ProviderModelOption[] = [];
  for (const raw of models) {
    const model = asRecord(raw);
    if (model === undefined) continue;
    // The route is the wire id; a row without one cannot be asked for.
    const route = asString(model['route']);
    if (route === undefined) continue;

    const label = asString(model['label']) ?? asString(model['id']) ?? route;
    const note = asString(model['note']) ?? '';
    // The serving profile, named so two accounts offering the same model can
    // be told apart in the picker. The route encodes it too, but as a slug.
    const profileLabel = asString(model['profileLabel']);
    // The thinking levels this route accepts, as bare ids. The picker draws the
    // labels from the descriptor's own list and shows only these enabled — see
    // `ARTEMIS_EFFORT_LEVELS`. Absent thinking levels leave the field off, which
    // reads as "every level the descriptor offers"; a present-but-empty list is
    // carried through as `[]`, which the picker reads as "no effort setting on
    // this model" — the same distinction the server's own `thinkingLevels` draws.
    const effortLevels = readThinkingLevelIds(model['thinkingLevels']);

    options.push({
      id: route,
      label,
      ...(asString(model['displayName']) === undefined
        ? {}
        : { displayName: asString(model['displayName']) as string }),
      ...(asString(model['resolvedModel']) === undefined
        ? {}
        : { resolvedModel: asString(model['resolvedModel']) as string }),
      note: profileLabel !== undefined && note !== '' ? `${profileLabel} — ${note}` : (profileLabel ?? note),
      ...(typeof model['tier'] === 'number' ? { tier: model['tier'] } : {}),
      ...(typeof model['fastMode'] === 'boolean' ? { supportsFastMode: model['fastMode'] } : {}),
      ...(typeof model['ultracode'] === 'boolean' ? { supportsUltracode: model['ultracode'] } : {}),
      ...(typeof model['adaptiveThinking'] === 'boolean'
        ? { adaptiveThinking: model['adaptiveThinking'] }
        : {}),
      ...(effortLevels === undefined ? {} : { effortLevels }),
    });
  }
  return options;
}

/**
 * Read a route's `thinkingLevels` down to the ids the picker gates on.
 *
 * `undefined` for anything that is not an array — an older server that never
 * sent the field — so the option omits `effortLevels` and the picker offers the
 * descriptor's whole list. An array, even an empty one, is carried through: the
 * empty case is a real answer ("this model takes no thinking setting"), not a
 * missing one.
 */
function readThinkingLevelIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const raw of value) {
    const level = asRecord(raw);
    const id = level === undefined ? undefined : asString(level['id']);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
