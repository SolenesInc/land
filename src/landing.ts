import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { constants } from "node:os"
import { Effect } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { git, gitOk, gitWith, run, succeeds } from "./git.ts"
import { deleteNote, findNote, type Note } from "./note.ts"
import { excludeLandDir } from "./land-dir.ts"
import type { LandingRecord } from "./schema.ts"
import { version } from "../package.json"

const maxAttempts = 5

const say = (line: string) => Effect.sync(() => console.log(`land: ${line}`))
const warn = (line: string) => Effect.sync(() => console.error(`land: ${line}`))

const short = (rev: string) => gitOk("rev-parse", "--short", rev)

// What land knows of the remote branch. The ref is per worktree, so two lands of one
// clone never write the same ref and need no queue between them.
const landRef = (main: string) => `refs/worktree/land/${main}`

const rebasing = Effect.gen(function* () {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    if (existsSync(yield* gitOk("rev-parse", "--git-path", state))) return true
  }
  return false
})

// Keep origin/main current for the lander. Only move it forward, and leave it when
// another land of the clone is writing it.
const advanceTracking = (main: string, commit: string) =>
  Effect.gen(function* () {
    const tracking = `refs/remotes/origin/${main}`
    const known = yield* git("rev-parse", "--verify", "--quiet", tracking)
    if (known.status !== 0) {
      yield* git("update-ref", tracking, commit, "")
    } else if (known.out !== commit && (yield* succeeds("merge-base", "--is-ancestor", known.out, commit))) {
      yield* git("update-ref", tracking, commit, known.out)
    }
  })

const fetchMain = (main: string) =>
  Effect.gen(function* () {
    yield* gitOk("fetch", "--quiet", "--refmap=", "origin", `+refs/heads/${main}:${landRef(main)}`)
    const fetched = yield* gitOk("rev-parse", landRef(main))
    yield* advanceTracking(main, fetched)
    return fetched
  })

const refuseCommitsByAnotherAuthor = (main: string) =>
  Effect.gen(function* () {
    const author = (yield* git("config", "--global", "--includes", "--get", "user.email")).out
    if (author === "") return
    const log = yield* gitOk("log", "--format=%h %ae %s", `${landRef(main)}..HEAD`)
    const others = log
      .split("\n")
      .filter((line) => line !== "" && line.split(" ")[1] !== author)
      .map((line) => `  ${line}`)
    if (others.length === 0) return
    return yield* new LandFailed({
      message: `these commits are not authored by your global git identity, ${author}:
${others.join("\n")}
See which config set the identity with git config --show-origin user.email. If it is not yours, remove it. Then fix these commits with git rebase origin/${main} --exec 'git commit --amend --no-edit --reset-author' and run land again.`,
    })
  })

const rebaseOntoMain = (main: string) =>
  Effect.gen(function* () {
    yield* git("rebase", "--quiet", landRef(main))
    if (yield* rebasing) {
      const conflicted = yield* gitOk("diff", "--name-only", "--diff-filter=U")
      yield* gitOk("rebase", "--abort")
      if (conflicted === "") {
        return yield* new LandFailed({
          message: `rebasing onto origin/${main} stopped; run git rebase origin/${main} to see why`,
        })
      }
      return yield* new LandFailed({
        message: `rebasing onto origin/${main} conflicts in:
${conflicted
  .split("\n")
  .map((file) => `  ${file}`)
  .join("\n")}
Rebase with git rebase origin/${main}, then run land again.`,
      })
    }
    if (!(yield* succeeds("merge-base", "--is-ancestor", landRef(main), "HEAD"))) {
      return yield* new LandFailed({
        message: `could not rebase onto origin/${main}; run git rebase origin/${main} to see why`,
      })
    }
  })

const hookMark = "# Installed by land."

const prePush = (main: string) => `#!/bin/sh
${hookMark} It refuses a plain push to ${main}.
[ "$LAND_LANDING" = 1 ] && exit 0
while read -r _ _ remote_ref _; do
  if [ "$remote_ref" = refs/heads/${main} ]; then
    echo "Land on ${main} with land. To push past it, use git push --no-verify." >&2
    exit 1
  fi
done
exit 0
`

