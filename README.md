# land

`land` lands finished commits on a repository's `main`, with no pull request.
It rebases your branch onto `origin/main`, runs the repository's gate, and
pushes:

```text
$ land
land: gate   bun run check   ok in 1m 49s
land: push   main is at 41d07be
```

`land` refuses to start while the worktree has uncommitted changes or untracked
files that git does not ignore, because the gate runs in the worktree and must
see only what lands. When the rebase conflicts, `land` aborts it, names the files, and leaves your
branch as it was. When the gate fails, `land` pushes nothing and exits with the
gate's status. When `main` moves while the gate runs, `land` rebases and pushes
without running the gate again, and names the commit the gate ran on. Lands
from several worktrees of one clone can run at once.

`land guide` prints the procedure around a landing: branch, commit, check,
review, land and report.

## Install

Run this on macOS arm64 or Linux x64. The binary needs no Bun.

```bash
mkdir -p ~/.local/bin && curl -fsSL "https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m)" -o ~/.local/bin/land && chmod +x ~/.local/bin/land
```

Put `~/.local/bin` on your `PATH`, then check the install with `land --version`.

## Adopt land in a repository

Run `land init` at the root of a clone:

```text
$ land init
land: land.toml  wrote gate = "bun run check", from the check script in package.json
land: AGENTS.md  added the trunk declaration under ## Landing

Decide:
  - Whether bun run check should run before every push. It holds every landing until it passes, so name a faster check in land.toml if it is slow, and leave the rest to CI.

Then commit land.toml and AGENTS.md, and land the commit with land.
```

It writes two things, and never overwrites either:

1. `land.toml`, which names the gate: the checks that must pass before a push.
   `land init` proposes the first of these it finds: a `check` script in
   `package.json`, a `check` target in the `Makefile`, a `test` script, a
   `test` target, `go test ./...` for a `go.mod`, or `cargo test` for a
   `Cargo.toml`. When it finds none, it writes no `land.toml` and asks you to
   name the gate. When the clone's `origin/HEAD` names a branch other than
   `main`, it adds `main = "<branch>"`. A clone made with `git clone` has
   `origin/HEAD`; set it in another with `git remote set-head origin --auto`.

   `land` runs the gate with `sh -c` at the repository root, and sets
   `LAND_BASE` to the `origin/main` commit the landing sits on and `LAND_HEAD`
   to the commit it pushes. Leave `gate` out only if the repository has no
   checks.

2. The trunk declaration, two lines appended under `## Landing` to
   `AGENTS.md`, or to `CLAUDE.md` when only that exists. With neither, it
   creates `AGENTS.md` holding only the two lines.

   ```markdown
   This repository lands on `main` with `land`, with no pull request.
   Before you land a change, run `land guide` and follow it.
   ```

A second `land init` changes nothing.

The first `land` in a clone, or `land init`, installs two hooks in the
clone's `.git/hooks`, so every worktree has them:

- `pre-push` refuses a plain `git push` to `main`.
- `prepare-commit-msg` adds `Attn-Session:` and `Attn-Seed:` trailers to a
  commit made inside an attn session,
  from `attn presence`. Anywhere else it does nothing, and it never fails a
  commit.

`land` installs no hook when the clone sets `core.hooksPath`, and leaves a
hook of the same name that it did not install. It says so on every landing.

## Develop

```bash
bun install
bun run check
```

`bun run check` typechecks, checks formatting, and runs the tests, which build
the binary and drive it against real git repositories. This repository lands
with its own `land`. CI runs the same check on `main` on Ubuntu and macOS.

To release, change `version` in `package.json` and land the change. CI then
publishes the binaries as the GitHub release `v<version>`.
