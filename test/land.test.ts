import { afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const bin = join(root, "dist", "land")

beforeAll(() => {
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (built.exitCode !== 0) throw new Error(built.stderr.toString())
})

// Every test gets a fresh home, so the global git identity is the test's own.
const worlds: string[] = []
afterEach(() => {
  for (const dir of worlds.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Result = { status: number; out: string; err: string }

const world = () => {
  const dir = mkdtempSync(join(tmpdir(), "land-test-"))
  worlds.push(dir)
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n\tname = Lander\n\temail = lander@example.com\n[init]\n\tdefaultBranch = main\n",
  )
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  }

  const git = (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
    return ran.stdout.toString().trim()
  }
  const tryGit = (cwd: string, ...args: string[]): Result => {
    const ran = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
    return { status: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
  }

  const origin = join(dir, "origin.git")
  git(dir, "init", "--quiet", "--bare", origin)
  const clone = (name: string) => {
    const path = join(dir, name)
    git(dir, "clone", "--quiet", origin, path)
    return path
  }

  // The gate runs whatever the test puts in TEST_GATE.
  const seed = clone("seed")
  writeFileSync(join(seed, "land.toml"), `gate = 'eval "$TEST_GATE"'\n`)
  writeFileSync(join(seed, "story.txt"), "one\n")
  git(seed, "add", ".")
  git(seed, "commit", "--quiet", "-m", "Start")
  git(seed, "push", "--quiet", "origin", "HEAD:main")

  const commit = (cwd: string, file: string, text: string, ...options: string[]) => {
    writeFileSync(join(cwd, file), text)
    git(cwd, "add", file)
    git(cwd, ...options, "commit", "--quiet", "-m", `Change ${file}`)
    return git(cwd, "rev-parse", "HEAD")
  }

  const start = (cwd: string, gate: string, extra: Record<string, string> = {}) => {
    const child = Bun.spawn([bin], { cwd, env: { ...env, TEST_GATE: gate, ...extra }, stdout: "pipe", stderr: "pipe" })
    const result = (async (): Promise<Result> => {
      const [out, err, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { status, out, err }
    })()
    return { child, result }
  }
  const land = (cwd: string, gate = "true") => start(cwd, gate).result

  const main = () => git(origin, "rev-parse", "main")

  // A gate that says it started, then waits to be released, so a test can act while
  // a landing sits inside its gate. Both ends are FIFOs, so nothing sleeps.
  const holdGate = (name: string) => {
    const started = join(dir, `${name}-started`)
    const release = join(dir, `${name}-release`)
    Bun.spawnSync(["mkfifo", started, release])
    return {
      gate: `echo started > "${started}"; read _ < "${release}"`,
      started: () => Bun.spawn(["cat", started], { stdout: "pipe" }).exited,
      release: () => Bun.spawn(["sh", "-c", `echo go > "${release}"`]).exited,
    }
  }

  return { dir, git, tryGit, clone, commit, start, land, main, holdGate }
}

test("a landing reaches main", async () => {
  const w = world()
  const lander = w.clone("lander")
  const head = w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander)

  expect(landed).toMatchObject({ status: 0, err: "" })
  expect(w.main()).toBe(head)
  expect(landed.out).toContain('land: gate   eval "$TEST_GATE"   ok in 0s')
  expect(landed.out).toContain(`land: push   main is at ${head.slice(0, 7)}`)
  expect(w.git(lander, "rev-parse", "origin/main")).toBe(head)
})

test("a failing gate pushes nothing, and land exits with the gate's status", async () => {
  const w = world()
  const lander = w.clone("lander")
  const before = w.main()
  w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander, "exit 3")

  expect(landed.status).toBe(3)
  expect(landed.err).toContain("failed with status 3; nothing was pushed")
  expect(w.main()).toBe(before)
})

test("a conflict stops the landing and leaves the branch as it was", async () => {
  const w = world()
  const lander = w.clone("lander")
  const other = w.clone("other")
  w.commit(other, "story.txt", "theirs\n")
  w.git(other, "push", "--quiet", "origin", "HEAD:main")
  const head = w.commit(lander, "story.txt", "ours\n")
  const before = w.main()

  const landed = await w.land(lander)

  expect(landed.status).toBe(1)
  expect(landed.err).toBe(
    "land: rebasing onto origin/main conflicts in:\n  story.txt\nRebase with git rebase origin/main, then run land again.\n",
  )
  expect(w.git(lander, "rev-parse", "HEAD")).toBe(head)
  expect(w.git(lander, "status", "--porcelain")).toBe("")
  expect(w.tryGit(lander, "rev-parse", "--verify", "--quiet", "REBASE_HEAD").status).not.toBe(0)
  expect(w.main()).toBe(before)
})

test("main moving after the gate still lands, and land names the commit the gate ran on", async () => {
  const w = world()
  const lander = w.clone("lander")
  const other = w.clone("other")
  const theirs = w.commit(other, "other.txt", "theirs\n")
  const checked = w.commit(lander, "story.txt", "two\n")

  // The gate itself lands another commit on main, so main moves while it runs.
  const landed = await w.land(lander, `git -C "${other}" push --quiet origin HEAD:main`)

  expect(landed.status).toBe(0)
  expect(landed.err).toContain(
    `land: main moved after the gate ran on ${checked.slice(0, 7)}; pushing without running it again`,
  )
  expect(w.git(lander, "rev-parse", "HEAD~1")).toBe(theirs)
  expect(w.main()).toBe(w.git(lander, "rev-parse", "HEAD"))
})

test("two lands from two worktrees of one clone both land", async () => {
  const w = world()
  const lander = w.clone("lander")
  const second = join(w.dir, "second")
  w.git(lander, "worktree", "add", "--quiet", "-b", "second", second, "origin/main")
  w.commit(lander, "one.txt", "one\n")
  w.commit(second, "two.txt", "two\n")
  const holdOne = w.holdGate("one")
  const holdTwo = w.holdGate("two")

  const landOne = w.start(lander, holdOne.gate)
  const landTwo = w.start(second, holdTwo.gate)
  await Promise.all([holdOne.started(), holdTwo.started()])
  // Both gates have passed the rebase and wait; release them together so the pushes race.
  await Promise.all([holdOne.release(), holdTwo.release()])
  const [first, other] = await Promise.all([landOne.result, landTwo.result])

  expect(first.status).toBe(0)
  expect(other.status).toBe(0)
  const landed = w.git(lander, "log", "--format=%s", "-2", w.main())
  expect(landed.split("\n").sort()).toEqual(["Change one.txt", "Change two.txt"])
})

test("a land that is killed mid-landing does not stop the next land", async () => {
  const w = world()
  const lander = w.clone("lander")
  const head = w.commit(lander, "story.txt", "two\n")
  const hold = w.holdGate("killed")

  const killed = w.start(lander, hold.gate)
  await hold.started()
  killed.child.kill("SIGKILL")
  // The orphaned gate holds the killed land's output open until it is released.
  await hold.release()
  expect((await killed.result).status).not.toBe(0)

  const landed = await w.land(lander)
  expect(landed.status).toBe(0)
  expect(w.main()).toBe(head)
})

test("an untracked file that the gate depends on stops the landing", async () => {
  const w = world()
  const lander = w.clone("lander")
  const before = w.main()
  w.commit(lander, "story.txt", "two\n")
  writeFileSync(join(lander, "needed.txt"), "only in the worktree\n")

  const landed = await w.land(lander, "test -f needed.txt")

  expect(landed.status).toBe(1)
  expect(landed.err).toBe(
    "land: the worktree has files the landing does not contain, so the gate could pass because of them:\n  needed.txt\nCommit, remove or ignore them, then run land again.\n",
  )
  expect(w.main()).toBe(before)
})

test("a commit by another author is refused", async () => {
  const w = world()
  const lander = w.clone("lander")
  const before = w.main()
  const theirs = w.commit(lander, "story.txt", "two\n", "-c", "user.email=someone@example.com")

  const landed = await w.land(lander)

  expect(landed.status).toBe(1)
  expect(landed.err).toContain("these commits are not authored by your global git identity, lander@example.com:")
  expect(landed.err).toContain(`  ${theirs.slice(0, 7)} someone@example.com Change story.txt`)
  expect(w.main()).toBe(before)
})

test("a plain push to main is refused after land has run in the clone", async () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "story.txt", "two\n")
  expect((await w.land(lander)).status).toBe(0)
  w.commit(lander, "story.txt", "three\n")
  const before = w.main()

  const pushed = w.tryGit(lander, "push", "origin", "HEAD:main")

  expect(pushed.status).not.toBe(0)
  expect(pushed.err).toContain("Land on main with land. To push past it, use git push --no-verify.")
  expect(w.main()).toBe(before)
})

test("a second land prints nothing to land", async () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "story.txt", "two\n")
  expect((await w.land(lander)).status).toBe(0)

  const again = await w.land(lander, "exit 9")

  expect(again).toEqual({ status: 0, out: "land: nothing to land\n", err: "" })
})
