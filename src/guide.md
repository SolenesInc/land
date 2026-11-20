# Land on main

This repository lands changes straight on `main`, with no pull request. A
landing is one push of finished commits through `land`. `land` rebases your
branch onto `origin/main`, runs the gate that `land.toml` names, and pushes.
Your work ends when `land` pushes. After that, CI on `main` runs the
repository's whole check.

These steps hold in every repository that lands with `land`. A repository
adopts `land` with `land init`, which writes `land.toml` and the two lines of
guidance that point here. The repository's own guidance names its checks, its
review skills and anything it adds to a step. Where the two disagree, the
repository's guidance wins.

## Branch

Work on a private, short-lived branch from the latest `main`. Never open a
pull request from it, and never push it under its own name.

```bash
git fetch origin main && git switch -c <name> origin/main
```

Rebase onto `origin/main` at the start of every step. Land each slice as soon
as it works, because commits held back on the branch turn into conflicts. Land
unfinished work unwired, or behind a setting that is off by default.

## Commit

Write each commit message for a reader of `main`: say what changed and why.
When the slice adds code that nothing uses yet, say in one line what will use
it and which plan says so.

Commit as yourself. `land` refuses commits whose author is not your global git
identity, and says how to fix them. To commit under another identity, use
`git -c user.email=…` on that one command. Never run `git config` in a
worktree: it writes to the config that every worktree of the clone shares.

## Check

Run the tests that cover the behavior you changed. Then check the change on
the surface it touches, such as the command line, the API or the interface,
the way someone would use it. The repository's guidance names those checks
and how to reach each surface. Do not run the whole suite by hand: the gate
runs before the push, and CI runs the whole check on `main` after it.

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
- Every surface: the parallel paths the change should reach. These are the
  other entry points, clients and platforms, the wire contract, the docs, and
  the way back out of anything new.
- Extra machinery: each new layer, option, fallback, cache or copy of state,
  and the current requirement that it serves.

Run each reader on its own. Its only context is the diff
(`git diff origin/main...HEAD`), what the slice is for, and the guidance the
slice names. Readers report. They do not edit.

When every reader has reported, merge duplicate findings. Try to refute each
finding against the code. Fix the findings that stand, check the fixes as in
Check, and commit. Settle the uncertain ones yourself, or ask.

## Land

```bash
land
```

`land` stops before the push in these cases, and says why:

- Your worktree has uncommitted changes. Commit or stash them.
- Your worktree has untracked files that git does not ignore. The gate runs
  in the worktree, so it could pass because of a file the landing does not
  contain. Commit, remove or ignore each file that `land` names.
- A commit's author is not your global git identity. Fix the commits as the
  message says.
- The rebase onto `origin/main` conflicts. `land` aborts the rebase, so your
  branch is as it was, and names the files. Resolve the conflict with
  `git rebase origin/main`, rerun the checks the resolution touches, and run
  `land` again.
- The gate fails. `land` exits with the gate's status. Fix the failure and run
  `land` again. If the failure is in code you did not touch and it passes on
  `origin/main`, it may be a flake: run `land` again, and name the test in
  your report.

When `main` moves while the gate runs, `land` rebases and pushes without
running the gate again, and prints
`land: main moved after the gate ran on <commit>`. Your checks still count.
Name that commit in your report.

The first `land` in a clone installs a pre-push hook that refuses a plain
`git push` to `main`. Use `git push --no-verify` only when `land` cannot run,
and only after you run the gate yourself.

## Report

Report where the work was asked for:

- the landed commits, from `land: push   main is at <commit>`, and the commit
  the gate ran on when `main` moved
- what you checked, on which surface, with the evidence
- the review: which readers ran, the findings you fixed, and the findings you
  refuted
- any test that failed and passed on a second run

Do not watch CI on `main` unless the repository's guidance asks you to.