// A port of attn's .githooks/prepare-commit-msg. It exits 0 on every path, so it
// never fails a commit.
const trailerHook = `#!/bin/sh
${hookMark} It adds Attn-Session and Attn-Seed to a commit made in an attn session.
message=$1
[ "$ATTN_INSIDE_APP" = 1 ] || exit 0
command -v attn >/dev/null 2>&1 || exit 0
for replaying in rebase-merge rebase-apply; do
  [ -e "$(git rev-parse --git-path "$replaying")" ] && exit 0
done
[ -n "$(git stripspace --strip-comments <"$message")" ] || exit 0
session=$(attn presence --session-id 2>/dev/null) && [ -n "$session" ] || exit 0
present=$(git interpret-trailers --parse "$message")
set --
printf '%s\\n' "$present" | grep -qi '^Attn-Session:' || set -- --trailer "Attn-Session: $session"
if ! printf '%s\\n' "$present" | grep -qi '^Attn-Seed:' && seeds=$(attn presence --seed-ids 2>/dev/null); then
  for seed in $seeds; do set -- "$@" --trailer "Attn-Seed: $seed"; done
fi
[ $# -gt 0 ] || exit 0
git interpret-trailers --in-place --if-exists addIfDifferent "$@" "$message"
exit 0
`

// Each hook land installs, and what a clone goes without when land cannot install it.
const hooks = (main: string) => [
  { name: "pre-push", text: prePush(main), without: `plain pushes to ${main} are not refused` },
  { name: "prepare-commit-msg", text: trailerHook, without: "land adds no attn trailers to commits" },
]

// Install land's hooks in the clone's shared hooks folder, so every worktree has them.
// Returns the names of the hooks this call installed.
export const installHooks = (main: string) =>
  Effect.gen(function* () {
    const installed: string[] = []
    const all = hooks(main)
    if ((yield* git("config", "--get", "core.hooksPath")).status === 0) {
      yield* warn(`core.hooksPath is set, so land installs no hooks: ${all.map((hook) => hook.without).join(", and ")}`)
      return installed
    }
    const commonDir = yield* gitOk("rev-parse", "--path-format=absolute", "--git-common-dir")
    yield* Effect.promise(() => mkdir(`${commonDir}/hooks`, { recursive: true }))
    for (const hook of all) {
      const path = `${commonDir}/hooks/${hook.name}`
      const existing = Bun.file(path)
      if (yield* Effect.promise(() => existing.exists())) {
        const text = yield* Effect.promise(() => existing.text())
        if (!text.includes(hookMark)) yield* warn(`${path} is not land's hook, so ${hook.without}`)
        continue
      }
      // Exclusive create: when two lands race, the second finds the first's hook.
      const created = yield* Effect.promise(() =>
        writeFile(path, hook.text, { flag: "wx", mode: 0o755 }).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error
            return false
          },
        ),
      )
      if (created) installed.push(hook.name)
    }
    return installed
  })

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const runGate = (gate: string, root: string, base: string, head: string) =>
  Effect.gen(function* () {
    const started = Date.now()
    const { status, signal } = yield* Effect.promise(async () => {
      const child = Bun.spawn(["sh", "-c", gate], {
        cwd: root,
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, LAND_BASE: base, LAND_HEAD: head },
      })
      await child.exited
      return { status: child.exitCode, signal: child.signalCode }
    })
    if (status === 0) {
      const ms = Date.now() - started
      yield* say(`gate   ${gate}   ok in ${duration(ms)}`)
      return ms / 1000
    }
    const exit = status ?? 128 + (typeof signal === "string" ? constants.signals[signal] : (signal ?? 0))
    return yield* new LandFailed({
      message: `gate   ${gate}   failed with status ${exit}; nothing was pushed`,
      status: exit,
    })
  })

