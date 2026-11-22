import { afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stubFeed } from "./stub-feed.ts"

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

  const start = (cwd: string, gate: string, extra: Record<string, string> = {}, args: string[] = []) => {
    const child = Bun.spawn([bin, ...args], {
      cwd,
      env: { ...env, TEST_GATE: gate, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    })
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

  // The landing refs on origin, and what the commit of one holds.
  const landingRefs = () =>
    git(origin, "for-each-ref", "--format=%(refname)", "refs/landings/").split("\n").filter(Boolean)
  const landing = (head: string) => {
    const ref = `refs/landings/${head}`
    return {
      files: git(origin, "ls-tree", "--name-only", ref).split("\n"),
      record: JSON.parse(git(origin, "show", `${ref}:landing.json`)),
      note: tryGit(origin, "show", `${ref}:note.md`).out,
    }
  }

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

  return { dir, env, git, tryGit, clone, commit, start, land, landInit, main, landingRefs, landing, holdGate }
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

test("land guide review and land guide sheriff print procedures that any runner can follow", () => {
  for (const [topic, heading] of [
    ["review", "# Review main\n"],
    ["sheriff", "# Sheriff\n"],
  ]) {
    const printed = Bun.spawnSync([bin, "guide", topic], { stdout: "pipe", stderr: "pipe" })
    const out = printed.stdout.toString()
    expect({ status: printed.exitCode, err: printed.stderr.toString() }).toEqual({ status: 0, err: "" })
    expect(out.startsWith(heading)).toBe(true)
    expect(out).toContain(`.agents/land/${topic}.md`)
    // The runner's prompt says how to delegate and message; the procedure names no attn command.
    expect(out).not.toMatch(/\battn\b/)
  }
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
  const head = w.git(lander, "rev-parse", "HEAD")
  expect(w.main()).toBe(head)
  // The landing ref names the head that reached main, and none names the head the gate ran on.
  expect(w.landingRefs()).toEqual([`refs/landings/${head}`])
  expect(w.landing(head).record).toMatchObject({ base: theirs, head, gate: { ranOn: checked } })
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
  // The land whose push lost rebased and pushed again: only the heads on main have landing refs.
  const heads = w.git(lander, "rev-list", "-2", w.main()).split("\n")
  expect(w.landingRefs().sort()).toEqual(heads.map((head) => `refs/landings/${head}`).sort())
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

test("a landing with a note pushes main and its landing ref in one push, then deletes the note", async () => {
  const w = world()
  const lander = w.clone("lander")
  const base = w.main()
  const head = w.commit(lander, "story.txt", "two\n")
  mkdirSync(join(lander, ".land"))
  writeFileSync(join(lander, ".land", "note.md"), "The story has a second line.\n")

  // The gate sees the note, and the untracked-file check does not.
  const landed = await w.land(lander, "test -f .land/note.md")

  expect(landed).toMatchObject({ status: 0, err: "" })
  expect(landed.out).toContain("land: note   .land/note.md\n")
  expect(w.main()).toBe(head)
  expect(w.landingRefs()).toEqual([`refs/landings/${head}`])
  const pushed = w.landing(head)
  expect(pushed.files).toEqual(["landing.json", "note.md"])
  expect(pushed.note).toBe("The story has a second line.\n")
  expect(pushed.record).toEqual({
    version: 1,
    land: (await Bun.file(join(root, "package.json")).json()).version,
    base,
    head,
    gate: { command: 'eval "$TEST_GATE"', seconds: expect.any(Number), ranOn: head },
    recordings: [],
  })
  expect(existsSync(join(lander, ".land", "note.md"))).toBe(false)
  // A normal fetch does not bring the landing refs.
  w.git(lander, "fetch", "--quiet")
  expect(w.git(lander, "for-each-ref", "refs/landings/")).toBe("")
})

test("a landing without a note pushes a landing ref that holds landing.json alone", async () => {
  const w = world()
  const lander = w.clone("lander")
  const head = w.commit(lander, "story.txt", "two\n")

  expect((await w.land(lander)).status).toBe(0)

  expect(w.landing(head).files).toEqual(["landing.json"])
})

test("land --note lands the note in the file it names", async () => {
  const w = world()
  const lander = w.clone("lander")
  const head = w.commit(lander, "story.txt", "two\n")
  const elsewhere = join(w.dir, "written-elsewhere.md")
  writeFileSync(elsewhere, "Named on the command line.\n")

  const landed = await w.start(lander, "true", {}, ["--note", elsewhere]).result

  expect(landed).toMatchObject({ status: 0, err: "" })
  expect(landed.out).toContain(`land: note   ${elsewhere}\n`)
  expect(w.landing(head).note).toBe("Named on the command line.\n")
  expect(existsSync(elsewhere)).toBe(false)
})

test("land --note with no such file pushes nothing", async () => {
  const w = world()
  const lander = w.clone("lander")
  const before = w.main()
  w.commit(lander, "story.txt", "two\n")

  const landed = await w.start(lander, "true", {}, ["--note", "missing.md"]).result

  expect(landed).toEqual({ status: 1, out: "", err: "land: --note missing.md: no such file\n" })
  expect(w.main()).toBe(before)
})

test("a note that git tracks is refused, because land would delete it", async () => {
  const w = world()
  const lander = w.clone("lander")
  const before = w.main()
  w.commit(lander, "CHANGES.md", "Tracked.\n")

  const landed = await w.start(lander, "true", {}, ["--note", "CHANGES.md"]).result

  expect(landed.status).toBe(1)
  expect(landed.err).toBe(
    "land: the note CHANGES.md is committed, and land deletes the note after the push; write it in a file git does not track\n",
  )
  expect(read(join(lander, "CHANGES.md"))).toBe("Tracked.\n")
  expect(w.main()).toBe(before)
})

test("a failing gate keeps the note and pushes no landing ref", async () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "story.txt", "two\n")
  mkdirSync(join(lander, ".land"))
  writeFileSync(join(lander, ".land", "note.md"), "Kept.\n")

  expect((await w.land(lander, "exit 3")).status).toBe(3)

  expect(read(join(lander, ".land", "note.md"))).toBe("Kept.\n")
  expect(w.landingRefs()).toEqual([])
})

test("land adds .land/ to the clone's exclude once, for every worktree", async () => {
  const w = world()
  const lander = w.clone("lander")
  const exclude = join(lander, ".git", "info", "exclude")
  writeFileSync(exclude, "# written on Windows\r\n# no trailing newline")
  w.commit(lander, "story.txt", "two\n")
  expect((await w.land(lander)).status).toBe(0)
  expect((await w.land(lander)).out).toBe("land: nothing to land\n")

  const second = join(w.dir, "second")
  w.git(lander, "worktree", "add", "--quiet", "-b", "second", second, "origin/main")
  const head = w.commit(second, "other.txt", "other\n")
  mkdirSync(join(second, ".land"))
  writeFileSync(join(second, ".land", "note.md"), "From the second worktree.\n")
  expect((await w.land(second)).status).toBe(0)

  expect(read(exclude)).toBe("# written on Windows\r\n# no trailing newline\n.land/\n")
  expect(w.landing(head).note).toBe("From the second worktree.\n")
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
  expect(read(join(lander, "land.toml"))).toBe('gate = "bun run check"\nfeed = "https://land-feed.caketroll.cloud"\n')
  expect(read(join(lander, "AGENTS.md"))).toBe(
    "# Project\n\nSome guidance.\n\n## Landing\n\nThis repository lands on `main` with `land`, with no pull request.\nBefore you land a change, run `land guide` and follow it.\n",
  )
  expect(first.out).toContain('land: land.toml  wrote gate = "bun run check", from the check script in package.json')
  expect(first.out).toContain('land: land.toml  wrote feed = "https://land-feed.caketroll.cloud", where landings show')
  expect(first.out).toContain(
    "Install the App on the repository, so the feed shows its landings: https://github.com/apps/attn-land/installations/new",
  )
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
  // That land.toml names no feed, so init says how to join it.
  expect(ran.out).toContain(
    'add feed = "https://land-feed.caketroll.cloud" to land.toml, and install the App: https://github.com/apps/attn-land/installations/new',
  )
})

test("land init proposes the gate from what the repository has", () => {
  const feed = 'feed = "https://land-feed.caketroll.cloud"\n'
  const cases: ReadonlyArray<{ files: Record<string, string>; toml: string | undefined }> = [
    { files: { Makefile: "build:\n\ttrue\ncheck: build\n\ttrue\n" }, toml: `gate = "make check"\n${feed}` },
    { files: { Makefile: "test:\n\ttrue\n" }, toml: `gate = "make test"\n${feed}` },
    {
      files: { "package.json": JSON.stringify({ scripts: { test: "true" } }), "pnpm-lock.yaml": "" },
      toml: `gate = "pnpm run test"\n${feed}`,
    },
    {
      files: { "package.json": JSON.stringify({ scripts: { check: "true" } }), Makefile: "check:\n" },
      toml: `gate = "npm run check"\n${feed}`,
    },
    { files: { "go.mod": "module example.com/x\n" }, toml: `gate = "go test ./..."\n${feed}` },
    { files: { "Cargo.toml": "[package]\n" }, toml: `gate = "cargo test"\n${feed}` },
    { files: { "README.md": "# Nothing to run\n" }, toml: undefined },
    { files: { Makefile: "check := x\ntest:\n\ttrue\n" }, toml: `gate = "make test"\n${feed}` },
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
  expect(read(join(lander, "land.toml"))).toBe(
    'gate = "go test ./..."\nmain = "master"\nfeed = "https://land-feed.caketroll.cloud"\n',
  )
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

// A PATH without the attn of the machine running the tests.
const pathWithoutAttn = (process.env.PATH ?? "")
  .split(":")
  .filter((dir) => dir !== "" && !existsSync(join(dir, "attn")))
  .join(":")

// Commits in an attn session, with the attn the test writes, or none.
const attnSession = (w: ReturnType<typeof world>, attn: string | undefined) => {
  const bin = join(w.dir, `attn-${Math.random().toString(36).slice(2)}`)
  mkdirSync(bin)
  if (attn !== undefined) writeFileSync(join(bin, "attn"), `#!/bin/sh\n${attn}\n`, { mode: 0o755 })
  const env = { ...w.env, ATTN_INSIDE_APP: "1", PATH: `${bin}:${pathWithoutAttn}` }
  return (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(["git", "commit", "--quiet", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) throw new Error(`git commit: ${ran.stderr}`)
    return w.git(cwd, "log", "-1", "--format=%(trailers:only)")
  }
}

const presentAttn = `case "$2" in
  --session-id) echo session-1 ;;
  --seed-ids) printf 's-one\\ns-two\\n' ;;
  *) exit 2 ;;
esac`

const hookFiles = (w: ReturnType<typeof world>, clone: string) =>
  ["pre-push", "prepare-commit-msg"].map((name) =>
    read(join(w.git(clone, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks", name)),
  )

test("after land, a commit made in an attn session names the session and its seeds", async () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "story.txt", "two\n")
  expect((await w.land(lander)).status).toBe(0)
  const hooks = hookFiles(w, lander)
  expect(hooks.every((hook) => hook?.includes("# Installed by land."))).toBe(true)

  const commit = attnSession(w, presentAttn)
  expect(commit(lander, "--allow-empty", "-m", "In a session")).toBe(
    "Attn-Session: session-1\nAttn-Seed: s-one\nAttn-Seed: s-two",
  )
  expect(commit(lander, "--amend", "--no-edit", "--allow-empty")).toBe(
    "Attn-Session: session-1\nAttn-Seed: s-one\nAttn-Seed: s-two",
  )

  w.commit(lander, "story.txt", "three\n")
  expect((await w.land(lander)).status).toBe(0)
  expect(hookFiles(w, lander)).toEqual(hooks)
})

test("a commit gets no attn trailer, and still succeeds, when attn is absent or fails", async () => {
  const w = world()
  const lander = w.clone("lander")
  w.commit(lander, "story.txt", "two\n")
  expect((await w.land(lander)).status).toBe(0)

  expect(attnSession(w, undefined)(lander, "--allow-empty", "-m", "No attn")).toBe("")
  expect(attnSession(w, "exit 1")(lander, "--allow-empty", "-m", "A failing attn")).toBe("")
  expect(w.git(lander, "log", "-1", "--format=%s")).toBe("A failing attn")
})

test("land init installs the hooks, so a commit before the first land names its session", () => {
  const w = world()
  const lander = w.clone("lander")

  const ran = w.landInit(lander)

  expect(ran.out).toContain("land: hooks      installed pre-push and prepare-commit-msg\n")
  expect(attnSession(w, presentAttn)(lander, "--allow-empty", "-m", "Before the first land")).toBe(
    "Attn-Session: session-1\nAttn-Seed: s-one\nAttn-Seed: s-two",
  )
})

test("land leaves another prepare-commit-msg hook as it is, and says so", async () => {
  const w = world()
  const lander = w.clone("lander")
  const foreign = "#!/bin/sh\nexit 0\n"
  writeFileSync(join(lander, ".git", "hooks", "prepare-commit-msg"), foreign, { mode: 0o755 })
  w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander)

  expect(landed.status).toBe(0)
  expect(landed.err).toContain(
    `/lander/.git/hooks/prepare-commit-msg is not land's hook, so land adds no attn trailers to commits\n`,
  )
  expect(hookFiles(w, lander)[1]).toBe(foreign)
  expect(hookFiles(w, lander)[0]).toContain("# Installed by land.")
})

// A record command that writes one file per argument into LAND_MEDIA, and says where it ran.
const withRecord = (w: ReturnType<typeof world>, script: string) => {
  const lander = w.clone("lander")
  writeFileSync(join(lander, "land.toml"), `gate = 'eval "$TEST_GATE"'\nrecord = "sh record.sh"\n`)
  writeFileSync(join(lander, "record.sh"), script)
  w.git(lander, "add", ".")
  w.git(lander, "commit", "--quiet", "-m", "Declare record")
  return lander
}
const runLand = (w: ReturnType<typeof world>, cwd: string, ...args: string[]): Result => {
  const ran = Bun.spawnSync([bin, ...args], { cwd, env: w.env, stdout: "pipe", stderr: "pipe" })
  return { status: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

test("land record prints one markdown line per new recording, and the repository still lands", async () => {
  const w = world()
  const lander = withRecord(
    w,
    'for name in "$@"; do echo shot > "$LAND_MEDIA/$name"; done; echo x > "$LAND_MEDIA/.hidden"; mkdir -p "$LAND_MEDIA/sub"; echo "ran in $PWD"\n',
  )
  mkdirSync(join(lander, "src"))

  const first = runLand(w, join(lander, "src"), "record", "one.png", "two shots.gif")

  expect(first.status).toBe(0)
  expect(first.out).toBe("![one](.land/media/one.png)\n![two shots](.land/media/two%20shots.gif)\n")
  expect(first.err).toContain(`ran in ${realpathSync(lander)}`)
  expect(readFileSync(join(lander, ".land", "media", "one.png"), "utf8")).toBe("shot\n")

  // Only what this run recorded is new.
  const second = runLand(w, lander, "record", "three.png")
  expect(second.out).toBe("![three](.land/media/three.png)\n")

  // .land/ is excluded in the clone, so the untracked-file check never sees the recordings.
  w.commit(lander, "story.txt", "two\n")
  const landed = await w.land(lander)
  expect(landed).toMatchObject({ status: 0 })
  expect(w.git(lander, "status", "--porcelain")).toBe("")
})

test("land record names the key when the declaration has no record command", () => {
  const w = world()
  const lander = w.clone("lander")

  const ran = runLand(w, lander, "record")

  expect(ran.status).toBe(1)
  expect(ran.out).toBe("")
  expect(ran.err).toContain("land: land.toml names no record command; add the key, for example:\n  record = ")
})

test("a failing record command makes land exit with its status and print no line", () => {
  const w = world()
  const lander = withRecord(w, 'echo shot > "$LAND_MEDIA/partial.png"; exit 7\n')

  const ran = runLand(w, lander, "record")

  expect(ran.status).toBe(7)
  expect(ran.out).toBe("")
  expect(ran.err).toContain("failed with status 7")
})

const feedOf = (w: ReturnType<typeof world>, port = 0, installed = true) =>
  stubFeed(join(w.dir, "origin.git"), { port, installed })

// A clone whose origin is SolenesInc/demo on GitHub, as configured, while git reaches the world's
// origin.git, and whose declaration names the feed.
const feedClone = (w: ReturnType<typeof world>, feed: string | undefined) => {
  const lander = w.clone("lander")
  const github = "git@github.com:SolenesInc/demo.git"
  w.git(lander, "config", "remote.origin.url", github)
  w.git(lander, "config", `url.${join(w.dir, "origin.git")}.insteadOf`, github)
  const declared = feed === undefined ? "" : `feed = "${feed}"\n`
  writeFileSync(join(lander, "land.toml"), `gate = 'eval "$TEST_GATE"'\nrecord = "sh record.sh"\n${declared}`)
  writeFileSync(join(lander, "record.sh"), 'echo "recorded $1" > "$LAND_MEDIA/$1"\n')
  w.git(lander, "add", ".")
  w.git(lander, "commit", "--quiet", "-m", "Declare the feed")
  return lander
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const outbox = (w: ReturnType<typeof world>) => {
  const dir = join(w.dir, ".local", "state", "land", "outbox")
  return existsSync(dir) ? Bun.spawnSync(["ls", dir]).stdout.toString().split("\n").filter(Boolean) : []
}

test("a note linking a local recording lists it in landing.json, uploads it after the push with no credential, and the pushed note holds the feed address", async () => {
  const w = world()
  const feed = feedOf(w)
  const lander = feedClone(w, feed.url)
  const link = runLand(w, lander, "record", "banner flicker.mp4").out.trim()
  writeFileSync(
    join(lander, ".land", "note.md"),
    `The banner no longer flickers.\n\n${link}\n\n![again](${link.slice(link.indexOf("(") + 1, -1)})\n`,
  )
  const head = w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander)
  feed.stop()

  expect(landed).toMatchObject({ status: 0, err: "" })
  const hash = sha256("recorded banner flicker.mp4\n")
  const address = `${feed.url}/m/SolenesInc/demo/${hash}.mp4`
  expect(landed.out).toContain("land: note   .land/note.md, 1 recording\n")
  expect(landed.out).toContain(`land: push   main is at ${head.slice(0, 7)}\nland: media  1 recording uploaded\n`)
  expect(landed.out).toContain(`land: feed   ${feed.url}/SolenesInc/demo/${head.slice(0, 7)}\n`)
  expect(w.landing(head).record.recordings).toEqual([{ sha256: hash, ext: "mp4", bytes: 28 }])
  expect(w.landing(head).note).toBe(
    `The banner no longer flickers.\n\n![banner flicker](${address})\n\n![again](${address})\n`,
  )
  expect(feed.stored.get(hash)).toBe("recorded banner flicker.mp4\n")
  expect(feed.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    `POST /api/media/SolenesInc/demo/${head}/${hash}`,
    `PUT /r2/${hash}`,
    `POST /api/media/SolenesInc/demo/${head}/${hash}/uploaded`,
  ])
  expect(feed.requests.every((r) => r.credential === null)).toBe(true)
  // The note and the recording it uploaded are gone; nothing waits.
  expect(existsSync(join(lander, ".land", "note.md"))).toBe(false)
  expect(existsSync(join(lander, ".land", "media", "banner flicker.mp4"))).toBe(false)
  expect(outbox(w)).toEqual([])
})

test("a link to a missing file, a recording over 200 MB and a local recording without a feed key each fail before the gate with nothing pushed", async () => {
  const cases = [
    {
      feed: "http://127.0.0.1:9",
      note: "![gone](.land/media/gone.mp4)\n",
      says: "the note .land/note.md links .land/media/gone.mp4, and there is no such file; nothing was pushed",
    },
    {
      feed: "http://127.0.0.1:9",
      note: "![huge](.land/media/huge.webm)\n",
      big: "huge.webm",
      says: "the note .land/note.md links .land/media/huge.webm, which is 201 MB; the feed takes recordings up to 200 MB",
    },
    {
      feed: undefined,
      note: "![shot](.land/media/shot.png)\n",
      file: "shot.png",
      says: 'the note .land/note.md links the recording .land/media/shot.png, and land.toml names no feed to host it; add\n  feed = "https://land-feed.caketroll.cloud"',
    },
  ]
  for (const c of cases) {
    const w = world()
    const lander = feedClone(w, c.feed)
    mkdirSync(join(lander, ".land", "media"), { recursive: true })
    if (c.file) writeFileSync(join(lander, ".land", "media", c.file), "shot\n")
    // Sparse, so the test writes no 201 MB.
    if (c.big) Bun.spawnSync(["truncate", "-s", String(201 * 1024 * 1024), join(lander, ".land", "media", c.big)])
    writeFileSync(join(lander, ".land", "note.md"), c.note)
    w.commit(lander, "story.txt", "two\n")
    const before = w.main()

    const landed = await w.land(lander, "touch gate-ran")

    expect({ status: landed.status, err: landed.err }).toEqual({
      status: 1,
      err: expect.stringContaining(`land: ${c.says}`),
    })
    expect(existsSync(join(lander, "gate-ran"))).toBe(false)
    expect(w.main()).toBe(before)
    expect(w.landingRefs()).toEqual([])
    expect(readFileSync(join(lander, ".land", "note.md"), "utf8")).toBe(c.note)
  }
})

test("with the feed unreachable, land pushes, the outbox holds the file, and the next land uploads it and empties the outbox", async () => {
  const w = world()
  const down = feedOf(w)
  down.stop() // nothing listens on its port now
  const lander = feedClone(w, down.url)
  runLand(w, lander, "record", "demo.png")
  writeFileSync(join(lander, ".land", "note.md"), "A demo.\n\n![demo](.land/media/demo.png)\n")
  const head = w.commit(lander, "story.txt", "two\n")
  const hash = sha256("recorded demo.png\n")

  const first = await w.land(lander)

  expect(first.status).toBe(0)
  expect(w.main()).toBe(head)
  expect(first.out).toContain(
    `land: push   main is at ${head.slice(0, 7)}\nland: media  .land/media/demo.png waits in the outbox: the feed did not answer\n`,
  )
  expect(w.landing(head).note).toBe(`A demo.\n\n![demo](${down.url}/m/SolenesInc/demo/${hash}.png)\n`)
  expect(outbox(w)).toEqual([`recording~SolenesInc~demo~${hash}.bytes`, `recording~SolenesInc~demo~${hash}.json`])
  // The note is gone, since it landed; the recording stays, since it did not upload.
  expect(existsSync(join(lander, ".land", "note.md"))).toBe(false)
  expect(existsSync(join(lander, ".land", "media", "demo.png"))).toBe(true)

  // Still down: the next land says what waits.
  const waiting = await w.land(lander)
  expect(waiting.out).toContain("land: outbox 1 wait to send: the feed did not answer\nland: nothing to land\n")

  const up = feedOf(w, down.port)
  const next = await w.land(lander)
  up.stop()

  expect(next.out).toContain("land: outbox 1 sent\nland: nothing to land\n")
  expect(up.stored.get(hash)).toBe("recorded demo.png\n")
  expect(outbox(w)).toEqual([])
  const quiet = await w.land(lander)
  expect(quiet.out).toBe("land: nothing to land\n")
})

test("land event pushes refs/land-events/<sha>/<id> holding the event, notifies the feed, and keeps the notice in the outbox when the feed is down", async () => {
  const w = world()
  const feed = feedOf(w)
  const lander = feedClone(w, feed.url)
  const head = w.commit(lander, "story.txt", "two\n")
  await w.land(lander)
  writeFileSync(join(w.dir, "finding.md"), "It flickers on **resize**.\n")
  const origin = join(w.dir, "origin.git")
  const event = (...args: string[]) => w.start(lander, "true", {}, ["event", head.slice(0, 7), ...args]).result

  const told = await event(
    "--kind",
    "finding",
    "--state",
    "fail",
    "--title",
    "banner flickers",
    "--detail-file",
    join(w.dir, "finding.md"),
  )

  expect(told.status).toBe(0)
  const refs = w.git(origin, "for-each-ref", "--format=%(refname)", `refs/land-events/${head}/`).split("\n")
  expect(refs.length).toBe(1)
  const id = refs[0]!.split("/").pop()!
  expect(told.out).toBe(`land: event  refs/land-events/${head}/${id} pushed; the feed has it\n`)
  expect(w.git(origin, "rev-list", "--count", id)).toBe("1") // no parent
  expect(w.git(origin, "ls-tree", "--name-only", id)).toBe("event.json")
  const body = JSON.parse(w.git(origin, "show", `${id}:event.json`))
  expect(body).toEqual({
    kind: "finding",
    state: "fail",
    title: "banner flickers",
    at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    detail: "It flickers on **resize**.\n",
  })
  expect(feed.requests.at(-1)).toEqual({
    method: "POST",
    path: `/api/landings/SolenesInc/demo/${head}/events/${id}`,
    credential: null,
  })

  // The feed is down: the ref is pushed, and the notice waits; the next land sends it.
  feed.stop()
  const later = await event("--kind", "repair", "--state", "pass", "--title", "fixed", "--repairs", head)
  expect(later.status).toBe(0)
  const second = w
    .git(origin, "for-each-ref", "--format=%(refname)", `refs/land-events/${head}/`)
    .split("\n")
    .find((r) => !r.endsWith(id))!
  expect(later.out).toBe(`land: event  ${second} pushed; the notice waits in the outbox: the feed did not answer\n`)
  expect(outbox(w)).toEqual([`event~SolenesInc~demo~${second.split("/").pop()}.json`])

  const up = feedOf(w, feed.port)
  const next = await w.land(lander)
  up.stop()
  expect(next.out).toContain("land: outbox 1 sent\n")
  expect(up.requests.map((r) => r.path)).toEqual([
    `/api/landings/SolenesInc/demo/${head}/events/${second.split("/").pop()}`,
  ])
  expect(outbox(w)).toEqual([])

  const bad = await event("--kind", "x", "--state", "maybe", "--title", "t")
  expect(bad.status).toBe(2)
})

test("a note may link a file the repository tracks and show a link in code: land uploads the file, keeps it, and leaves the code as written", async () => {
  const w = world()
  const feed = feedOf(w)
  const lander = feedClone(w, feed.url)
  mkdirSync(join(lander, "docs"))
  w.commit(lander, "docs/diagram.png", "a diagram\n")
  const note =
    "The flow.\n\n![flow](docs/diagram.png)\n\n`land record` prints `![x](.land/media/x.mp4)`.\n\n```\n![y](.land/media/y.mp4)\n```\n"
  mkdirSync(join(lander, ".land"), { recursive: true })
  writeFileSync(join(lander, ".land", "note.md"), note)
  const head = w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander)
  feed.stop()

  expect(landed).toMatchObject({ status: 0, err: "" })
  expect(landed.out).toContain("land: note   .land/note.md, 1 recording\n")
  expect(landed.out).toContain("land: media  1 recording uploaded\n")
  const address = `${feed.url}/m/SolenesInc/demo/${sha256("a diagram\n")}.png`
  expect(w.landing(head).note).toBe(note.replace("](docs/diagram.png)", `](${address})`))
  expect(readFileSync(join(lander, "docs", "diagram.png"), "utf8")).toBe("a diagram\n")
  expect(w.git(lander, "status", "--porcelain")).toBe("")
})

test("a feed that refuses the recording and the event, as one without the App does, drops them with why, and land still succeeds", async () => {
  const w = world()
  const feed = feedOf(w, 0, false)
  const lander = feedClone(w, feed.url)
  runLand(w, lander, "record", "demo.png")
  writeFileSync(join(lander, ".land", "note.md"), "![demo](.land/media/demo.png)\n")
  const head = w.commit(lander, "story.txt", "two\n")

  const landed = await w.land(lander)
  const told = await w.start(lander, "true", {}, ["event", head, "--kind", "stage", "--state", "info", "--title", "t"])
    .result
  feed.stop()

  expect(landed.status).toBe(0)
  expect(w.main()).toBe(head)
  expect(landed.out).toContain(
    "land: media  .land/media/demo.png is not uploaded: the feed answered 404; is the Attn Land App installed on SolenesInc/demo?\n",
  )
  expect(told.status).toBe(0)
  expect(told.out).toContain(
    "pushed; the feed refused the notice: the feed answered 404; is the Attn Land App installed",
  )
  expect(outbox(w)).toEqual([])
})

test("land bug registers a bug to a culprit commit (with optional --fixed-by) and land bugs queries it", async () => {
  const w = world()
  const feed = feedOf(w)
  const lander = feedClone(w, feed.url)
  const culprit = w.commit(lander, "story.txt", "buggy\n")
  await w.land(lander)
  const fix = w.commit(lander, "story.txt", "fixed\n")
  await w.land(lander)

  writeFileSync(join(w.dir, "bug.md"), "Repro: trigger concurrent refresh.\n")
  const reg = await w.start(lander, "true", {}, [
    "bug",
    culprit.slice(0, 7),
    "--title",
    "refresh race",
    "--severity",
    "p0",
    "--source",
    "agent",
    "--location",
    "story.txt:1",
    "--detail-file",
    join(w.dir, "bug.md"),
  ]).result
  expect(reg.status).toBe(0)
  expect(reg.out).toContain(`land: bug    refs/land-events/${culprit}/`)
  expect(reg.out).toContain("pushed; the feed has it")

  const listed = await w.start(lander, "true", {}, ["bugs", "--open", "--severity", "p0", "--path", "story.txt"]).result
  expect(listed.status).toBe(0)
  expect(listed.out).toContain(`P0  ${culprit.slice(0, 7)}  [open]  refresh race (story.txt:1)`)

  const regWithFix = await w.start(lander, "true", {}, [
    "bug",
    culprit.slice(0, 7),
    "--title",
    "second bug",
    "--fixed-by",
    fix.slice(0, 7),
  ]).result
  expect(regWithFix.status).toBe(0)
  expect(regWithFix.out).toContain("land: bug")
  expect(regWithFix.out).toContain("land: repair")

  const openAfterFix = await w.start(lander, "true", {}, ["bugs", "--open", "--json"]).result
  expect(openAfterFix.status).toBe(0)
  expect(JSON.parse(openAfterFix.out)).toEqual([])
  feed.stop()
})

test("land auth, show, comments, review check and brief work end-to-end against the feed", async () => {
  const w = world()
  const commentsSeed = [
    {
      id: "c-1",
      owner: "SolenesInc",
      name: "demo",
      head: "",
      author: "victor",
      path: "story.txt",
      side: "additions" as const,
      lineStart: 1,
      lineEnd: 1,
      kind: "concern" as const,
      body: "Handle empty input here.",
      status: "open" as const,
      resolvedBy: null,
      resolvedAt: null,
      resolvedBySha: null,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
  ]
  const feed = stubFeed(join(w.dir, "origin.git"), { requireToken: "secret-tok", comments: commentsSeed })
  const lander = feedClone(w, feed.url)
  const head = w.commit(lander, "story.txt", "line one\nline two\n")
  await w.land(lander)
  feed.comments[0] = { ...feed.comments[0]!, head }

  // Without token, private feed answers 404.
  const denied = await w.start(lander, "true", {}, ["show", head.slice(0, 7)]).result
  expect(denied.status).toBe(1)
  expect(denied.err).toContain("land auth token")

  // Save token via land auth token
  const authed = await w.start(lander, "true", {}, ["auth", "token", "secret-tok"]).result
  expect(authed.status).toBe(0)
  const status = await w.start(lander, "true", {}, ["auth", "status"]).result
  expect(status.out).toContain("token saved")

  // land show by sha and by full URL
  const shown = await w.start(lander, "true", {}, ["show", head.slice(0, 7)]).result
  expect(shown.status).toBe(0)
  expect(shown.out).toContain("Handle empty input here.")
  const shownByUrl = await w.start(lander, "true", {}, ["show", `${feed.url}/SolenesInc/demo/${head.slice(0, 7)}`])
    .result
  expect(shownByUrl.status).toBe(0)
  expect(shownByUrl.out).toContain("Handle empty input here.")

  // land comments & resolve
  const list = await w.start(lander, "true", {}, ["comments", "--open"]).result
  expect(list.status).toBe(0)
  expect(list.out).toContain("[open] c-1")
  const resolved = await w.start(lander, "true", {}, ["comments", "resolve", "c-1", "--by", head.slice(0, 7)]).result
  expect(resolved.status).toBe(0)
  expect(resolved.out).toContain(`resolved (by ${head.slice(0, 7)})`)
  const after = await w.start(lander, "true", {}, ["comments", "--open"]).result
  expect(after.out).toContain("No open comments.")

  // land review check & land brief
  const docPath = join(w.dir, "review.md")
  writeFileSync(
    docPath,
    `---\nland: review\nframe: walkthrough\n---\n\n# Story update\n\nAdds a second line.\n\n## Update story\n\n### story.txt:1-2\n\n- L2!: New second line.\n`,
  )
  const checked = await w.start(lander, "true", {}, ["review", "check", docPath, "--head", head]).result
  expect(checked.status).toBe(0)
  expect(checked.out).toContain("land: review ok  frame=walkthrough  1 stop, 1 files covered")

  const briefed = await w.start(lander, "true", {}, ["brief", head.slice(0, 7), docPath]).result
  expect(briefed.status).toBe(0)
  expect(briefed.out).toContain(`land: brief  refs/land-events/${head}/`)
  expect(briefed.out).toContain("pushed; the feed has it")

  const logout = await w.start(lander, "true", {}, ["auth", "logout"]).result
  expect(logout.status).toBe(0)
  feed.stop()
})
