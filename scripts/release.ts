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
