# Sheriff

A landing can turn CI on `main` red. The sheriff finds each failed CI run on
`main`, finds the commit that caused it, and gets a repair landed: a small fix
forward, a clean revert, or a person's decision. Every failure gets a cause
and an owner, including one that the next push already turned green.

These steps hold in every repository that lands with `land`. Before you start,
read `.agents/land/sheriff.md` at the repository root when it exists. It holds
what this procedure needs to know about the repository, such as its CI
workflows and who to ask. Where the two disagree, `.agents/land/sheriff.md`
wins.

Never re-run CI, a failed job or a whole run. A re-run that passes shows only
that the failure is intermittent, not why.

## What your runner provides

Whatever starts the sheriff, such as a CI event, a schedule or a person, says
in its prompt how it does each of these:

- **Start a fixer.** A separate session, or a subagent of yours, that makes and
  lands a repair. You diagnose and dispatch. You do not edit code yourself.
- **Reach a lander.** Send a message to the session that landed a commit.
  Most runners cannot. Without it, the fallback in Give every revert an owner
  applies.
- **Land a fix.** Run `land` with push access and the gate's toolchain. Without
  it, record the repair you would make on the issue and ask a person.
- **Ask a person.** The runner's own way. Without one, comment on the
  `Branch health: main` issue and assign it to the culprit's author, as
  Give every revert an owner shows.

When the prompt says nothing about one of these, assume you do not have it.

## List the runs to handle

```bash
gh run list --branch main --event push --limit 20 \
  --json databaseId,workflowName,status,conclusion,createdAt \
  --jq '(group_by(.workflowName)[] | map(select(.status=="completed")) | max_by(.createdAt) | select(.conclusion=="failure") | .databaseId),
        (.[] | select(.conclusion=="failure" and (.createdAt|fromdateiso8601) > now-1800) | .databaseId)' | sort -u
```

The command prints the id of each failed push run to handle: the newest
completed run of each workflow when it failed, and every run that failed in the
last 30 minutes. When it prints nothing, read the record below. When the
record is open, go to Close the record. Otherwise stop.

When you run on a schedule, change `1800` to your interval in seconds plus a
margin, such as `4500` for an hourly run, because a scheduled run can start
late. An overlap is harmless: the record below keeps you from acting twice on
one failure.

## Read the record

The record is one GitHub issue, `Branch health: main`. Find it:

```bash
gh api 'repos/{owner}/{repo}/issues?state=all&per_page=100' --paginate \
  --jq '.[] | select(.title=="Branch health: main" and .pull_request==null) | "\(.number) \(.state)"'
gh api repos/{owner}/{repo}/issues/<number>/comments --paginate --jq '.[] | .body'
gh api repos/{owner}/{repo}/issues -f title="Branch health: main" -F body=@<file>
gh api repos/{owner}/{repo}/issues/<number> -X PATCH -f state=open
gh api repos/{owner}/{repo}/issues/<number>/comments -F body=@<file>
```

The commands find it, read its comments, create it, reopen it and comment on
it. They use `gh api` rather than `gh issue`, because some runners allow
GitHub's REST API and not its GraphQL API. When the issue does not exist,
create it at the first failure. When it is closed and a run failed, reopen it.
Read every comment before you act.

Keep one comment per failure: the workflow and job, the test and its error,
the failing commit, the runs that showed it, the owner, and the repair once it
lands. Match a failure by its job, test and error, not by its run. The same
failure in a newer run is the same failure.

- When a recorded failure has an owner and no landed repair, add the run to
  its comment and stop for that failure.
- When a landed repair covers the failure, check whether the run contains it:
  `git merge-base --is-ancestor <repair> <run's head sha>`. A run without the
  repair is expected to fail. Add the run to the comment and dispatch nothing.
- When a run that contains the repair fails in the same job and test, the
  repair did not work. Return the failure to its owner with that run. When a
  second landed repair fails this way, stop patching: write down the
  assumption both repairs share, check it against the code and the logs, and
  bring the owner a redesign.
- When a comment names a failure and no owner, an earlier sheriff stopped
  before it dispatched. Look among the runner's fixers for the run id before
  you dispatch again.

## Diagnose

Read the failed job's log. `gh run view` gives no log until the whole run
completes, so read the job's log from the API:

```bash
gh run view <run> --json headSha,jobs --jq '.headSha, (.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out") | "\(.databaseId) \(.name)")'
gh api repos/{owner}/{repo}/actions/jobs/<job>/logs
```

