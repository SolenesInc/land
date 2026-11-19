# land

This repository lands on `main` with `land`, with no pull request.
Before you land a change, run `land guide` and follow it.

The gate is `bun run check`: typecheck, formatting, and the tests, which build
`dist/land` and drive it against real git repositories. Run `bun install`
first in a fresh worktree.

Before you report a change done, drive it with the `drive-land` skill
(`.agents/skills/drive-land`) and show its evidence. A change that adds,
removes or alters a way into a feature updates that feature's file in
`.agents/skills/drive-land/features` in the same landing.
