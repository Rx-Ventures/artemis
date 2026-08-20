/**
 * Matching what the user typed against the slash commands a run exposes.
 * ============================================================================
 *
 * Pure, and separate from the composer, because the interesting part is the
 * ranking and the ranking is the part worth asserting. `Composer.tsx` owns the
 * keyboard and the markup; this owns the question "given this draft, what should
 * be on offer, and in what order".
 *
 * ---------------------------------------------------------------------------
 * WHY RANKING IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 *
 * Because bridged names are prefixed. A command the user installed as
 * `commands/cerebro.md` reaches the session as `artemis-skills:cerebro` — the
 * plugin channel renames it, and the bare form is refused outright. Nobody is
 * going to type `artemis-skills:`, so `cer` has to find it, which means matching
 * inside the name and not just at its head.
 *
 * That alone would rank badly: a plain substring match puts
 * `artemis-skills:cerebro` level with any built-in that merely contains the same
 * letters. So the segment after the colon is matched as a name in its own right
 * and ranked above a loose hit — see {@link SLASH_RANKS}. The user types the name
 * they know and the thing they meant is first.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE MENU IS OPEN
 * ---------------------------------------------------------------------------
 *
 * Only while the whole draft is one slash token: `/`, `/cer`, `/artemis-skills:c`.
 * The first space closes it, because after the name the user is typing arguments
 * and a menu over their sentence is in the way. It follows that a slash command
 * has to be the start of the message, which is also the only place the provider
 * will honour one.
 */

/**
 * How well a command matched, lowest first.
 *
 * Exported so the tests name the ranks rather than asserting on the integers,
 * and so the ordering is legible as a policy rather than as magic numbers.
 */
export const SLASH_RANKS = {
  /** The full name starts with what was typed — `/artemis` → `artemis-skills:…`. */
  fullPrefix: 0,
  /** The name after the last colon starts with it — `/cer` → `artemis-skills:cerebro`. */
  segmentPrefix: 1,
  /** It appears somewhere in the name — the loose fallback. */
  contains: 2,
} as const;

/** One command on offer, with what to insert and why it matched. */
export interface SlashMatch {
  /** The canonical name, exactly as the provider listed it. */
  readonly name: string;
  /**
   * The part a person actually recognises: the name after the last colon.
   *
   * Carried so the menu can show it prominently with the prefix as context,
   * rather than making the reader parse a colon-separated string.
   */
  readonly label: string;
  /** The plugin prefix, when there is one. Absent for a built-in. */
  readonly prefix?: string;
  readonly rank: number;
}

export interface SlashMenu {
  /** What was typed after the slash, verbatim. Empty when the draft is just `/`. */
  readonly query: string;
  /** Every match, best first. Never empty — {@link matchSlashCommands} returns null instead. */
  readonly matches: readonly SlashMatch[];
}

/**
 * The name without its slash, if it arrived wearing one.
 *
 * The field is whatever the provider put in `system.init`, and the two forms are
 * both in this repository: the Claude CLI reports bare names (`compact`,
 * `artemis-skills:cerebro`), while `mockBridge.ts` and the mapper's own fixtures
 * use `/compact`. Nothing guarantees which a future provider sends, and the cost
 * of guessing wrong is a menu offering `//compact` and inserting a draft the
 * provider will reject — so the slash is stripped on the way in and added back
 * exactly once on the way out.
 */
function canonical(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/** Split `plugin:name` into its parts, tolerating a name with no prefix. */
function split(name: string): { readonly label: string; readonly prefix?: string } {
  const at = name.lastIndexOf(':');
  if (at <= 0) return { label: name };
  return { label: name.slice(at + 1), prefix: name.slice(0, at) };
}

/**
 * What the menu should show for this draft, or `null` for "no menu".
 *
 * `null` rather than an empty list for both of the ways there is nothing to
 * show — the draft is not a slash token, or nothing matched — because the
 * caller's question is only ever "is there a menu", and a query that matches
 * nothing should close the menu rather than show an empty box over the text.
 */
export function matchSlashCommands(
  commands: readonly string[] | undefined,
  draft: string,
): SlashMenu | null {
  if (commands === undefined || commands.length === 0) return null;

  // The whole draft, not a token at the caret: a slash command is only a command
  // at the start of a message, so `fix /this typo` is prose and gets no menu.
  const token = /^\/(\S*)$/.exec(draft);
  if (token === null) return null;

  const query = token[1] ?? '';
  const needle = query.toLowerCase();

  const matches: SlashMatch[] = [];
  // Stripping the slash can collide two reported names onto one — `compact` and
  // `/compact` are the same command — and the menu keys its rows by name, so a
  // duplicate would be two identical rows sharing a React key.
  const seen = new Set<string>();
  for (const reported of commands) {
    const name = canonical(reported);
    if (seen.has(name)) continue;
    seen.add(name);
    const { label, prefix } = split(name);
    const lower = name.toLowerCase();
    const rank =
      needle.length === 0 || lower.startsWith(needle)
        ? SLASH_RANKS.fullPrefix
        : label.toLowerCase().startsWith(needle)
          ? SLASH_RANKS.segmentPrefix
          : lower.includes(needle)
            ? SLASH_RANKS.contains
            : null;
    if (rank === null) continue;
    matches.push({ name, label, rank, ...(prefix === undefined ? {} : { prefix }) });
  }

  if (matches.length === 0) return null;

  // Rank first, then alphabetically by the part the reader is scanning. Sorting
  // by the full name instead would file every bridged command under `a`, which
  // is the prefix's fault and not something the reader should have to know.
  matches.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return { query, matches };
}

/**
 * The draft that accepting a command produces.
 *
 * The trailing space is the point: every command that takes arguments needs one
 * next, and the ones that do not are unharmed by it — the provider trims. It
 * also means the menu closes on accept, because the draft stops being a single
 * slash token, which is what makes Enter send on the very next press.
 */
export function applySlashCommand(name: string): string {
  // Canonicalised again rather than trusted: this is exported, and a caller
  // passing the provider's raw string would otherwise send `//compact`.
  return `/${canonical(name)} `;
}
