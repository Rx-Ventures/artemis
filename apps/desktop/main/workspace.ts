/**
 * The native directory picker, minus Electron.
 *
 * `dialog.showOpenDialog` lives in `./ipc.ts`, where `electron` is already
 * imported. What lives here is the part worth testing on its own: reading a
 * dialog result and deciding whether it is something Libra is willing to hand
 * back as a working directory.
 *
 * ## Why a dialog result gets validated at all
 *
 * It is tempting to treat `filePaths[0]` as trustworthy — the OS produced it,
 * the user clicked it. But the shape has three edge cases that all reduce to
 * the same bug if they are not handled, and the bug is expensive: a path that
 * is empty, missing, or malformed flows into `RunInput.cwd`, reaches `spawn`,
 * and comes back as an `ENOENT` that the provider SDK reports as a libc
 * mismatch in its own binary. The failure then surfaces three layers away from
 * its cause, naming the wrong thing entirely.
 *
 *  - **Cancelled** — `canceled: true`. An ordinary outcome, not an error.
 *  - **Cancelled without the flag** — a dialog can return an empty `filePaths`
 *    instead of setting `canceled`. Treated as a cancel, because that is what
 *    the user did.
 *  - **Multi-select** — `properties` never asks for it, but the field is an
 *    array either way; the first entry is the answer.
 */

/** The parts of Electron's `OpenDialogReturnValue` this module needs. */
export interface OpenDialogOutcome {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

/**
 * The `properties` a directory picker must be opened with.
 *
 * `openDirectory` selects folders rather than files. `createDirectory` gives
 * the user a "New Folder" button inside the dialog — which matters more than it
 * looks: without it, starting work in a folder that does not exist yet means
 * cancelling, leaving Libra, creating the folder, and coming back. That detour
 * is exactly what leads people to type a path by hand instead, which is the
 * input this picker exists to replace.
 */
export const DIRECTORY_PICKER_PROPERTIES = ['openDirectory', 'createDirectory'] as const;

/** A NUL byte cannot appear in a real path, and truncates any syscall given one. */
const NUL = '\u0000';

/**
 * Read the chosen directory out of a dialog result.
 *
 * @returns the selected path, or `null` when the user cancelled or the dialog
 *          returned nothing usable. Never throws — a malformed result and a
 *          cancel are indistinguishable to the user, and both mean "carry on
 *          with what you had".
 *
 * The path is returned as the OS gave it, with only surrounding whitespace
 * removed. It is deliberately *not* checked for existence here: that is
 * `checkWorkingDirectory`'s job in `@libra/core`, and the caller runs it so
 * that a picked path and a typed path are held to exactly the same standard.
 */
export function readPickedDirectory(outcome: OpenDialogOutcome | null | undefined): string | null {
  if (outcome === null || outcome === undefined) return null;
  if (outcome.canceled) return null;

  const paths: readonly unknown[] = Array.isArray(outcome.filePaths) ? outcome.filePaths : [];
  const [first] = paths;
  if (typeof first !== 'string') return null;

  const trimmed = first.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(NUL)) return null;

  return trimmed;
}
