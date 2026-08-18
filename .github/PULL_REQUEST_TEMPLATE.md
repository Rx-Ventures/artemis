<!--
  ⚠️  Artemis is not accepting outside pull requests yet.

  If you are not a maintainer, this PR will be closed with a link to
  CONTRIBUTING.md. That is the pause doing what it says — it is not a judgement
  of your work.

  The short version: the provider seam has been tested once, with Codex. Until
  the OpenCode adapter lands, the interfaces you would be building on are still
  allowed to move, and a PR against them could be invalidated by the very change
  that proves them.

  Found a bug? Please open an issue instead. The fix will land, with credit,
  through the normal roadmap.

    https://github.com/Rx-Ventures/artemis/blob/main/CONTRIBUTING.md
-->

## What is different now

<!-- One or two sentences from the reader's side of the change, present tense. -->

## Why

<!-- What was wrong, or what became possible. Link the issue if there is one. -->

## Checks

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm smoke` (if the change touches core, adapters or env resolution)

## Boundaries

<!-- Delete any line that the change cannot possibly affect. -->

- [ ] No new `electron` dependency in `@rx-artemis/core`
- [ ] No filesystem or Node reach from `@rx-artemis/protocol` or the renderer
- [ ] No new preload channel, or a new one that is fixed at build time and never
      named from renderer input
- [ ] No credential variable survives into a run's environment
- [ ] No other product's branding, visual identity or ASCII art
