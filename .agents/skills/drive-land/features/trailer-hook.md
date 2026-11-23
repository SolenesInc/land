# Trailer hook

Once `land` or `land init` has run in a clone, a commit made inside an attn
session carries `Attn-Session: <session>` and one `Attn-Seed: <seed>` per seed
the session tends, as git trailers. A reader of `main` can then find the
session and the seed behind each commit. Outside attn, commits are unchanged.

## Sub-features

- `trailer-add` adds the trailers when `ATTN_INSIDE_APP=1` and
  `attn presence --session-id` answers. Seeds come from
  `attn presence --seed-ids`.
- `trailer-once` adds each trailer only when the message has none, so an
  amend or a message that already names a session keeps what it has.
- `trailer-absent` does nothing without `ATTN_INSIDE_APP=1`, without `attn` on
  the `PATH`, or when `attn presence` exits non-zero. The commit succeeds.
- `trailer-rebase` does nothing during a rebase, so `land`'s rebase keeps each
  commit's trailers as they were.
- `trailer-install` is installed with the [Push hook](push-hook.md), by the
  same rules: the clone's shared `.git/hooks`, nothing when `core.hooksPath`
  is set (warning only if that hooks directory lacks a `prepare-commit-msg`
  hook referencing `Attn-Session:`), and a warning on every landing when
  another `prepare-commit-msg` is there without `Attn-Session:`.

## How to get to it

### People

- `git commit` in a clone where `land` or `land init` has run, from a shell
  inside attn.

### Agents

- The same command, from an agent session attn runs.

### Triggers

- Git runs the hook on every commit, amend, merge and cherry-pick.

## Driving it

Preconditions:

- A fresh run, `r`. Run the steps in order. A world clears no `ATTN_`
  variable and keeps your `PATH`, so each commit below puts a fake `attn`
  first on the `PATH` and sets `ATTN_INSIDE_APP` itself.

- **Install.** Run
  `drive.ts r do lander 'echo two >> story.txt && git commit -qam "Second line" && land && sed -n 2p .git/hooks/prepare-commit-msg'`.
  It lands, and prints
  `# Installed by land. It adds Attn-Session and Attn-Seed to a commit made in an attn session.`
- **A fake attn.** Run
  `drive.ts r do home 'mkdir -p fake && printf "#!/bin/sh\ncase \"\$2\" in --session-id) echo session-1;; --seed-ids) echo s-one;; *) exit 2;; esac\n" > fake/attn && chmod +x fake/attn'`.
- **In a session.** Run
  `drive.ts r do lander 'PATH=$HOME/fake:$PATH ATTN_INSIDE_APP=1 git commit -q --allow-empty -m "In a session" && git log -1 --format=%B'`.
  The message ends with `Attn-Session: session-1` and `Attn-Seed: s-one`.
- **Outside a session.** Run
  `drive.ts r do lander 'PATH=$HOME/fake:$PATH ATTN_INSIDE_APP= git commit -q --allow-empty -m "Outside" && git log -1 --format=%B'`.
  It prints `Outside` alone.
- **A failing attn.** Run
  `drive.ts r do lander 'printf "#!/bin/sh\nexit 1\n" > $HOME/fake/attn && PATH=$HOME/fake:$PATH ATTN_INSIDE_APP=1 git commit -q --allow-empty -m "Failing attn" && git log -1 --format=%B'`.
  It exits 0 and prints `Failing attn` alone.
- **Land them.** Run `drive.ts r do lander land`, then
  `drive.ts r do origin.git 'git log -3 --format="%s %(trailers:only,unfold)" main'`.
  `In a session` keeps its trailers on `main`.
- **Proof.** The saved hook line, the three commit messages, and the second
  view of `main`.

## Contexts

- **Several worktrees of one clone.** The hook is in the shared `.git/hooks`,
  so commits from any worktree get trailers.
- **A clone with `core.hooksPath`.** No hook is installed. attn itself sets
  `core.hooksPath` and ships its own `prepare-commit-msg`.

## Tests

- `test/land.test.ts`: "after land, a commit made in an attn session names the
  session and its seeds", "a commit gets no attn trailer, and still succeeds,
  when attn is absent or fails", "land init installs the hooks, so a commit
  before the first land names its session", "land leaves another
  prepare-commit-msg hook as it is, and says so".

## Gotchas

- The real `attn` on your `PATH` answers inside an attn session. In a world,
  put the fake first on the `PATH`, or a drive records your own session.
- Nothing removes the hook. Delete `.git/hooks/prepare-commit-msg` by hand.
- A clone that had `land`'s pre-push hook before this hook existed gets the
  trailer hook at its next landing, or at `land init`.
