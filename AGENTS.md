# land

This repository lands on `main` with `land`, with no pull request.
Before you land a change, run `land guide` and follow it.

The gate is `bun run check`: typecheck, formatting, and the tests, which build
`dist/land` and drive it against real git repositories. Run `bun install`
first in a fresh worktree.
