import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { constants } from "node:os"
import { Effect } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"

const maxAttempts = 5

type Ran = { readonly status: number; readonly out: string; readonly err: string }

const run = (argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  Effect.promise(async (): Promise<Ran> => {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: env === undefined ? process.env : { ...process.env, ...env },
    })
    const [out, err, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { status, out: out.trim(), err: err.trim() }
  })

const git = (...args: ReadonlyArray<string>) => run(["git", ...args])

const gitOk = (...args: ReadonlyArray<string>) =>
  git(...args).pipe(
    Effect.flatMap(({ status, out, err }) =>
      status === 0 ? Effect.succeed(out) : Effect.fail(new LandFailed({ message: `git ${args.join(" ")}: ${err}` })),
    ),
  )

const succeeds = (...args: ReadonlyArray<string>) => git(...args).pipe(Effect.map(({ status }) => status === 0))

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
const hook = (main: string) => `#!/bin/sh
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

const installHook = (main: string) =>
  Effect.gen(function* () {
    const unrefused = `plain pushes to ${main} are not refused`
    const hooksPath = yield* git("config", "--get", "core.hooksPath")
    if (hooksPath.status === 0) {
      return yield* warn(`core.hooksPath is set, so land installs no pre-push hook and ${unrefused}`)
    }
    const commonDir = yield* gitOk("rev-parse", "--path-format=absolute", "--git-common-dir")
    const path = `${commonDir}/hooks/pre-push`
    const existing = Bun.file(path)
    if (yield* Effect.promise(() => existing.exists())) {
      const text = yield* Effect.promise(() => existing.text())
      if (!text.includes(hookMark)) yield* warn(`${path} is not land's hook, so ${unrefused}`)
      return
    }
    yield* Effect.promise(async () => {
      await mkdir(`${commonDir}/hooks`, { recursive: true })
      // Exclusive create: when two lands race, the second finds the first's hook.
      await writeFile(path, hook(main), { flag: "wx", mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    })
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
    if (status === 0) return yield* say(`gate   ${gate}   ok in ${duration(Date.now() - started)}`)
    const exit = status ?? 128 + (typeof signal === "string" ? constants.signals[signal] : (signal ?? 0))
    return yield* new LandFailed({
      message: `gate   ${gate}   failed with status ${exit}; nothing was pushed`,
      status: exit,
    })
  })

export const land = Effect.gen(function* () {
  const root = yield* gitOk("rev-parse", "--show-toplevel")
  const declaration = yield* readDeclaration(root)
  const main = declaration.main ?? "main"

  if (yield* rebasing) {
    return yield* new LandFailed({ message: "a rebase is in progress; finish it, or abort it with git rebase --abort" })
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
  yield* installHook(main)

  const checked = yield* short("HEAD")
  if (declaration.gate !== undefined) {
    yield* runGate(declaration.gate, root, yield* gitOk("rev-parse", landRef(main)), yield* gitOk("rev-parse", "HEAD"))
  }

  const url = yield* gitOk("remote", "get-url", "--push", "origin")
  let told = false
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    yield* fetchMain(main)
    yield* rebaseOntoMain(main)
    if (!told && declaration.gate !== undefined && (yield* short("HEAD")) !== checked) {
      told = true
      yield* warn(`${main} moved after the gate ran on ${checked}; pushing without running it again`)
    }
    // Push to the URL, not to the remote's name, so git writes no tracking ref that
    // another land of the clone may be writing. advanceTracking moves it forward.
    const pushed = yield* run(["git", "push", "--quiet", url, `HEAD:refs/heads/${main}`], { LAND_LANDING: "1" })
    if (pushed.status === 0) {
      yield* advanceTracking(main, yield* gitOk("rev-parse", "HEAD"))
      return yield* say(`push   ${main} is at ${yield* short("HEAD")}`)
    }
    const fetched = yield* fetchMain(main)
    if (yield* succeeds("merge-base", "--is-ancestor", fetched, "HEAD")) {
      return yield* new LandFailed({ message: `git push failed, and not because ${main} moved:\n${pushed.err}` })
    }
  }
  return yield* new LandFailed({ message: `${main} moved ${maxAttempts} times while landing; run land again` })
})