// The commit refs/landings/<head> names: landing.json and, when the lander wrote one, note.md.
// It has no parent, so it shares no history with main and a clone never fetches it.
const landingCommit = (record: LandingRecord, note: Note | undefined) =>
  Effect.gen(function* () {
    const files = [{ name: "landing.json", text: `${JSON.stringify(record, null, 2)}\n` }]
    if (note !== undefined) files.push({ name: "note.md", text: note.text })
    const entries: string[] = []
    for (const file of files) {
      const blob = yield* gitWith(file.text, "hash-object", "-w", "--stdin")
      entries.push(`100644 blob ${blob}\t${file.name}\n`)
    }
    const tree = yield* gitWith(entries.join(""), "mktree")
    return yield* gitOk("commit-tree", tree, "-m", `Landing ${record.head}`)
  })

export const land = (options: { readonly note?: string }) =>
  Effect.gen(function* () {
    const root = yield* gitOk("rev-parse", "--show-toplevel")
    const declaration = yield* readDeclaration(root)
    const main = declaration.main ?? "main"
    yield* excludeLandDir
    const note = yield* findNote(root, options.note)

    if (yield* rebasing) {
      return yield* new LandFailed({
        message: "a rebase is in progress; finish it, or abort it with git rebase --abort",
      })
    }
    if (!(yield* succeeds("diff", "--quiet")) || !(yield* succeeds("diff", "--cached", "--quiet"))) {
      return yield* new LandFailed({ message: "commit or stash your changes first" })
    }
    // The gate runs in the worktree, so a file the landing does not contain could pass it.
    const untracked = yield* gitOk("ls-files", "--others", "--exclude-standard", "--full-name", ":/")
    if (untracked !== "") {
      return yield* new LandFailed({
        message: `the worktree has files the landing does not contain, so the gate could pass because of them:
${untracked
  .split("\n")
  .map((file) => `  ${file}`)
  .join("\n")}
Commit, remove or ignore them, then run land again.`,
      })
    }

    yield* fetchMain(main)
    yield* refuseCommitsByAnotherAuthor(main)
    yield* rebaseOntoMain(main)
    if ((yield* gitOk("rev-list", "--count", `${landRef(main)}..HEAD`)) === "0") return yield* say("nothing to land")
    yield* installHooks(main)

    if (note !== undefined) yield* say(`note   ${note.shown}`)
    const checked = yield* gitOk("rev-parse", "HEAD")
    let gate: LandingRecord["gate"]
    if (declaration.gate !== undefined) {
      const seconds = yield* runGate(declaration.gate, root, yield* gitOk("rev-parse", landRef(main)), checked)
      gate = { command: declaration.gate, seconds, ranOn: checked }
    }

    const url = yield* gitOk("remote", "get-url", "--push", "origin")
    let told = false
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      yield* fetchMain(main)
      yield* rebaseOntoMain(main)
      const head = yield* gitOk("rev-parse", "HEAD")
      if (!told && declaration.gate !== undefined && head !== checked) {
        told = true
        yield* warn(`${main} moved after the gate ran on ${yield* short(checked)}; pushing without running it again`)
      }
      const record: LandingRecord = {
        version: 1,
        land: version,
        base: yield* gitOk("rev-parse", landRef(main)),
        head,
        ...(gate === undefined ? {} : { gate }),
        recordings: [],
      }
      const landing = yield* landingCommit(record, note)
      // One atomic push, so a landing ref never names a head that is not on main.
      // Push to the URL, not to the remote's name, so git writes no tracking ref that
      // another land of the clone may be writing. advanceTracking moves it forward.
      const pushed = yield* run(
        ["git", "push", "--quiet", "--atomic", url, `${head}:refs/heads/${main}`, `${landing}:refs/landings/${head}`],
        { LAND_LANDING: "1" },
      )
      if (pushed.status === 0) {
        yield* advanceTracking(main, head)
        if (note !== undefined) yield* deleteNote(note)
        return yield* say(`push   ${main} is at ${yield* short(head)}`)
      }
      const fetched = yield* fetchMain(main)
      if (yield* succeeds("merge-base", "--is-ancestor", fetched, "HEAD")) {
        return yield* new LandFailed({ message: `git push failed, and not because ${main} moved:\n${pushed.err}` })
      }
    }
    return yield* new LandFailed({ message: `${main} moved ${maxAttempts} times while landing; run land again` })
  })
