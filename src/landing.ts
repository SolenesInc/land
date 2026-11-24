import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { constants, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { git, gitOk, gitWith, run, succeeds } from "./git.ts"
import { deleteNote, findNote } from "./note.ts"
import { excludeLandDir } from "./land-dir.ts"
import { githubRepository, landingAddress } from "./feed.ts"
import { listed, plural, readNoteMedia, uploadRecordings } from "./media.ts"
import { drain } from "./outbox.ts"
import type { LandingRecord } from "./schema.ts"
import { version } from "../package.json"

const maxAttempts = 5
const maxResolveSteps = 100
// Over 400 landings on attn, checking the last 30 main commits took ~0.1s per landing.
const undoWindow = 30

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

const runResolve = (resolve: string, root: string, base: string) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["sh", "-c", resolve], {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, LAND_BASE: base },
    })
    await child.exited
    return child.exitCode
  })

const rebaseOntoMain = (main: string, root: string, resolve?: string) =>
  Effect.gen(function* () {
    yield* git("rebase", "--quiet", landRef(main))
    const base = yield* gitOk("rev-parse", landRef(main))
    let steps = 0
    while (yield* rebasing) {
      const conflicted = yield* gitOk("diff", "--name-only", "--diff-filter=U")
      if (resolve !== undefined && conflicted !== "" && steps < maxResolveSteps) {
        steps += 1
        const status = yield* runResolve(resolve, root, base)
        if (status === 0 && (yield* gitOk("diff", "--name-only", "--diff-filter=U")) === "") {
          yield* say(`resolve ${resolve}   ok`)
          yield* run(["git", "rebase", "--continue"], { GIT_EDITOR: "true" })
          continue
        }
      }
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

// Each hook land installs, how land recognizes a repo-owned equivalent, and what a clone goes
// without when land cannot install it.
const hooks = (main: string) => [
  {
    name: "pre-push",
    text: prePush(main),
    handled: (text: string) => text.includes(hookMark) || text.includes("LAND_LANDING"),
    without: `plain pushes to ${main} are not refused`,
  },
  {
    name: "prepare-commit-msg",
    text: trailerHook,
    handled: (text: string) => text.includes(hookMark) || text.includes("Attn-Session:"),
    without: "land adds no attn trailers to commits",
  },
]

const hookHandledAt = (path: string, handled: (text: string) => boolean) =>
  Effect.promise(async () => {
    const file = Bun.file(path)
    if (!(await file.exists())) return false
    return handled(await file.text())
  })

// Install land's hooks in the clone's shared hooks folder, so every worktree has them.
// Returns the names of the hooks this call installed.
export const installHooks = (main: string, root: string) =>
  Effect.gen(function* () {
    const installed: string[] = []
    const all = hooks(main)
    const configured = yield* git("config", "--path", "--get", "core.hooksPath")
    if (configured.status === 0) {
      const hooksDir = isAbsolute(configured.out) ? configured.out : join(root, configured.out)
      const missing: string[] = []
      for (const hook of all) {
        if (!(yield* hookHandledAt(join(hooksDir, hook.name), hook.handled))) missing.push(hook.without)
      }
      if (missing.length > 0) {
        yield* warn(`core.hooksPath is set, so land installs no hooks: ${missing.join(", and ")}`)
      }
      return installed
    }
    const commonDir = yield* gitOk("rev-parse", "--path-format=absolute", "--git-common-dir")
    yield* Effect.promise(() => mkdir(`${commonDir}/hooks`, { recursive: true }))
    for (const hook of all) {
      const path = `${commonDir}/hooks/${hook.name}`
      const existing = Bun.file(path)
      if (yield* Effect.promise(() => existing.exists())) {
        const text = yield* Effect.promise(() => existing.text())
        if (!hook.handled(text)) yield* warn(`${path} is not land's hook, so ${hook.without}`)
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

const rawGit = async (root: string, args: ReadonlyArray<string>, env?: Record<string, string>, input?: Uint8Array) => {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: input === undefined ? "ignore" : input,
    stdout: "pipe",
    stderr: "pipe",
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  const [buf, status] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
  return { status, out: new Uint8Array(buf) }
}

const patchAppliesOn = async (root: string, patch: Uint8Array, tree: string, index: string) => {
  const env = { GIT_INDEX_FILE: index }
  const read = await rawGit(root, ["read-tree", tree], env)
  if (read.status !== 0) return false
  const apply = await rawGit(root, ["apply", "--cached", "--check"], env, patch)
  return apply.status === 0
}

// Warn after a push when the landing completely undoes an earlier commit in the recent window.
const warnUndoneCommits = (root: string, main: string, base: string, head: string) =>
  Effect.gen(function* () {
    const changed = new Set((yield* gitOk("diff", "--name-only", base, head)).split("\n").filter(Boolean))
    if (changed.size === 0) return
    const log = yield* gitOk(
      "log",
      "--first-parent",
      "--no-merges",
      `-${undoWindow}`,
      "--name-only",
      "--format=%x1e%H%x00%h%x00%s",
      base,
    )
    const candidates: Array<{ sha: string; short: string; subject: string }> = []
    for (const chunk of log.split("\x1e")) {
      if (!chunk) continue
      const lines = chunk.split("\n")
      const header = lines[0]?.split("\x00")
      if (!header || header.length < 3) continue
      const files = lines.slice(1).filter(Boolean)
      if (files.some((f) => changed.has(f))) {
        candidates.push({ sha: header[0]!, short: header[1]!, subject: header[2]! })
      }
    }
    if (candidates.length === 0) return
    const undone = yield* Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "land-undo-"))
      const index = join(dir, "index")
      const matched: string[] = []
      try {
        for (const c of candidates) {
          const shown = await rawGit(root, ["show", "--format=", "--binary", c.sha])
          if (shown.status !== 0 || shown.out.byteLength === 0) continue
          if (
            (await patchAppliesOn(root, shown.out, head, index)) &&
            !(await patchAppliesOn(root, shown.out, base, index))
          ) {
            matched.push(`  ${c.short} ${c.subject}`)
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      return matched
    })
    if (undone.length === 0) return
    yield* warn(
      `WARNING: this landing undoes earlier commits on ${main}. Their whole change is gone from what landed:\n${undone.join("\n")}\nland: if that was not on purpose, restore each one in a new landing with git cherry-pick.`,
    )
  }).pipe(Effect.catch(() => Effect.void))

const failureRetentionMs = 7 * 24 * 60 * 60 * 1000
const signalExitCodes = new Set([129, 130, 131, 137, 143])

type GateFailureRecord = {
  readonly command: string
  readonly status: number
  readonly base: string
  readonly head: string
  readonly failedAt: string
}

const patchIdForDiff = (root: string, base: string, head: string) =>
  Effect.promise(async () => {
    const diff = await rawGit(root, [
      "diff-tree",
      "-r",
      "-p",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      head,
    ])
    if (diff.status !== 0) return head
    if (diff.out.byteLength === 0) return "empty-diff"
    const patched = await rawGit(root, ["patch-id", "--verbatim"], undefined, diff.out)
    if (patched.status !== 0) return head
    const patchId = new TextDecoder().decode(patched.out).trim().split(/\s+/)[0] ?? ""
    const structural: string[] = []
    let lastIndex = ""
    for (const line of new TextDecoder().decode(diff.out).split("\n")) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ")
      ) {
        structural.push(line)
        if (line.startsWith("diff --git ")) lastIndex = ""
      } else if (line.startsWith("index ")) {
        lastIndex = line
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        if (lastIndex !== "") structural.push(lastIndex)
        structural.push(line)
      }
    }
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(patchId)
    hasher.update("\0")
    hasher.update(structural.join("\n"))
    return hasher.digest("hex")
  })

const failurePath = (commonDir: string, patchId: string) => join(commonDir, "land-failures", `${patchId}.json`)

const readGateFailure = (commonDir: string, patchId: string) =>
  Effect.promise(async (): Promise<GateFailureRecord | undefined> => {
    const path = failurePath(commonDir, patchId)
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    try {
      const parsed = JSON.parse(await file.text()) as Partial<GateFailureRecord>
      if (
        typeof parsed.command === "string" &&
        typeof parsed.status === "number" &&
        typeof parsed.base === "string" &&
        typeof parsed.head === "string" &&
        typeof parsed.failedAt === "string"
      ) {
        return parsed as GateFailureRecord
      }
    } catch {
      return undefined
    }
    return undefined
  })

const recordGateFailure = (commonDir: string, patchId: string, record: GateFailureRecord) =>
  Effect.promise(async () => {
    await mkdir(join(commonDir, "land-failures"), { recursive: true })
    await writeFile(failurePath(commonDir, patchId), `${JSON.stringify(record, null, 2)}\n`)
  })

const clearGateFailure = (commonDir: string, patchId: string) =>
  Effect.promise(async () => {
    await rm(failurePath(commonDir, patchId), { force: true })
    const dir = join(commonDir, "land-failures")
    const entries = await readdir(dir).catch(() => [])
    const cutoff = Date.now() - failureRetentionMs
    for (const entry of entries) {
      const full = join(dir, entry)
      const info = await stat(full).catch(() => undefined)
      if (info !== undefined && info.mtimeMs < cutoff) {
        await rm(full, { force: true }).catch(() => undefined)
      }
    }
  })

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const runGate = (gate: string, root: string, base: string, head: string, commonDir: string, patchId: string) =>
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
    if (signal === null && status !== null && !signalExitCodes.has(status)) {
      yield* recordGateFailure(commonDir, patchId, {
        command: gate,
        status: exit,
        base,
        head,
        failedAt: new Date().toISOString(),
      })
    }
    return yield* new LandFailed({
      message: `gate   ${gate}   failed with status ${exit}; nothing was pushed`,
      status: exit,
    })
  })

// The commit refs/landings/<head> names: landing.json and, when the lander wrote one, note.md.
// It has no parent, so it shares no history with main and a clone never fetches it.
const landingCommit = (record: LandingRecord, note: string | undefined) =>
  Effect.gen(function* () {
    const files = [{ name: "landing.json", text: `${JSON.stringify(record, null, 2)}\n` }]
    if (note !== undefined) files.push({ name: "note.md", text: note })
    const entries: string[] = []
    for (const file of files) {
      const blob = yield* gitWith(file.text, "hash-object", "-w", "--stdin")
      entries.push(`100644 blob ${blob}\t${file.name}\n`)
    }
    const tree = yield* gitWith(entries.join(""), "mktree")
    return yield* gitOk("commit-tree", tree, "-m", `Landing ${record.head}`)
  })

export const land = (options: {
  readonly note?: string
  readonly ackFlake?: { readonly test: string; readonly owner: string }
}) =>
  Effect.gen(function* () {
    const root = yield* gitOk("rev-parse", "--show-toplevel")
    const commonDir = yield* gitOk("rev-parse", "--path-format=absolute", "--git-common-dir")
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

    // D24: what earlier lands could not send goes first, in any repository.
    const outbox = yield* drain
    if (outbox.sent > 0) yield* say(`outbox ${outbox.sent} sent`)
    if (outbox.waiting > 0) yield* say(`outbox ${outbox.waiting} wait to send: ${outbox.why}`)

    const media = note === undefined ? undefined : yield* readNoteMedia(root, note, declaration.feed)

    yield* fetchMain(main)
    yield* refuseCommitsByAnotherAuthor(main)
    yield* rebaseOntoMain(main, root, declaration.resolve)
    if ((yield* gitOk("rev-list", "--count", `${landRef(main)}..HEAD`)) === "0") return yield* say("nothing to land")
    yield* installHooks(main, root)

    const checked = yield* gitOk("rev-parse", "HEAD")
    const checkedBase = yield* gitOk("rev-parse", landRef(main))
    const patchId = yield* patchIdForDiff(root, checkedBase, checked)

    if (declaration.gate !== undefined) {
      const priorFailure = yield* readGateFailure(commonDir, patchId)
      if (priorFailure !== undefined && options.ackFlake === undefined) {
        return yield* new LandFailed({
          message: `the gate already failed on this unchanged diff (exit ${priorFailure.status} on base ${priorFailure.base.slice(0, 7)} at ${priorFailure.failedAt}); refusing to re-run without changes.
Diagnose the failure first with a paired check on HEAD and origin/${main}, and fix it if you caused or worsened it.
If it is a verified pre-existing flake with an active owner, or fixed by a newer commit on ${main}, re-run with:
  land --ack-flake <test> --owner <seed-issue-or-sha>`,
        })
      }
    }

    if (note !== undefined) {
      const count = media!.recordings.length
      yield* say(`note   ${note.shown}${count === 0 ? "" : `, ${plural(count)}`}`)
    }
    if (options.ackFlake !== undefined) {
      yield* say(`flake  ${options.ackFlake.test} (owner ${options.ackFlake.owner})`)
    }
    let gate: LandingRecord["gate"]
    if (declaration.gate !== undefined) {
      const seconds = yield* runGate(declaration.gate, root, checkedBase, checked, commonDir, patchId)
      gate = { command: declaration.gate, seconds, ranOn: checked }
    }

    const url = yield* gitOk("remote", "get-url", "--push", "origin")
    let told = false
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      yield* fetchMain(main)
      yield* rebaseOntoMain(main, root, declaration.resolve)
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
        ...(options.ackFlake === undefined ? {} : { acknowledgedFlake: options.ackFlake }),
        recordings: listed(media?.recordings ?? []),
      }
      const landing = yield* landingCommit(record, media?.text)
      // One atomic push, so a landing ref never names a head that is not on main.
      // Push to the URL, not to the remote's name, so git writes no tracking ref that
      // another land of the clone may be writing. advanceTracking moves it forward.
      const pushed = yield* run(
        ["git", "push", "--quiet", "--atomic", url, `${head}:refs/heads/${main}`, `${landing}:refs/landings/${head}`],
        { LAND_LANDING: "1" },
      )
      if (pushed.status === 0) {
        yield* clearGateFailure(commonDir, patchId)
        yield* advanceTracking(main, head)
        yield* say(`push   ${main} is at ${yield* short(head)}`)
        if (media?.at !== undefined) yield* uploadRecordings(root, declaration.feed!, media.at, head, media.recordings)
        if (note !== undefined) yield* deleteNote(note)
        if (declaration.feed !== undefined) {
          const at = media?.at ?? (yield* githubRepository)
          if (at !== undefined) yield* say(`feed   ${landingAddress(declaration.feed, at, head)}`)
        }
        yield* warnUndoneCommits(root, main, record.base, head)
        return
      }
      const fetched = yield* fetchMain(main)
      if (yield* succeeds("merge-base", "--is-ancestor", fetched, "HEAD")) {
        return yield* new LandFailed({ message: `git push failed, and not because ${main} moved:\n${pushed.err}` })
      }
    }
    return yield* new LandFailed({ message: `${main} moved ${maxAttempts} times while landing; run land again` })
  })
