# Review main

Changes land on `main` through `land`, with no pull request, so they are
reviewed after they land. A review pass reviews every commit in
`origin/reviewed..origin/main`. The pass is done when every confirmed P0 and
P1 finding has reached someone who will fix it, and the branch `reviewed` on
origin points at the head you reviewed.

These steps hold in every repository that lands with `land`. Before you start,
read `.agents/land/review.md` at the repository root when it exists. It holds
what this procedure needs to know about the repository, such as files not to
review and who to ask. Where the two disagree, `.agents/land/review.md` wins.

## What your runner provides

Whatever starts this pass, such as a scheduled task, an automation or a person,
says in its prompt how it does each of these:

- **Start a reviewer.** A reviewer is a separate session, or a subagent of
  yours. You give it a unit and it reports findings. You do not review the
  code yourself.
- **Reach a lander.** Send a message to the session that landed a commit.
  Most runners cannot. Without it, the fallback in Route each finding applies.
- **Land a fix.** Run `land` with push access and the gate's toolchain. Without
  it, open an issue instead of fixing.
- **Ask a person.** The runner's own way. Without one, open a GitHub issue.

When the prompt says nothing about one of these, assume you do not have it.

## Find the range

```bash
git fetch origin
git rev-parse origin/main
git log --oneline origin/reviewed..origin/main
```

Call the commit `origin/main` points at `<head>`, and use it for the rest of
the pass, even when `main` moves. When the range is empty, stop: there is
nothing to review.

When `origin/reviewed` does not exist, the repository has not started review.
Ask a person which commit to start from, then create the branch there with
`git push origin <start>:refs/heads/reviewed`, and stop.

## Split the range into units

A unit is the commits one reviewer reads together:

1. Commits that share an `Attn-Seed:` trailer form one unit. A commit that
   names two seeds joins both units.
2. Other commits that share a session trailer, `Attn-Session:` or
   `Claude-Session:`, form one unit.
3. Every other commit is a unit of its own.

```bash
git log --reverse --format='%H%x09%an%x09%s%x09%(trailers:key=Attn-Seed,key=Attn-Session,key=Claude-Session,separator=%x3B%x20)' origin/reviewed..<head>
```

Split a unit of more than about 2,000 changed lines by area. Leave out files
that a build or a script generates.

## Review each unit

Give each unit to a reviewer. Run at most four reviewers at once. With more
than four units, give each reviewer several. Give each reviewer:

- its units: the commit shas, and the seed or session each one names
- `<head>`, and the instruction to judge the code at `<head>`
- the bar for a finding, in [What makes a finding](#what-makes-a-finding)
- the instruction to verify its findings before it reports, as below
- the files not to review, from `.agents/land/review.md`

Before a reviewer reports, it checks its findings with one fresh reader: a
subagent or session that gets only each claim, its `file:line`, `<head>` and
the bar for a finding, and none of the reviewer's reasoning. The fresh reader
returns "confirmed", "refuted" or "uncertain" for each claim, with evidence.
The reviewer reports only confirmed findings, or says it has none.

A reviewer does not edit code unless you tell it to fix a finding.

## Route each finding

Decide once per commit, in this order:

1. When the runner can reach a lander, and the session in the commit's
   `Attn-Session:` is live, send that session the sha, each finding, what a
   fix needs, and the instruction to fix it on a new branch from `origin/main`
   and land the fix with `land`.
2. When the runner can reach a lander, and an agent tends the seed in the
   commit's `Attn-Seed:`, send that agent the same message.
3. When the fix is small and clear, and the runner can land a fix, tell the
   reviewer to make the fix on a new branch from `origin/main` and land it with
   `land`, following `land guide`.
4. Otherwise, open one GitHub issue per finding. Name the commit, its author,
   the `file:line`, the trigger, and what a fix needs. An earlier pass that
   stopped before it moved `reviewed` may have opened the issue already, so
   list the issues first and skip a finding whose short sha and title are
   there:

   ```bash
   gh api 'repos/{owner}/{repo}/issues?state=all&per_page=100' --paginate --jq '.[] | select(.title | startswith("Review ")) | .title'
   gh api repos/{owner}/{repo}/issues -f title="Review <short sha>: <title>" -F body=@<file>
   ```

A reviewer with no confirmed findings is done.

<!-- feed: post each routed finding to the landing feed here, when the
repository has one. Filled by review-sheriff-post-findings-repairs-feed. -->

## Record the pass

Write one record of the pass where the runner keeps its notes, or in your final
report when it keeps none: the range, the units, who reviewed each unit, and
where each finding went. Give each finding a
line of its own, at the start of the line, in this form:

```text
finding: <sha> <seed id, or - when the commit names none> P0|P1 <title>
```

## Move reviewed

Move `reviewed` last, after every reviewer has reported and every finding has
been routed. A fix still in progress does not hold it up.

```bash
git push origin <head>:refs/heads/reviewed
```

When the push is refused, another pass pushed first. Stop.

## What makes a finding

Report a finding only when all of these hold:

- The unit introduced the problem, and the problem is still there at
  `<head>`.
- The unit's author would fix the problem if told. It is one discrete
  problem, not a pattern across the codebase or a matter of taste.
- For a bug, you can name the input, sequence or state that triggers it, and
  who hits it in real use. Cite the `file:line` that proves each claim. A
  claim inferred from a name is not proof.
- The problem is P0 or P1:
  - P0: breaks the feature for everyone who uses it, loses data, opens a
    security hole, or blocks a release.
  - P1: a real bug on a path users or programs take; a new layer, option,
    fallback, cache or copy of state that no current requirement needs,
    including code that nothing uses and nothing explains; or a change that
    moves away from its plan, or that a later change will have to undo.

A unit is often one slice of a larger plan. Judge it against where the plan
is going, from the commit messages and the plan they name. Code that nothing
uses yet is not a finding when a commit message names what will use it.

These are not P1, unless they lose data or open a security hole:

- A broken rule with no effect on behavior or design: a comment, a test that
  sleeps, a missing regression test, test style.
- Maintainer docs and tooling that only developers run.
- Inputs nobody produces, or counts far past real use.
- A race on a rare event that a person starts, which costs one stray action or
  a short delay.
- A finding in a commit that fixes an earlier finding, when the new trigger is
  less likely than the one the commit fixed.

Look in this order: design first, then behavior (edge cases, concurrency,
restarts, other platforms, what the user sees), then tests that pass while the
behavior they guard is broken. Leave out style, naming, anything CI checks,
and anything that predates the unit. When you are not sure, leave the finding
out.

Each finding names the commit sha, the `file:line`, P0 or P1, a one-line
title, the trigger, why it matters, and what a fix needs.

## Never

- Move `reviewed` backward, past a unit whose reviewer has not reported, or
  with force.
- Push `main` any way but `land`.
- Fix code yourself. A reviewer fixes, and only when you tell it to.
