/**
 * Cut a release: gate, build, verify, tag, publish to GitHub.
 *
 * One command — `pnpm release` — takes the working tree to a downloadable
 * GitHub release, and refuses to start from anything less than a clean,
 * fully-gated state:
 *
 *   1. clean tree, on main, tag for this version not yet taken
 *   2. typecheck + full test suite
 *   3. production build, then electron-builder (dmg + zip, no publish)
 *   4. verify-package: the packaged app must actually boot
 *   5. git tag vX.Y.Z, push main + tag
 *   6. `gh release create` with the artifacts and the update feed
 *
 * The version is read from apps/desktop/package.json — bump it there first.
 * Release notes come from RELEASE_NOTES.md at the repo root when present,
 * otherwise a default alpha template is used.
 *
 * Publishing goes through `gh` rather than electron-builder's publisher so the
 * release only exists after every gate has passed, and so a stray GH_TOKEN in
 * the environment can never publish a half-built artifact.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RELEASE_DIR = 'apps/desktop/release';

function run(command: string, args: readonly string[]): void {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, [...args], { stdio: 'inherit' });
}

function capture(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: 'utf8' }).trim();
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

// ---- 1. Gates -------------------------------------------------------------

const { version } = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')) as {
  version: string;
};
const tag = `v${version}`;

if (capture('git', ['status', '--porcelain']) !== '') {
  fail('working tree is not clean — commit or stash first.');
}
if (capture('git', ['branch', '--show-current']) !== 'main') {
  fail('releases are cut from main.');
}
try {
  capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  fail(`tag ${tag} already exists — bump the version in apps/desktop/package.json.`);
} catch {
  // tag absent: exactly what we want
}
capture('gh', ['auth', 'status']); // throws if gh is not signed in

// ---- 2. Quality gates -----------------------------------------------------

run('pnpm', ['typecheck']);
run('pnpm', ['test']);

// ---- 3. Build + package ---------------------------------------------------

run('pnpm', ['run', 'build']);
run('pnpm', [
  '--filter',
  '@rx-artemis/desktop',
  'exec',
  'electron-builder',
  '--publish',
  'never',
]);

// ---- 4. The packaged app must boot ----------------------------------------

run('tsx', ['scripts/verify-package.ts']);

// ---- 5. Tag ---------------------------------------------------------------

run('git', ['tag', tag]);
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', tag]);

// ---- 6. GitHub release ----------------------------------------------------

const assets = readdirSync(RELEASE_DIR)
  .filter((name) => /\.(dmg|zip|blockmap|yml)$/.test(name) && !name.startsWith('builder-'))
  .map((name) => join(RELEASE_DIR, name));
if (assets.length === 0) fail(`no artifacts found in ${RELEASE_DIR}.`);

const notes = existsSync('RELEASE_NOTES.md')
  ? readFileSync('RELEASE_NOTES.md', 'utf8')
  : `## Artemis ${version} — internal alpha

macOS, Apple Silicon. Unsigned internal build: if macOS blocks the first
launch, allow it under System Settings → Privacy & Security → "Open Anyway",
or clear the quarantine flag:

\`\`\`
xattr -dr com.apple.quarantine /Applications/Artemis.app
\`\`\`

### Install

Download the \`.dmg\`, drag Artemis into Applications.

### First run

1. You need Anthropic's \`claude\` CLI installed, and a Claude subscription.
2. In Artemis, open **Profiles** (⌘,) and create a profile.
3. Run the sign-in command Artemis shows you in your own terminal and finish
   in the browser — Artemis watches the profile directory and continues on
   its own. No credential ever passes through Artemis.
4. Set a working directory, send a prompt.

Runs are billed to the Claude account each profile is signed into.

Feedback: open an issue in this repo.
`;

const notesFile = join(tmpdir(), `artemis-release-notes-${version}.md`);
writeFileSync(notesFile, notes);

run('gh', [
  'release',
  'create',
  tag,
  ...assets,
  '--title',
  `Artemis ${version}`,
  '--notes-file',
  notesFile,
]);

console.log(`\nrelease: done — ${capture('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])}`);
