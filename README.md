# land

`land` lands finished commits straight on a repository's `main`, with no pull
request. It rebases your branch onto `origin/main`, runs the repository's fast
gate, and pushes `main` together with a landing ref:

```text
$ land
land: note   .land/note.md
land: gate   bun run check   ok in 1m 49s
land: push   main is at 41d07be
land: feed   https://land-feed.caketroll.cloud/SolenesInc/land/41d07be
```

Each landing pushes `main` and `refs/landings/<head>` in one atomic push. The
landing ref points to a parentless commit holding `landing.json` (what `land`
knew at push time: its version, base, head, gate command, duration, checked
commit, and recordings) and `note.md` when you wrote one. Write the note in
`.land/note.md` or pass `land --note <file>`. `land` adds `.land/` to the
clone's `.git/info/exclude` and deletes the note file after the push. Normal
clones do not fetch landing refs; inspect one with
`git fetch origin refs/landings/<head>` or GitHub's
`GET /repos/{owner}/{repo}/git/ref/landings/<head>`.

### Safety checks built into `land`

- **Clean worktree:** refuses to start while tracked files have uncommitted
  changes or non-ignored untracked files exist, so the gate sees only what
  lands.
- **Global author identity:** refuses commits whose author email differs from
  your global git identity, and prints how to fix them.
- **Rebase and conflict handling:** rebases onto `origin/main` before the gate
  and again before pushing. If `land.toml` names a `resolve` command (for
  example to regenerate generated files), `land` runs it on conflicts and
  continues the rebase when it exits `0` with no unmerged files left. On any
  other conflict, `land` aborts the rebase, names the files, and leaves your
  branch untouched.
- **Concurrent landings without locks:** fetches into a per-worktree ref
  (`refs/worktree/land/<main>`) and pushes to the remote URL, so multiple
  worktrees of one clone can land side by side. When `main` moves while the
  gate runs, `land` rebases and pushes without rerunning the gate, naming the
  commit the gate ran on.
- **Unchanged-diff failure guard:** when the gate exits non-zero, `land`
  records the failure against the diff's patch-id (surviving rebases onto a
  moved `main`) and refuses to re-run the gate on the same unchanged diff until
  you change the diff or pass `--ack-flake <test> --owner <ref>`, which is
  recorded in `landing.json`.
- **Undone-commit warning:** after pushing, compares the landing against the
  last 30 commits on `main` touching the same files and warns if the landing
  completely undid an earlier commit.