Find the culprit among the commits since the last green run of the same
workflow:

```bash
gh run list --workflow <workflow> --branch main --event push --status success --limit 1 --json headSha
git fetch origin && git log --format='%h %an %s%n%(trailers:key=Attn-Seed,key=Attn-Session,key=Claude-Session)' <green sha>..<red sha>
gh api repos/{owner}/{repo}/commits/<sha> --jq .author.login
```

The last command gives the GitHub login of a commit's author, which an issue
needs to assign it. It prints `null` when the commit's email belongs to no
GitHub account. Then name the author by name and email in the comment, and
leave the issue unassigned.

Match the failing test to the commits' changes. An intermittent failure's cause
can predate the green run: one passing run does not clear a commit. `main` may
have moved since the run. When a newer commit already fixes or reverts the
culprit, treat it as a landed repair.

Before you dispatch, comment the failure on the issue, with no owner yet.

## Choose the path

- **Fix forward** when the cause is clear and the fix is small, such as a stale
  fixture or a one-line regression.
- **Revert** when the break is large or unclear, or blocks everyone, and
  `git revert <culprit>` applies cleanly on `origin/main`.
- **Investigate** when the cause is unclear and no clean revert fits. Give a
  fixer the investigation, and the fix once the cause is known.
- **Ask a person**, after you comment what you found, when no path is clearly
  right, when the culprit adds a database migration and the fix is not small,
  when the culprit is a release commit, or when the runner, the network or
  another service failed rather than a commit.

Aim at the first wrong decision, not the place where the failure surfaced. A
test is the cause when its premise is wrong, not only when its timing is.

## Dispatch

Give the repair to a fixer. The brief names the failing run, the failing jobs
and tests with their log lines, the culprit and its trailers, the path you
chose and why. It tells the fixer to:

- start a new branch from `origin/main`
- reproduce the failure before the fix, on the platform where it failed, and
  show the test passing after the fix. When timing matters, control it. When
  the failure will not reproduce, stop and report that instead of guessing.
- for a revert, revert only the culprit, and name the run and the failure in
  the commit message
- land with `land`, following `land guide`, and stop when `land` pushes. Do not
  watch or re-run CI.

Add the owner to the failure's comment: the fixer, and where its report will
appear. When the repair lands, add its sha.

When `land.toml` has a `feed` key and the repair has landed, post the repair
to the feed on the repair's commit, naming the culprit it repairs and the run
that failed:

```bash
land event <repair sha> --kind repair --state pass --title "<fix|revert>: <failure>" --repairs <culprit sha> --url <failed run>
```

When the failure traced to a real defect in `<culprit sha>` (not a flake or
runner outage), also record it as a bug so CI escapes show up in `land bugs`
and the feed's bug metrics:

```bash
land bug <culprit sha> --title "<failure>" --severity p1 --source ci --fixed-by <repair sha> --url <failed run>
```

Posting is best effort. When `land event` or `land bug` fails or the feed
refuses the notice, say so in the issue's comment and go on. The issue stays
the record, not the feed.

## Give every revert an owner

A revert takes work off `main`, so someone must land it again:

1. When the runner can reach a lander and the session in the culprit's
   `Attn-Session:` is live, tell that session the failure, the run, the
   revert's sha, and how to land again: `git revert <revert sha>`, fix the
   problem, then land with `land`.
2. Otherwise, open an issue to land the work again, with the same facts,
   assigned to the culprit's author:

   ```bash
   gh api repos/{owner}/{repo}/issues -f title="Land <culprit subject> again" -f 'assignees[]=<login>' -F body=@<file>
   ```

To assign an existing issue, such as the record, to the author:
`gh api repos/{owner}/{repo}/issues/<number> -X PATCH -f 'assignees[]=<login>'`.
Name the owner in the failure's comment.

## Close the record

When the newest completed push run of every workflow passed and its head is
`origin/main`, and every failure in the issue has a landed repair, close the
issue with a comment that names the green run:
`gh api repos/{owner}/{repo}/issues/<number> -X PATCH -f state=closed`.

## Never

- Re-run CI, a failed job or a run.
- Skip, disable or quarantine a test.
- Fix, revert or commit yourself. A fixer does.
- Push `main` any way but `land`, or force-push anything.
- Revert a database migration.
