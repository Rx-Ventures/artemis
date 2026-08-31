/**
 * A bug report, as a URL.
 *
 * The submit path is GitHub's own `issues/new` form, prefilled over the query
 * string and opened in the system browser. Everything in this module is pure so
 * it can be unit-tested the way `format.ts` is; the dialog owns the fields and
 * the one side effect (opening the link).
 *
 * ## Why the browser and not an API call
 *
 * Creating an issue through the REST API needs a credential, and Artemis holds
 * none — the same position the updater documents at length, and a stronger one
 * now that the repository is public: a token shipped inside a public app is a
 * published token. The alternatives are a hosted proxy that owns one (a service
 * to run, rate-limit and abuse-protect, for a form) or the user's own `gh`,
 * which only some machines have.
 *
 * Handing off to the browser needs none of that. The reporter is whoever is
 * signed in to GitHub, which is also the right answer for a public repository:
 * an issue with a real account behind it can be replied to, and the reporter
 * gets the thread in their notifications rather than posting into a void. The
 * cost is one extra click — GitHub shows the filled form and the user presses
 * *Create*, which is also the last chance to read what is about to be public.
 *
 * ## The length ceiling is real
 *
 * A prefilled body travels in the query string, and GitHub answers a long
 * enough URL with `414 URI Too Long` rather than a form. The ceiling is not
 * documented, so {@link MAX_URL_LENGTH} is set well under where it is reported
 * to bite. Past it, {@link buildIssueUrl} trims the prose and *says* it did —
 * the dialog puts the untrimmed body on the clipboard, because silently
 * shortening somebody's bug report is how a report arrives missing the sentence
 * that mattered.
 */

import { ARTEMIS_REPO } from '@rx-artemis/protocol';

/**
 * The repository issues are filed against — the one Artemis is published from,
 * so it reads the shared constant rather than keeping a second copy.
 *
 * A report filed through a redirect is a report filed somewhere we do not
 * control if that redirect ever lapses, which is why this is worth pinning at
 * all; {@link ARTEMIS_REPO} is where it is now pinned, alongside the updater's
 * copy of the same fact.
 */
export const ISSUES_REPO = ARTEMIS_REPO;

/** The label every submission carries, so in-app reports are filterable. */
const LABEL = 'bug';

/**
 * The longest URL we will hand the browser.
 *
 * Measured against github.com rather than guessed, because the limit is not
 * documented: a ~6.0k URL is served, ~8.1k already fails to complete, and ~12k
 * and up answer `414 URI Too Long`. So the cliff is somewhere in the 6k–8k
 * range, and this sits below it with room to spare rather than on the edge of
 * the last length observed to work.
 *
 * It still carries something like 3500 characters of prose — several hundred
 * words, which is a long bug report and not a cramped one. Worth re-measuring if
 * reports ever come back truncated.
 */
export const MAX_URL_LENGTH = 5500;

/** What the form collected. */
export interface BugReportDraft {
  readonly title: string;
  readonly whatHappened: string;
  readonly steps: string;
  readonly includeDiagnostics: boolean;
}

/** The build this report came from. Read from the store, never typed by hand. */
export interface BugReportDiagnostics {
  readonly version: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
}

/** What {@link buildIssueUrl} produced, and whether anything was lost doing it. */
export interface BuiltIssueUrl {
  readonly url: string;
  /** The body as composed, before any trimming — what the clipboard gets. */
  readonly body: string;
  /** True when {@link url} carries less than {@link body} does. */
  readonly trimmed: boolean;
}

/** The platform, spelled the way a person would write it in a bug report. */
export function platformLabel(platform: BugReportDiagnostics['platform']): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * Is there enough here to file?
 *
 * A title alone is not a bug report, and a body with no title produces an issue
 * list nobody can scan. Both, non-blank.
 */
export function isSubmittable(draft: BugReportDraft): boolean {
  return draft.title.trim() !== '' && draft.whatHappened.trim() !== '';
}

/**
 * The issue body, as markdown.
 *
 * Headings rather than a template's checklists: this text was typed into a form
 * that already asked the questions, so repeating them in the output would leave
 * every issue restating its own labels back at whoever opens it.
 */
export function composeIssueBody(
  draft: BugReportDraft,
  diagnostics: BugReportDiagnostics,
): string {
  const sections: string[] = [draft.whatHappened.trim()];

  const steps = draft.steps.trim();
  if (steps !== '') sections.push(`## Steps to reproduce\n\n${steps}`);

  if (draft.includeDiagnostics) {
    const version = diagnostics.version === '' ? 'unknown' : diagnostics.version;
    sections.push(
      `## Environment\n\n- Artemis ${version}\n- ${platformLabel(diagnostics.platform)}`,
    );
  }

  sections.push('<sub>Submitted from Artemis.</sub>');
  return sections.join('\n\n');
}

/**
 * Trim `body` to fit, on a paragraph boundary where possible.
 *
 * Cutting at the last blank line before the limit keeps the result readable
 * markdown instead of a sentence that stops mid-word; a body with no blank line
 * to cut at falls back to a hard slice. Either way the note at the end is part
 * of the budget, so what comes back always fits.
 */
function trimBody(body: string, budget: number): string {
  const note = '\n\n*(Trimmed to fit — the full text is on your clipboard; paste to restore it.)*';
  const room = budget - note.length;
  if (room <= 0) return body.slice(0, Math.max(0, budget));
  const head = body.slice(0, room);
  const lastBreak = head.lastIndexOf('\n\n');
  return `${lastBreak > room / 2 ? head.slice(0, lastBreak) : head.trimEnd()}${note}`;
}

/**
 * The prefilled `issues/new` URL for one draft.
 *
 * Built by measuring rather than guessing: the query is assembled with the full
 * body, and only if the result is over the ceiling is the body trimmed to the
 * room actually left by the title, the label and the encoding. That keeps the
 * ceiling honest for a one-line title and a long one alike, since percent
 * encoding means a character of prose is not a character of URL.
 */
export function buildIssueUrl(
  draft: BugReportDraft,
  diagnostics: BugReportDiagnostics,
): BuiltIssueUrl {
  const body = composeIssueBody(draft, diagnostics);
  const base = `https://github.com/${ISSUES_REPO}/issues/new`;

  const query = (withBody: string): string => {
    const params = new URLSearchParams({
      title: draft.title.trim(),
      body: withBody,
      labels: LABEL,
    });
    return `${base}?${params.toString()}`;
  };

  const full = query(body);
  if (full.length <= MAX_URL_LENGTH) return { url: full, body, trimmed: false };

  // How much of the ceiling the body is using, and so how much prose fits: the
  // encoded body's share of the over-long URL, scaled back to raw characters.
  const overhead = full.length - encodeURIComponent(body).length;
  const encodedRoom = Math.max(0, MAX_URL_LENGTH - overhead);
  const ratio = encodeURIComponent(body).length / Math.max(1, body.length);
  let candidate = trimBody(body, Math.floor(encodedRoom / Math.max(1, ratio)));
  // The ratio is an estimate — a trimmed tail can hold a different mix of
  // characters than the whole. Settle it by measuring, then shrinking.
  while (candidate.length > 0 && query(candidate).length > MAX_URL_LENGTH) {
    candidate = trimBody(candidate, Math.floor(candidate.length * 0.9));
  }
  return { url: query(candidate), body, trimmed: true };
}