`land guide` prints the full landing procedure for agents and humans: branch,
commit, check, review, note, land, report, and responding to post-landing
feedback. `land guide review` and `land guide sheriff` print the procedures
that keep `main` healthy after landing; see
[Keep main healthy](#keep-main-healthy).

## Install

Install on macOS arm64 or Linux x64. The binary is standalone and needs no
Bun.

With `mise`:

```bash
mise use -g github:SolenesInc/land
```

Or download directly:

```bash
mkdir -p ~/.local/bin && curl -fsSL "https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m)" -o ~/.local/bin/land && chmod +x ~/.local/bin/land
```

Put `~/.local/bin` on your `PATH`, then verify with `land --version`.

## Adopt land in a repository

Run `land init` at the root of a clone:

```text
$ land init
land: land.toml  wrote gate = "bun run check", from the check script in package.json
land: land.toml  wrote feed = "https://land-feed.caketroll.cloud", where landings show
land: AGENTS.md  added the trunk declaration under ## Landing
land: hooks      installed pre-push and prepare-commit-msg

Decide:
  - Whether bun run check should run before every push. It holds every landing until it passes, so name a faster check in land.toml if it is slow, and leave the rest to CI.

Install the App on the repository, so the feed shows its landings: https://github.com/apps/attn-land/installations/new

Then commit land.toml and AGENTS.md, and land the commit with land.
```

`land init` never overwrites an existing file. It sets up two things:

1. **`land.toml`** at the repository root. `land init` proposes the first
   check it finds: a `check` script in `package.json`, a `check` target in
   `Makefile`, a `test` script, a `test` target, `go test ./...` for `go.mod`,
   or `cargo test` for `Cargo.toml` (choosing `bun`, `pnpm`, `yarn`, or `npm`
   from the lockfile and skipping `npm init`'s placeholder). When `origin/HEAD`
   is not `main`, it writes `main = "<branch>"`.

   All keys supported in `land.toml` (unknown keys fail so a typo never skips
   a stage):

   ```toml
   gate = "scripts/land-gate.sh"             # shell command; receives LAND_BASE and LAND_HEAD
   main = "main"                             # target branch (defaults to "main")
   resolve = "scripts/land-resolve.sh"       # optional rebase-conflict resolver; receives LAND_BASE
   record = "scripts/land-record.sh"         # optional capture command for `land record`; receives LAND_MEDIA
   feed = "https://land-feed.caketroll.cloud" # optional feed URL for landings, media, and review events
   visual_paths = ["src/ui/**"]              # optional path globs requiring media (or --no-media "<reason>")
   evidence_check = "scripts/land-evidence.sh" # optional pre-gate check receiving LAND_BASE/HEAD/MEDIA/NOTE/RECORDINGS/NO_MEDIA
   require_note = true                       # optional: refuse to land without a note (or --media)
   ```

   Leave `gate` out only when the repository has no pre-push checks.

2. **The trunk declaration**, two lines appended under `## Landing` to
   `AGENTS.md` (or `CLAUDE.md` when only that exists; creates `AGENTS.md` when
   neither exists):

   ```markdown
   This repository lands on `main` with `land`, with no pull request.
   Before you land a change, run `land guide` and follow it.
   ```

A second `land init` changes nothing.

### Hooks

The first `land` or `land init` in a clone installs two hooks in the clone's
shared `.git/hooks`, so every linked worktree inherits them:

- `pre-push` refuses a plain `git push` to `main` unless `LAND_LANDING=1` or
  `--no-verify`.
- `prepare-commit-msg` adds `Attn-Session:` and `Attn-Seed:` trailers to
  commits made inside an attn session, via `attn presence`. Outside attn it
  does nothing and never fails a commit.

If the clone sets `core.hooksPath` (for example `.githooks`), `land` installs
nothing and checks whether that directory already supplies a `pre-push` hook
recognizing `LAND_LANDING` and a `prepare-commit-msg` hook adding
`Attn-Session:`. It warns only about whichever hook is missing.

## Record the change

`land record [args]` captures what a change looks like and prints the markdown
lines that link each new recording:

```text
$ land record login
![login](.land/media/login.png)
```

Declare the capture script as `record` in `land.toml`. `land` runs it with
`sh -c` at the repository root, passing `LAND_MEDIA` set to the absolute path
of `.land/media/` and forwarding your arguments. Its own stdout goes to stderr
so stdout holds only `![<name>](.land/media/<file>)` lines, in name order.
`land` adds `.land/` to `.git/info/exclude`, so recordings never block a
landing.

## Show landings in the feed

The feed (`https://land-feed.caketroll.cloud`) shows each landing with its
note, recordings, CI runs, human review comments, guided review briefs, and
attributed bugs. A repository joins by installing the
[Attn Land App](https://github.com/apps/attn-land/installations/new) (or
granting it organization-wide access) and setting `feed` in `land.toml`:

```toml
feed = "https://land-feed.caketroll.cloud"
```

When `.land/note.md` links a local media file (`png`, `jpg`, `jpeg`, `gif`,
`webp`, `mp4`, `webm`), or you pass `land --media <file>` (repeatable), `land`
rewrites the link to `<feed>/m/<owner>/<repo>/<sha256>.<ext>`, records its
hash and size in `landing.json`, uploads it after the push with no credential
(the feed verifies the ref on GitHub), deletes uploaded files inside `.land/`
(leaving files outside `.land/` untouched), and prints the landing URL:

```text
$ land --media /tmp/after.png
land: note   .land/note.md, 1 recording
land: gate   bun run check   ok in 1m 49s
land: push   main is at 41d07be
land: media  1 recording uploaded
land: feed   https://land-feed.caketroll.cloud/SolenesInc/land/41d07be
```

When `feed` is configured, `land` guards against accidentally dropping
verification media before the gate runs:

- **Orphaned `.land/media/` files:** refuses if `.land/media/` holds recordings
  that are not linked in `.land/note.md` or passed via `--media`.
- **Fresh `Attn-Seed:` media:** when commits carry `Attn-Seed:` trailers and
  `attn` is on `PATH`, refuses if a seed has media artifacts newer than its
  previous landing on `main` and 0 recordings are attached.
- **Visual paths (`visual_paths` in `land.toml`):** refuses when the diff
  touches a matching path with 0 recordings attached (supports `!pattern`
  negation, e.g. `["src/ui/**", "!**/*.test.tsx"]`).

Pass `land --no-media "<reason>"` when a change legitimately needs no visual
evidence; the reason is recorded as `noMediaReason` in `landing.json`.

A repository can also declare `evidence_check = "<command>"` in `land.toml`
(runs before the gate regardless of `feed`, receiving `LAND_BASE`, `LAND_HEAD`,
`LAND_MEDIA`, `LAND_NOTE`, `LAND_RECORDINGS`, and `LAND_NO_MEDIA`) or
`require_note = true`.

To attach images, GIFs, or videos _after_ a commit has already landed (for
example from a post-landing check report or a cross-platform verifier), run:

```bash
land evidence <sha> <file>... [-m "<summary>" | --detail-file <file>] [--title "<title>"]
```

`land evidence` pushes a `kind: "evidence"` event to `refs/land-events/<sha>/<id>`
and uploads each recording through the same outbox-backed flow. `land event`
also accepts repeatable `--media <file>` and rewrites local media links in
`--detail-file`.

A missing file, a recording over 200 MB, or a local recording without a `feed`
key fails before the gate with nothing pushed. Feed failures never fail a
landing: unsent uploads and event notices wait in
`$XDG_STATE_HOME/land/outbox` (or `~/.local/state/land/outbox`), and the next
`land` in any repository drains the outbox first.

## Post-landing review, briefs, events, and bugs

`land` pairs with `land-feed` for post-landing human and agent review without
pull requests:

- **Authenticate for private repositories:**
  `land auth token <token | ->` stores a feed API token in
  `~/.config/land/token` (mode `0600`), or set `LAND_FEED_TOKEN`. Check with
  `land auth status`, clear with `land auth logout`.
- **Read a landing and its open comments:**
  `land show <sha|url>` prints a markdown bundle containing the landing note,
  open review comments with surrounding diff hunks, and registered bugs.
  `land comments [<sha|url>] [--open] [--json]` lists comments;
  `land comments resolve <id> [--by <sha>]` marks one resolved after your fix
  lands.
- **Publish guided review briefs:**
  `land review check <file> [--base <sha>] [--head <sha>]` validates a review
  document (`brief`, `walkthrough`, or `map` frames, stops, line ranges,
  sequence diagrams, and file coverage) against git.
  `land brief <sha> <file> [--base <sha>] [--no-check]` validates and pushes
  the review document to `refs/land-events/`.
- **Post lifecycle events:**
  `land event <sha> --kind <kind> --state pass|fail|run|info --title <title> [--url <url>] [--detail-file <file>] [--media <file>]... [--repairs <sha>]`
  commits `event.json` with no parent, pushes `refs/land-events/<sha>/<id>`,
  notifies the feed, and uploads any linked or `--media` recordings.
- **Attribute, close, and query bugs:**
  `land bug <culprit-sha> --title "<summary>" [--severity p0|p1|p2] [--source agent|review|ci|prod|human] [--location path[:line]] [--detail-file <file>] [--fixed-by <sha>] [--url <url>]`
  records a regression against the commit that introduced it and prints its
  short id (`land: id <id>`). Add `Fixes-Bug: <id>` to a fix commit's trailer
  block (or pass `land --fixes <id>`) to close specific bugs automatically when
  landing, or run `land bug resolve <id> --by <fix-sha>` for an already-landed
  fix.
  `land bugs [--open] [--since 30d] [--path <prefix>] [--severity p0|p1|p2] [--json]`
  queries registered bugs for retrospective analysis or before touching a
  sensitive area.

## Keep main healthy

A landing passes the fast gate, while full CI runs on `main` after the push.
Two runner-agnostic procedures keep `main` healthy:

- `land guide review` reviews every commit in `origin/reviewed..origin/main`,
  routes each confirmed P0 or P1 finding to someone who will fix it, posts
  findings and bugs to the feed, and moves `reviewed` forward.
- `land guide sheriff` finds each failed CI run on `main`, identifies the
  culprit, dispatches a fix or clean revert, posts repairs and CI bugs to the
  feed, and tracks state in one issue, `Branch health: main`.

Put repository-specific rules in `.agents/land/review.md` and
`.agents/land/sheriff.md`. Start review on a repository by pushing the
`reviewed` branch at the first commit to review:
`git push origin <commit>:refs/heads/reviewed`.

A runner starts an agent with a prompt that installs `land`, runs the guide,
and declares what capabilities the runner has (starting reviewers or fixers,
reaching the session that landed a commit, landing fixes, asking a person).
The procedures fall back to GitHub issues for any capability the runner lacks.

### The prompts

Sheriff prompt:

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

Review prompt:

```text
You review the commits that landed on this repository's main branch. If land
is not on your PATH, install it:
mkdir -p ~/.local/bin && curl -fsSL "https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m)" -o ~/.local/bin/land && chmod +x ~/.local/bin/land
When land is still not on your PATH, call it as ~/.local/bin/land.
Then run `land guide review` at the repository root and follow it.

You start reviewers as subagents. You cannot reach the session that landed a
commit. You can land a fix with land. Ask a person by opening a GitHub issue.
```

Adjust the last paragraph when your runner differs (for instance, write
"You cannot land a fix." when the runner lacks the gate's toolchain, or explain
how to start separate sessions).

### Claude Code scheduled task

A scheduled task in the cloud (`claude.ai/code`, Routines) or in the desktop
app runs the prompt on a schedule:

- **Trigger:** schedule. Cloud scheduled tasks run at most hourly and do not
  trigger on finished CI runs, so run the sheriff hourly and pass `4500` as
  the lookback window in the procedure's first command. Run review hourly or
  daily.
- **Repository:** attach the repository. The procedures use `gh api` (REST),
  because Anthropic's proxy refuses GraphQL queries from `gh issue`.
- **Network:** the default environment (Limited with package managers allowed)
  reaches GitHub release downloads.
- **Landing:** install the gate's toolchain in the setup script if the runner
  will land fixes; otherwise write "You cannot land a fix."

A desktop scheduled task runs on your own machine with your `gh` and
toolchain; point it at a clone that holds no active work.

### Claude Managed Agents

Start a session on a schedule or from a `workflow_run` webhook:

```bash
curl https://api.anthropic.com/v1/sessions \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2026-10-21" \
  -H "anthropic-beta: managed-agents-2026-04-01" -H "content-type: application/json" \
  -d '{"agent": "<agent id>", "environment_id": "<environment id>",
       "resources": [{"type": "github_repository", "url": "https://github.com/<owner>/<repo>",
                      "mount_path": "/workspace/repo", "authorization_token": "<token>"}],
       "initial_events": [{"type": "user.message", "content": [{"type": "text", "text": "<prompt>"}]}]}'
```

Enable the built-in toolset (`bash`), allow GitHub network access, give the
token push and issue permissions, and add
`"The repository is at /workspace/repo."` to the prompt.

### GitHub Actions

Run the prompt with `anthropics/claude-code-action`. Trigger the sheriff when
CI on `main` completes (including green runs so it closes its record), and
trigger review on a schedule:

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

The default `GITHUB_TOKEN` pushes as `github-actions`, which does not trigger
CI on the repair commit; pass a personal or App token when the workflow lands
fixes.

### attn automation

An attn automation runs the prompt on a schedule with a guard that starts an
agent only when work exists. For the sheriff's guard, combine the procedure's
first command with checking for an open `Branch health: main` issue so it also
runs to close the record. For review's guard, use
`git fetch -q origin && git log --oneline -1 origin/reviewed..origin/main`.
attn can message the commit's `Attn-Session:` directly and delegate separate
sessions for reviewers and fixers; state how in the prompt.

## Develop

```bash
bun install
bun run check
```

`bun run check` typechecks, checks formatting, and runs the test suite, which
builds `dist/land` and drives it against real git repositories. This
repository lands with its own `land`. CI runs the same check on `main` on
Ubuntu and macOS.

To release, bump `version` in `package.json` and land the change. CI publishes
the macOS and Linux binaries under the GitHub release `v<version>`. Landers
receive updated guide text with the next release.
