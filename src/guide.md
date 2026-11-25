# Land on main

This repository lands changes straight on `main`, with no pull request. A
landing is one push of finished commits through `land`. `land` rebases your
branch onto `origin/main`, runs the gate that `land.toml` names, and pushes.
Your work ends when `land` pushes. After that, CI on `main` runs the
repository's full checks, and the repository may review what landed and repair
a red `main` (`land guide review`, `land guide sheriff`).

These steps hold in every repository that lands with `land`. A repository
adopts `land` with `land init`, which writes `land.toml` and the two lines of
guidance that point here. The repository's own guidance names its checks, its
review skills, and anything it adds to a step. Where the two disagree, the
repository's guidance wins.

## Branch

Work on a private, short-lived branch from the latest `main`. Never open a
pull request from it, and never push it under its own name.

```bash
git fetch origin main && git switch -c <name> origin/main
```

Rebase onto `origin/main` at the start of every step. Land each slice as soon
as it works, because commits held back on a branch collect conflicts. Land
unfinished work unwired, or behind a setting that is off by default.

## Commit

Write each commit message for a reader of `main`: state what changed and why.
When a slice adds code that nothing uses yet, say in one line what will use it
and which plan or seed names it. When a commit fixes a registered bug (from a
review message or `land bugs --open`), add a `Fixes-Bug: <id>` trailer in the
commit's trailer block (repeatable, one per bug) so landing closes it
automatically; you can also pass `land --fixes <id>`.

Commit as yourself. `land` refuses commits whose author differs from your
global git identity, and prints how to fix them. To commit under another
identity, pass `git -c user.email=...` on that one command. Never run
`git config` in a linked worktree: it writes to the config that every worktree
of the clone shares.

## Check

Run the targeted tests that cover the behavior you changed. Then check the
change on every surface it touches (the CLI, the API, the UI) the way a person
or another program uses it. The repository's guidance names those checks and
how to reach each surface. Do not run the full suite by hand: the gate runs
before the push, and CI runs the full check on `main` after it.

## Review

Review the slice before it lands. Scale the review to the risk of the slice:

| Slice                                                                   | Review                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A trivial one-liner, or a clean revert                                  | none                                                               |
| Docs, agent guidance, prompts or help text only                         | the repository's review skills that cover the change               |
| Any other change                                                        | the repository's review skills and one adversarial reader          |
| Risky: concurrency, process lifecycle, migrations, wire protocols, auth | the repository's review skills and up to three adversarial readers |

An adversarial reader looks for defects that a user or a later landing would
hit. Give each reader of a risky slice its own scope:

- Correctness: edge cases, concurrency, restarts, other platforms, and what
  the user sees.
- Every surface: the parallel paths the change must reach. These include other
  entry points, clients, platforms, wire contracts, docs, and the way back out
  of anything new.
- Extra machinery: each new layer, option, fallback, cache, or copy of state,
  and the current requirement that it serves.

Run each reader independently. Give it only the diff
(`git diff origin/main...HEAD`), what the slice is for, and the guidance the
slice names. Readers report findings; they do not edit files.

When every reader reports back, merge duplicate findings and verify each one
against the code. Fix the findings that stand, check the fixes as in Check,
and commit. Settle uncertain findings yourself, or ask.

## Note

When the change has a visible surface (a screen, a page, or a terminal),
capture it first:

```bash
land record [args]
```

`land record` runs the `record` command from `land.toml` and prints one
markdown line per new recording, such as `![banner](.land/media/banner.mp4)`.

Write a brief note for the landing in `.land/note.md`. Write for a reader of
`main` who lands cold on the feed: state in a few lines what changed for them,
why, and any non-obvious trade-off. Paste the recording's line when you made
one, and add a small diagram when one clarifies the flow. Do not paste test
logs or commit lists.

`land` adds `.land/` to the clone's `.git/info/exclude`, so the note is never
committed and never triggers the untracked-file check. To keep the note
elsewhere, run `land --note <file>` instead of `land`.

A note may link a local recording only when `land.toml` names a `feed`. Before
the gate runs, `land` rewrites each local link to its feed address, lists the
file in `landing.json`, and uploads it after the push. Any recording that
fails to upload waits in the outbox on your machine, and the next `land` in
any repository sends it. A feed outage never blocks a landing.

`land` pushes the note beside `main` in the landing ref `refs/landings/<head>`
and deletes the note file after the push. When `land` pushes nothing, the note
stays for the next attempt. A note cannot change after it lands.

## Land

```bash
land
```

`land` stops before the push in these cases and says why:

- Your worktree has uncommitted changes. Commit or stash them.
- Your worktree has untracked files that git does not ignore. The gate runs in
  the worktree and must see only what lands. Commit, remove, or ignore each
  listed file, then run `land` again.
- A commit's author differs from your global git identity. Fix the commits as
  the message says.
