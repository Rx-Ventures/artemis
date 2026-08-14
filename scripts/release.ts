/**
 * Cut a release: gate locally, then hand the build to GitHub Actions.
 *
 * One command — `pnpm release` — checks that this machine's tree deserves a
 * release and pushes the tag that makes `.github/workflows/release.yml` build
 * it: every platform on its own native runner, boot-verified, published as one
 * GitHub release with the per-arch update feeds.
 *
 *   1. clean tree, on main, up to date gates
 *   2. typecheck + full test suite (CI runs them again; failing here is
 *      simply faster than failing there)
 *   3. git tag vX.Y.Z, push main + tag → Actions takes it from here
 *
 * The version is read from apps/desktop/package.json — bump it there first.
 * Release notes are `.github/RELEASE_NOTES.md`, versioned with the code.
 *
 * This script used to build and publish from the local machine. It stopped
 * because a laptop can only build its own platform: the Agent SDK ships one
 * native binary per platform and pnpm installs only the host's, so the
 * Windows and Intel artifacts have to come from runners that *are* those
 * platforms.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { applyBump, inspectSinceLastTag, satisfies } from './nextVersion.js';

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
/*
 * Up to date means *equal to* origin/main, not merely not-behind. Behind would
 * tag a commit that is missing merged work; ahead would push commits to main
 * as a side effect of releasing, which is not what anyone running `pnpm
 * release` said they wanted. Either way the remedy is the same: make local
 * main and origin/main agree first.
 */
capture('git', ['fetch', 'origin', 'main']);
if (capture('git', ['rev-parse', 'HEAD']) !== capture('git', ['rev-parse', 'origin/main'])) {
  fail('local main and origin/main disagree — pull (or push through review) first.');
}
try {
  capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  fail(`tag ${tag} already exists — bump the version in apps/desktop/package.json.`);
} catch {
  // tag absent: exactly what we want
}

/*
 * The notes have to be about this release. `release.yml` publishes
 * `.github/RELEASE_NOTES.md` verbatim as the release body, and nothing in that
 * pipeline reads the file's contents — so notes left over from the previous
 * version would go out under the new one's heading-less name, telling every
 * updater's "what's new" card a story about the release before it. The file's
 * convention is a `## What's new in X` heading per version; the one for the
 * version being cut has to exist before the tag does.
 */
const notes = readFileSync('.github/RELEASE_NOTES.md', 'utf8');
if (!notes.includes(`What's new in ${version}`)) {
  fail(
    `.github/RELEASE_NOTES.md never mentions ${version} — it still leads with the previous ` +
      `release's notes.\n        Add a "## What's new in ${version}" section (it publishes verbatim), then re-run.`,
  );
}

/*
 * Does the number match what shipped?
 *
 * The version is chosen by hand, in a commit written at the end of the work,
 * which is the worst moment to be asked "did anything grow a new surface since
 * the last tag?" — the answer is spread across a fortnight of commits and
 * nobody has it. So it is read off the diff instead. See `nextVersion.ts` for
 * what counts as what.
 *
 * A *bigger* bump than the changes call for is fine and passes: deciding to ship
 * a minor where a patch would do is a judgement someone is allowed to make. The
 * mistake worth catching is the other one — a new pane and a new IPC channel
 * going out as a patch, which tells everyone downstream that nothing grew.
 *
 * `--bump-anyway` exists because a tool that cannot be overruled becomes a
 * reason to stop cutting releases. It says so in the output, so the override is
 * a decision someone made rather than a silent bypass.
 */
const { from, verdict } = inspectSinceLastTag();
if (from !== null) {
  console.log(`\nrelease: since ${from}, this looks like a ${verdict.bump} release.`);
  for (const reason of verdict.reasons) console.log(`  • ${reason}`);

  if (verdict.bump === 'none') {
    fail('nothing has shipped since the last tag — only notes and tests changed.');
  }
  if (!satisfies(from, version, verdict.bump)) {
    const wanted = applyBump(from, verdict.bump);
    if (!process.argv.includes('--bump-anyway')) {
      fail(
        `apps/desktop/package.json says ${version}, but the changes above call for ${wanted}.\n` +
          `        Bump the version, or re-run with --bump-anyway if you mean it.`,
      );
    }
    console.log(`release: shipping ${version} anyway, against a ${verdict.bump}'s worth of change.`);
  }
}

// ---- 2. Quality gates -----------------------------------------------------

run('pnpm', ['typecheck']);
run('pnpm', ['test']);

// ---- 3. Tag; Actions builds and publishes ---------------------------------

run('git', ['tag', tag]);
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', tag]);

console.log(`
release: ${tag} is tagged. GitHub Actions is building macOS (arm64 + x64) and
Windows natively, boot-verifying each, and publishing the release:

  watch:   gh run watch
  result:  gh release view ${tag}
`);
