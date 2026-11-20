# Push hook

Once `land` has had something to land in a clone, a plain `git push` to `main` is refused
with a line that says to use `land`. A change then reaches `main` only through
the gate, unless someone decides to push past it.

## Sub-features

- `hook-install` installs the pre-push hook the first time `land` has
  something to land in a clone, before the gate runs, so the hook is there
  even when that gate fails. It goes in the clone's shared `.git/hooks`, so
  every worktree has it.
- `hook-refuse` refuses a plain push to `main`.
- `hook-other-branch` lets a push to any other branch through.
- `hook-no-verify` lets `git push --no-verify` through.
- `hook-hookspath` installs nothing in a clone that sets `core.hooksPath`, and
  says on every landing that it installs no hooks.
- `hook-foreign` leaves another pre-push hook as it is, and says on every
  landing that plain pushes are not refused.

## How to get to it

### People

- Run `git push` to `main` in a clone where `land` has run with something to
  land.

### Agents

- The same command.

### Triggers

- `land` installs the hook during a landing, and `land init` installs it
  (`installHooks` in `src/landing.ts`). Git runs the hook on every push.

## Driving it

Preconditions:

- A fresh run, `r`. Run the steps in order.

- **Before the first landing.** Run
  `drive.ts r do lander 'test -e .git/hooks/pre-push && echo installed || echo absent'`.
  It prints `absent`.
- **Install.** Run
  `drive.ts r do lander 'echo two >> story.txt && git commit -qam "Second line" && land'`,
  then `drive.ts r do lander 'cat .git/hooks/pre-push'`. The hook's second
  line is `# Installed by land. It refuses a plain push to main.`
- **Refuse.** Run
  `drive.ts r do lander 'echo three >> story.txt && git commit -qam "Third line" && git push origin HEAD:main'`.
  It prints
  `Land on main with land. To push past it, use git push --no-verify.` and
  exits 1.
- **Another branch.** Run
  `drive.ts r do lander 'git push -q origin HEAD:refs/heads/scratch'`. It
  exits 0.
- **Push past it.** Run
  `drive.ts r do lander 'git push -q --no-verify origin HEAD:main'`, then
  `drive.ts r do origin.git 'git log --format="%h %s" -1 main'`. `main` holds
  `Third line`.
- **A clone with `core.hooksPath`.** Run `drive.ts r clone hp`, then
  `drive.ts r do hp 'git config core.hooksPath .githooks && git switch -qc work && echo x >> story.txt && git commit -qam "From a clone with core.hooksPath" && land'`.
  It lands, and prints
  `land: core.hooksPath is set, so land installs no hooks: plain pushes to main are not refused, and land adds no attn trailers to commits`.
- **A clone with its own hook.** Run `drive.ts r clone fh`, then
  `drive.ts r do fh 'printf "#!/bin/sh\nexit 0\n" > .git/hooks/pre-push && chmod +x .git/hooks/pre-push && git switch -qc work && echo y >> story.txt && git commit -qam "From a clone with its own hook" && land'`.
  It lands, and prints
  `land: <path>/.git/hooks/pre-push is not land's hook, so plain pushes to main are not refused`.
  This step writes into `.git` by hand, because that is how such a hook gets
  there.
- **Proof.** The saved hook, the refused push with its exit status, and the
  second view after the push past it.

## Contexts

- **Several worktrees of one clone.** The hook is in the clone's shared
  `.git/hooks`, so it refuses a push from any of them.
- **A branch other than `main`.** The hook names the branch that `land.toml`
  named at the first landing.

## Tests

- `test/land.test.ts`: "a plain push to main is refused after land has run in
  the clone".

## Gotchas

- `land` installs the [Trailer hook](trailer-hook.md) by the same rules, at
  the same moment.

- Nothing on the remote enforces the hook. A clone where `land` never landed
  pushes to `main` freely, as `other` does in [Landing](landing.md).
- Nothing removes the hook. Delete `.git/hooks/pre-push` by hand.
- When `land.toml` changes `main` after the first landing, the hook still
  names the old branch, and `land` says nothing. No test covers it.
- The hook lets a push through when `LAND_LANDING=1`. Only `land`'s own push
  sets it. A gate does not get it, so a `git push` to `main` from inside a
  gate is refused. `drive.ts` clears every `LAND_` variable of your shell.
- A push with nothing new prints `Everything up-to-date` and exits 0 without
  asking the hook. Commit first.