- The rebase onto `origin/main` conflicts. When `land.toml` names a `resolve`
  command (for example to regenerate generated files), `land` runs it first
  and continues the rebase if it resolves and stages the conflicts. On any
  other conflict, `land` aborts the rebase, leaves your branch as it was, and
  names the conflicted files. Rebase with `git rebase origin/main`, rerun the
  checks the resolution touches, and run `land` again.
- The note links a missing file, a recording over 200 MB, or a local recording
  when `land.toml` names no `feed`.
- The gate fails. `land` pushes nothing, records the failure for this diff's
  patch-id, and exits with the gate's status. Never re-run the gate or a
  failing test blindly hoping it passes: `land` refuses a second run on the
  same unchanged diff until you either change the diff or acknowledge a
  diagnosed, owned flake. To triage a failing test, even in code you did not
  touch:
  1. Read the failure output and the failing test and product code. Do not
     dismiss a failure as a timing race, host load, or unrelated from its
     name alone.
  2. Check whether a newer commit on `origin/main` already fixed the failure.
     If one did and your diff stays unchanged, run
     `land --ack-flake <test> --owner <fix-sha>`.
  3. Otherwise, run a paired reproduction (`5` to `10` runs, or under a race
     detector) on `HEAD` and on `origin/main` in a scratch worktree. Never
     treat a single passing rerun as proof of a flake.
  4. If it fails only on `HEAD` or more often on `HEAD` than on `origin/main`,
     your change caused or worsened it: fix it before landing.
  5. If it fails on `origin/main` at the same rate, or if both checkouts pass
     all runs while history or the trace shows an existing flake outside your
     change, fix the root cause cleanly when the fix is small and within your
     scope (in its own commit or a separate landing from `origin/main`),
     without widening assertions, adding retries, or raising timeouts.
     Otherwise attach your traced diagnosis (failing line, root mechanism,
     paired counts) to an active tracking issue or seed with an owner, then
     run `land --ack-flake <test> --owner <issue-or-seed>`.

Every landing pushes `main` and `refs/landings/<head>` in one atomic push, so
both move or neither does. The ref's commit holds `landing.json` (what `land`
knew at the push) and `note.md` when you wrote one.

When `main` moves while the gate runs, `land` rebases and pushes without
running the gate again, and prints
`land: main moved after the gate ran on <commit>`. Your checks still count;
name that commit in your report.

If the last lines of output print
`land: WARNING: this landing undoes earlier commits on main`, check the listed
commits right away. The push has already happened. If you did not mean to undo
them, restore each one in a new landing with `git cherry-pick` and say so in
your report.

The first `land` or `land init` in a clone installs a `pre-push` hook that
refuses a plain `git push` to `main` (and a `prepare-commit-msg` hook for attn
trailers), unless the clone manages its own hooks via `core.hooksPath`. Use
`git push --no-verify` only when `land` cannot run, and only after you run the
gate yourself.

## Report

Report where the work was asked for:

- the landed commits from `land: push   main is at <commit>`, and the commit
  the gate ran on when `main` moved
- the landing address from `land: feed   <address>`, and any recording `land`
  says waits in the outbox
- what you checked, on which surface, with the evidence
- the review: which readers ran, the confirmed findings you fixed, and the
  findings you refuted
- any acknowledged flake (`--ack-flake` and its `--owner`), and any
  undone-commit warning you acted on

## After the push

Do not watch CI on `main` unless the repository's guidance asks you to.

### Respond to reviews and sheriff notices

A reviewer or the sheriff may send you a finding to fix or notify you that
your commit was reverted because it broke `main`. Fix it the same way you
landed it: start a new branch from `origin/main`, make the fix, check it, and
land it with `land`. To land reverted work again, run
`git revert <revert sha>` on that branch first, fix the underlying problem,
and land. Report the fix to whoever notified you.

When a person leaves post-landing review comments on the feed:

1. Read the full context with `land show <sha-or-url>` (prints the landing
   note, open comments with surrounding diff hunks, and registered bugs), or
   list open comments across the repository with `land comments --open`.
2. Fix the issue on a new branch from `origin/main` and land it with `land`.
3. Close the loop by marking each addressed comment resolved:
   `land comments resolve <id> --by <fix-sha>`.

### Record bugs you trace

When you diagnose a bug caused by an earlier commit `<culprit>`, record it on
the feed so humans and future agents can trace regressions in that area:

```bash
land bug <culprit> --title "<summary>" --severity p0|p1|p2 [--location path:line] [--fixed-by <fix-sha>]
```

`land bug` prints the bug's short id (`land: id <id>`). When you land a fix for
an open bug, include `Fixes-Bug: <id>` in the commit's trailer block (or pass
`land --fixes <id>`) so the landing closes that bug on push. To close a bug
whose fix already landed without a trailer, run:

```bash
land bug resolve <id> --by <fix-sha>
```

Inspect past regressions in an area before editing it with
`land bugs --path <prefix>` or `land bugs --open`. For private repositories,
check token setup with `land auth status` (`LAND_FEED_TOKEN` or
`land auth token <token>`).
