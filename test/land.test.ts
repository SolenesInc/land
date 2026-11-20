import { afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const world = ({ declared = true } = {}) => {
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
  if (declared) writeFileSync(join(seed, "land.toml"), `gate = 'eval "$TEST_GATE"'\n`)
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
  const landInit = (cwd: string): Result => {
    const ran = Bun.spawnSync([bin, "init"], { cwd, env, stdout: "pipe", stderr: "pipe" })
    return { status: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
  }

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

  return { dir, git, tryGit, clone, commit, start, land, landInit, main, holdGate }
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

test("land loads no configuration from the repository it runs in", async () => {
  const w = world()
  const lander = w.clone("lander")
  // A Bun binary would otherwise load these from its working directory and fail on the preload.
  w.commit(lander, "bunfig.toml", 'preload = ["./missing-preload.ts"]\n')
  w.commit(lander, ".env", "FROM_DOTENV=set\n")
  const head = w.git(lander, "rev-parse", "HEAD")

  const version = Bun.spawnSync([bin, "--version"], { cwd: lander, stdout: "pipe", stderr: "pipe" })
  expect({ status: version.exitCode, out: version.stdout.toString(), err: version.stderr.toString() }).toEqual({
    status: 0,
    out: `land ${(await Bun.file(join(root, "package.json")).json()).version}\n`,
    err: "",
  })
  const landed = await w.land(lander, 'test -z "$FROM_DOTENV"')

  expect(landed).toMatchObject({ status: 0, err: "" })
  expect(w.main()).toBe(head)
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

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

test("land init writes land.toml and the trunk declaration, and the repository then lands", async () => {
  const w = world({ declared: false })
  const lander = w.clone("lander")
  w.commit(lander, "package.json", JSON.stringify({ scripts: { check: "echo checked" } }))
  w.commit(lander, "bun.lock", "")
  w.commit(lander, "AGENTS.md", "# Project\n\nSome guidance.\n")

  const first = w.landInit(lander)

  expect(first).toMatchObject({ status: 0, err: "" })
  expect(read(join(lander, "land.toml"))).toBe('gate = "bun run check"\n')
  expect(read(join(lander, "AGENTS.md"))).toBe(
    "# Project\n\nSome guidance.\n\n## Landing\n\nThis repository lands on `main` with `land`, with no pull request.\nBefore you land a change, run `land guide` and follow it.\n",
  )
  expect(first.out).toContain('land: land.toml  wrote gate = "bun run check", from the check script in package.json')
  expect(first.out).toContain("Then commit land.toml and AGENTS.md, and land the commit with land.")

  w.git(lander, "add", "land.toml", "AGENTS.md")
  w.git(lander, "commit", "--quiet", "-m", "Land with land")
  const landed = await w.land(lander)
  expect(landed.status).toBe(0)
  expect(landed.out).toContain("land: gate   bun run check   ok in")
  expect(w.main()).toBe(w.git(lander, "rev-parse", "HEAD"))
})

test("a second land init changes nothing", () => {
  const w = world({ declared: false })
  const lander = w.clone("lander")
  w.commit(lander, "Makefile", "check:\n\ttrue\n")
  expect(w.landInit(lander).status).toBe(0)
  const files = () => ({ toml: read(join(lander, "land.toml")), agents: read(join(lander, "AGENTS.md")) })
  const before = files()

  const again = w.landInit(lander)

  expect(again).toEqual({
    status: 0,
    out: "land: land.toml  exists, so land left it as it is\nland: AGENTS.md  already declares that the repository lands with land\n\nNothing changed.\n",
    err: "",
  })
  expect(files()).toEqual(before)
})

test("land init leaves an existing land.toml as it is", () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "CLAUDE.md", "# Project\n")
  w.commit(lander, "package.json", JSON.stringify({ scripts: { check: "true" } }))
  const before = read(join(lander, "land.toml"))

  const ran = w.landInit(lander)

  expect(ran.status).toBe(0)
  expect(read(join(lander, "land.toml"))).toBe(before)
  expect(read(join(lander, "CLAUDE.md"))).toContain("## Landing\n\nThis repository lands on `main` with `land`")
  expect(read(join(lander, "AGENTS.md"))).toBeUndefined()
  expect(ran.out).toContain("Then commit CLAUDE.md, and land the commit with land.")
})

test("land init proposes the gate from what the repository has", () => {
  const cases: ReadonlyArray<{ files: Record<string, string>; toml: string | undefined }> = [
    { files: { Makefile: "build:\n\ttrue\ncheck: build\n\ttrue\n" }, toml: 'gate = "make check"\n' },
    { files: { Makefile: "test:\n\ttrue\n" }, toml: 'gate = "make test"\n' },
    {
      files: { "package.json": JSON.stringify({ scripts: { test: "true" } }), "pnpm-lock.yaml": "" },
      toml: 'gate = "pnpm run test"\n',
    },
    {
      files: { "package.json": JSON.stringify({ scripts: { check: "true" } }), Makefile: "check:\n" },
      toml: 'gate = "npm run check"\n',
    },
    { files: { "go.mod": "module example.com/x\n" }, toml: 'gate = "go test ./..."\n' },
    { files: { "Cargo.toml": "[package]\n" }, toml: 'gate = "cargo test"\n' },
    { files: { "README.md": "# Nothing to run\n" }, toml: undefined },
    { files: { Makefile: "check := x\ntest:\n\ttrue\n" }, toml: 'gate = "make test"\n' },
    {
      files: { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
      toml: undefined,
    },
  ]
  for (const { files, toml } of cases) {
    const w = world({ declared: false })
    const lander = w.clone("lander")
    for (const [name, text] of Object.entries(files)) w.commit(lander, name, text)

    const ran = w.landInit(lander)

    expect({ files, status: ran.status, toml: read(join(lander, "land.toml")) }).toEqual({ files, status: 0, toml })
    expect(read(join(lander, "AGENTS.md"))).toContain("run `land guide` and follow it.")
  }
})

test("land init names the branch origin lands on when it is not main", () => {
  const w = world({ declared: false })
  w.git(join(w.dir, "seed"), "push", "--quiet", "origin", "HEAD:master")
  w.git(join(w.dir, "origin.git"), "symbolic-ref", "HEAD", "refs/heads/master")
  const lander = w.clone("lander")
  w.commit(lander, "go.mod", "module example.com/x\n")

  const ran = w.landInit(lander)

  expect(ran.status).toBe(0)
  expect(read(join(lander, "land.toml"))).toBe('gate = "go test ./..."\nmain = "master"\n')
  expect(read(join(lander, "AGENTS.md"))).toBe(
    "This repository lands on `master` with `land`, with no pull request.\nBefore you land a change, run `land guide` and follow it.\n",
  )
})

test("land init names a package.json it cannot parse, and writes nothing", () => {
  const w = world({ declared: false })
  const lander = w.clone("lander")
  w.commit(lander, "package.json", "{broken")

  const ran = w.landInit(lander)

  expect(ran.status).toBe(1)
  expect(ran.err).toStartWith("land: package.json: SyntaxError:")
  expect(read(join(lander, "land.toml"))).toBeUndefined()
  expect(read(join(lander, "AGENTS.md"))).toBeUndefined()
})
