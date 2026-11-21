# land

`land` lands finished commits on a repository's `main`, with no pull request.
It rebases your branch onto `origin/main`, runs the repository's gate, and
pushes:

```text
$ land
land: note   .land/note.md
land: gate   bun run check   ok in 1m 49s
land: push   main is at 41d07be
```

Each landing pushes `main` and a landing ref, `refs/landings/<head>`, in one
atomic push. The ref names a commit, with no parent, that holds
`landing.json`, what `land` knew at the push (its version, the base, the head,
the gate's command, how long it took and the commit it ran on), and the
note, when the lander wrote one. The note is markdown for the readers of
`main`, written in `.land/note.md` or in the file `land --note <file>` names.
`land` adds `.land/` to the clone's `.git/info/exclude`, and deletes the note
file after the push. A normal clone does not fetch landing refs; read one with
`git fetch origin refs/landings/<head>` or GitHub's
`GET /repos/{owner}/{repo}/git/ref/landings/<head>`.

`land` refuses to start while the worktree has uncommitted changes or untracked
files that git does not ignore, because the gate runs in the worktree and must
see only what lands. When the rebase conflicts, `land` aborts it, names the files, and leaves your
branch as it was. When the gate fails, `land` pushes nothing and exits with the
gate's status. When `main` moves while the gate runs, `land` rebases and pushes
without running the gate again, and names the commit the gate ran on. Lands
from several worktrees of one clone can run at once.

`land guide` prints the procedure around a landing: branch, commit, check,
review, note, land and report. `land guide review` and `land guide sheriff` print the
procedures that keep `main` healthy after a landing; see
[Keep main healthy](#keep-main-healthy).

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

## Record the change

`land record [args]` captures what a change looks like, and prints the
markdown that links it:

```text
$ land record login
![login](.land/media/login.png)
```

The repository supplies the capture, as the `record` key in `land.toml`: a
shell command that writes its recordings into `$LAND_MEDIA`. `land` runs it
with `sh -c` at the repository root, with `LAND_MEDIA` set to the absolute path
of `.land/media/` and the arguments you passed appended. It then prints
`![<name>](.land/media/<file>)` for each file the command created or wrote
again, in name order. The command's own output goes to stderr, so stdout holds
only those lines. When the command fails, `land` exits with its status and
prints no line. With no `record` key it fails and names the key.

```toml
record = "scripts/record.sh"
```

`land` adds `.land/` to the clone's `.git/info/exclude`, so the recordings
never block a landing and no repository commits an ignore rule.

## Show landings in the feed

The feed, `https://land-feed.caketroll.cloud`, shows each landing with its
note and recordings. A repository joins it by installing the
[Attn Land App](https://github.com/apps/attn-land/installations/new) and
naming the feed in `land.toml`, which `land init` writes:

```toml
feed = "https://land-feed.caketroll.cloud"
```

A note may then link a recording that `land record` made. Before the gate,
`land` rewrites each local link to the recording's feed address,
`<feed>/m/<owner>/<repo>/<sha256>.<ext>`, and lists the file in
`landing.json` by its SHA-256, extension and size. After the push it uploads
each file, deletes the ones that went with the note, and prints the landing's
address:

```text
$ land
land: note   .land/note.md, 1 recording
land: gate   bun run check   ok in 1m 49s
land: push   main is at 41d07be
land: media  1 recording uploaded
land: feed   https://land-feed.caketroll.cloud/SolenesInc/land/41d07be
```

`land` sends the feed no credential: the feed uploads only what the landing
ref on GitHub lists. A link to a missing file, a recording over 200 MB, and a
local recording with no `feed` key each stop `land` before the gate.

`land` never fails because of the feed. What it cannot send waits in the
outbox, `$XDG_STATE_HOME/land/outbox` or `~/.local/state/land/outbox`, and
every later `land`, in any repository, sends it first and prints how many
still wait.

`land event` tells the feed something that happened after a landing, such as
a review finding or a repair:

```text
$ land event 41d07be --kind finding --state fail --title "banner flickers" --detail-file finding.md
land: event  refs/land-events/41d07be…/9c2e1f0… pushed; the feed has it
```

It commits `event.json`, with no parent, pushes the commit to
`refs/land-events/<landing sha>/<event commit sha>`, then notifies the feed,
which reads the ref before it stores the event. `--state` is `pass`, `fail`,
`run` or `info`; `--url`, `--detail-file` (markdown) and `--repairs <sha>`
are optional. A notice the feed does not take waits in the outbox.

## Keep main healthy

A landing passes the gate, but CI on `main` runs the whole check and can still
go red, and nobody reviewed the change before it landed. Two procedures, which
any agent can follow, cover what happens after the push:

- `land guide review` reviews every commit in `origin/reviewed..origin/main`,
  sends each confirmed finding to someone who will fix it, and moves the
  branch `reviewed` forward.
- `land guide sheriff` finds each failed CI run on `main`, its culprit and a
  repair, and keeps the record in one issue, `Branch health: main`.

A repository adds what the procedures need to know about it in
`.agents/land/review.md` and `.agents/land/sheriff.md`. Review starts once the
branch `reviewed` exists: push it at the first commit to review, with
`git push origin <commit>:refs/heads/reviewed`.

A runner starts an agent with a prompt that installs `land` and follows one
procedure. The prompt also says what the runner can do: start a reviewer or a
fixer, reach the session that landed a commit, land a fix, and ask a person.
The procedures fall back to GitHub issues for whatever the runner cannot do.

### The prompts

Paste the sheriff prompt:

```text
You are the sheriff of this repository's main branch. If land is not on your
PATH, install it:
mkdir -p ~/.local/bin && curl -fsSL "https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m)" -o ~/.local/bin/land && chmod +x ~/.local/bin/land
When land is still not on your PATH, call it as ~/.local/bin/land.
Then run `land guide sheriff` at the repository root and follow it.

You start fixers as subagents. You cannot reach the session that landed a
commit. You can land a fix with land. Ask a person by commenting on the
Branch health: main issue.
```

Paste the review prompt:

```text
You review the commits that landed on this repository's main branch. If land
is not on your PATH, install it:
mkdir -p ~/.local/bin && curl -fsSL "https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m)" -o ~/.local/bin/land && chmod +x ~/.local/bin/land
When land is still not on your PATH, call it as ~/.local/bin/land.
Then run `land guide review` at the repository root and follow it.

You start reviewers as subagents. You cannot reach the session that landed a
commit. You can land a fix with land. Ask a person by opening a GitHub issue.
```

Change the last paragraph of each prompt when your runner differs. When it cannot run the
gate, write "You cannot land a fix." When it can start separate sessions, say
how.

### Claude Code scheduled task

A scheduled task in the cloud (claude.ai/code, Routines) or in the desktop app
runs the prompt on a schedule:

- **Trigger.** A schedule. Scheduled tasks run at most once an hour, and
  their GitHub triggers cover pull requests, releases and issues only, with no
  trigger for a finished CI run. Run the sheriff hourly, and in its prompt
  tell it to use `4500` for the window in the procedure's first command. Run
  review hourly or daily.
- **Repository.** Attach the repository. The run clones it, and its `gh`
  reaches GitHub's REST API through Anthropic's proxy. The procedures use
  `gh api`, because the proxy refuses the GraphQL API that `gh issue` uses.
- **Network.** The default environment, Limited with package managers
  allowed, reaches GitHub's release downloads, so the install line works.
- **Landing.** `land` must run the gate, so the environment needs the gate's
  toolchain. Install it in the environment's setup script. Without it, write
  "You cannot land a fix." A run pushes to `main` only through `land`, and
  GitHub's branch rules decide whether it may.

A desktop scheduled task runs in a folder on your machine, with your own `gh`
and toolchain. Point it at a clone that holds no work.

### Claude Managed Agents

Your own code starts a session with the prompt as its first event, on a
schedule or from a webhook it receives, such as GitHub's `workflow_run`:

```bash
curl https://api.anthropic.com/v1/sessions \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2026-10-21" \
  -H "anthropic-beta: managed-agents-2026-04-01" -H "content-type: application/json" \
  -d '{"agent": "<agent id>", "environment_id": "<environment id>",
       "resources": [{"type": "github_repository", "url": "https://github.com/<owner>/<repo>",
                      "mount_path": "/workspace/repo", "authorization_token": "<token>"}],
       "initial_events": [{"type": "user.message", "content": [{"type": "text", "text": "<prompt>"}]}]}'
```

Give the agent the built-in toolset, which includes `bash`, and an environment
whose network reaches GitHub. The token needs to push the repository and
write its issues. Add "The repository is at /workspace/repo." to the prompt.

### GitHub Actions

`anthropics/claude-code-action` runs the prompt in a workflow. Start the
sheriff when CI on `main` completes, and review on a schedule. The sheriff
starts on a green run too, so it can close its record:

```yaml
name: sheriff
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
concurrency:
  group: sheriff
  cancel-in-progress: false
permissions:
  contents: write
  issues: write
  actions: read
  id-token: write
jobs:
  sheriff:
    if: github.event.workflow_run.event == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: --allowedTools "Bash,Read,Edit,Write,Glob,Grep,Task"
          prompt: |
            <the sheriff prompt>
```

Name your CI workflow in `workflows`. The `concurrency` group runs one
sheriff at a time, so two failures close together get one dispatch each. The job's `GITHUB_TOKEN` pushes as
`github-actions`, and a push by that token starts no new workflow run, so CI
does not check a repair this job lands. Give the job a token of your own when
it lands fixes.

### attn automation

An attn automation runs the prompt on a schedule, with a guard that starts the
agent only when there is work. For the sheriff's guard, use the procedure's
first command followed by
`gh api 'repos/{owner}/{repo}/issues?state=open' --jq '.[] | select(.title=="Branch health: main") | .number'`,
so the sheriff also starts while its record is open and can close it. Use
`git fetch -q origin && git log --oneline -1 origin/reviewed..origin/main` as
review's. attn can reach the session that landed a commit, through its
`Attn-Session:` trailer, and start reviewers and fixers as separate sessions.
Say so, and how, in the prompt. `attn guide automations` describes the rest.

## Develop

```bash
bun install
bun run check
```

`bun run check` typechecks, checks formatting, and runs the tests, which build
the binary and drive it against real git repositories. This repository lands
with its own `land`. CI runs the same check on `main` on Ubuntu and macOS.

To release, change `version` in `package.json` and land the change. CI then
publishes the binaries as the GitHub release `v<version>`. A lander gets a
change to the guides only with the next release.
