/**
 * JSON value types.
 *
 * Everything in this package has to survive Electron's structured-clone IPC
 * boundary, so anywhere a payload is "whatever the provider gave us" it is
 * typed as {@link JsonValue} rather than `any` or `unknown`. That keeps the
 * contract honest: if it cannot be cloned, it cannot cross the boundary.
 */

/** Any value that survives `JSON.stringify` / structured clone unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object. Tool inputs and tool results are modelled as these. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** A JSON array. */
export type JsonArray = readonly JsonValue[];

/**
 * Exhaustiveness helper.
 *
 * Call this in the `default` branch of a `switch` over a discriminated union
 * (most usefully {@link import('./events.js').AgentEvent}). If a new variant is
 * added to the union and a consumer forgets to handle it, the call stops
 * compiling.
 *
 * @example
 * ```ts
 * switch (event.type) {
 *   case 'text.delta': return renderDelta(event)
 *   // ...every other case...
 *   default: return assertNever(event, 'unhandled agent event')
 * }
 * ```
 */
export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
