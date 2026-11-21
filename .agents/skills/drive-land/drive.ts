#!/usr/bin/env bun
// Drives land in a scratch world and keeps the evidence. SKILL.md beside this file says how to use it.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { join, resolve } from "node:path"
import { stubFeed } from "../../../test/stub-feed.ts"

const usage = `usage: drive.ts <run> <command>

  up                    build land from this checkout and make a fresh world: a home, a git
                        identity, a bare repository as origin with one commit on main, and
                        the clone "lander"
  clone <name>          add another clone of origin to the world
  do <dir> '<command>'  run a shell command in <dir> of the world, print what it printed,
                        save it as evidence, and exit with its status
  feed <dir> '<command>'
                        do, while the world's stub feed answers at the address up printed;
                        the evidence also lists the requests the feed got
  doctor                say whether the world is worth driving; ends with "ok"
  down                  remove the world and keep the evidence

A run lives at /tmp/land-drive/<run>: the world in world/, the evidence in evidence/.
`

const checkout = resolve(import.meta.dir, "../../..")
const [run, command, ...rest] = process.argv.slice(2)
if (run === undefined || command === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(run)) {
  process.stderr.write(usage)
  process.exit(2)
}

const base = join("/tmp/land-drive", run)
const world = join(base, "world")
const evidence = join(base, "evidence")
const origin = join(world, "origin.git")
const built = join(world, "built.json")
const feedPort = join(world, "feed-port")
const identity = "lander@example.com"

// What every command in the world sees. The home and the git identity are the world's
// own, land on the PATH is the copy this run built, and the variables land sets for its
// own push and gate are cleared, so a drive from inside a gate or a landing starts clean.
const worldEnv = () => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("LAND_") && !name.startsWith("GIT_")) env[name] = value
  }
  return {
    ...env,
    HOME: join(world, "home"),
    XDG_CONFIG_HOME: join(world, "home", ".config"),
    GIT_CONFIG_GLOBAL: join(world, "home", "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${join(world, "bin")}:${process.env.PATH ?? ""}`,
  }
}

type Ran = { status: number; out: string; err: string }

const sh = (cwd: string, script: string, env: Record<string, string | undefined> = worldEnv()): Ran => {
  const ran = Bun.spawnSync(["sh", "-c", script], { cwd, env, stdout: "pipe", stderr: "pipe" })
  // A command a signal killed has no exit code. Report it as a shell does: 128 + the signal.
  const status = ran.exitCode ?? 128 + (constants.signals[ran.signalCode as keyof typeof constants.signals] ?? 0)
  return { status, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

const must = (cwd: string, script: string, env: Record<string, string | undefined> = worldEnv()) => {
  const ran = sh(cwd, script, env)
  if (ran.status !== 0) fail(`${script}\n${ran.err}${ran.out}`)
  return ran.out.trim()
}

function fail(message: string): never {
  console.error(`drive: ${message}`)
  process.exit(1)
}

const needWorld = () => {
  if (!existsSync(built)) fail(`run ${run} has no world; start one with: drive.ts ${run} up`)
}

// A hash of the sources land is built from, so doctor can tell a world whose binary is
// older than the checkout.
const sources = () => {
  const files = must(checkout, "git ls-files -co --exclude-standard src package.json bun.lock", process.env)
  const hash = new Bun.CryptoHasher("sha256")
  for (const file of files.split("\n").sort()) {
    hash.update(file)
    const path = join(checkout, file)
    hash.update(existsSync(path) ? readFileSync(path) : "gone")
  }
  return hash.digest("hex")
}

const clone = (name: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`a clone's name is lowercase letters, digits and dashes: ${name}`)
  if (existsSync(join(world, name))) fail(`${name} already exists in run ${run}`)
  must(world, `git clone --quiet "${origin}" ${name}`)
}

const up = () => {
  if (existsSync(base)) fail(`run ${run} was used already, and its evidence is kept; choose another id`)
  const build = sh(checkout, "bun run build", process.env)
  if (build.status !== 0) fail(`bun run build failed; run bun install in ${checkout} first\n${build.err}`)
  mkdirSync(join(world, "home"), { recursive: true })
  mkdirSync(join(world, "bin"))
  mkdirSync(evidence)
  cpSync(join(checkout, "dist", "land"), join(world, "bin", "land"))
  chmodSync(join(world, "bin", "land"), 0o755)
  writeFileSync(
    join(world, "home", "gitconfig"),
    `[user]\n\tname = Lander\n\temail = ${identity}\n[init]\n\tdefaultBranch = main\n`,
  )
  must(world, `git init --quiet --bare "${origin}"`)
  clone("lander")
  const lander = join(world, "lander")
  writeFileSync(join(lander, "land.toml"), 'gate = "sh gate.sh"\n')
  writeFileSync(join(lander, "gate.sh"), "echo gate ran on $LAND_HEAD, based on $LAND_BASE\n")
  writeFileSync(join(lander, "story.txt"), "one\n")
  must(lander, "git add . && git commit --quiet -m Start && git push --quiet origin HEAD:main")
  must(lander, "git fetch --quiet origin && git switch --quiet -c work origin/main")
  const version = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version as string
  writeFileSync(built, JSON.stringify({ version, sources: sources() }) + "\n")
  // The stub feed's address stays the same for the run, so a land.toml can name it.
  const probe = stubFeed(origin)
  probe.stop()
  writeFileSync(feedPort, `${probe.port}\n`)
  console.log(`world:    ${world}`)
  console.log(`evidence: ${evidence}`)
  console.log(`lander:   on branch work at origin/main, with land.toml naming the gate "sh gate.sh"`)
  console.log(`land:     ${version}, built from ${checkout}`)
  console.log(`feed:     ${probe.url}, answering only during drive.ts ${run} feed`)
}

const slug = (script: string) =>
  script
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const where = (verb: string, dir: string | undefined, script: string | undefined, extra: number) => {
  needWorld()
  if (dir === undefined || script === undefined || extra > 0) {
    fail(
      `${verb} takes a directory of the world and one shell command in quotes, such as: ${verb} lander 'land --help'`,
    )
  }
  const cwd = join(world, dir)
  if (!existsSync(cwd)) fail(`${dir} is not in run ${run}; the world holds: ${readdirSync(world).join(" ")}`)
  return cwd
}

const save = (dir: string, script: string, ran: Ran, also = "") => {
  const number = String(readdirSync(evidence).length + 1).padStart(2, "0")
  const file = join(evidence, `${number}-${slug(dir)}-${slug(script)}.txt`)
  writeFileSync(
    file,
    `$ ${script}\ndir: ${dir}\nexit: ${ran.status}\n--- stdout\n${ran.out}--- stderr\n${ran.err}${also}`,
  )
  process.stdout.write(ran.out)
  process.stderr.write(ran.err)
  console.error(`drive: exit ${ran.status}, saved ${file}`)
  process.exit(ran.status)
}

const drive = (dir: string | undefined, script: string | undefined, extra: number) => {
  const cwd = where("do", dir, script, extra)
  save(dir!, script!, sh(cwd, script!))
}

// The command runs while this process serves the stub feed, so it is spawned without blocking.
const driveWithFeed = async (dir: string | undefined, script: string | undefined, extra: number) => {
  const cwd = where("feed", dir, script, extra)
  const feed = stubFeed(origin, { port: Number(readFileSync(feedPort, "utf8")) })
  const child = Bun.spawn(["sh", "-c", script!], { cwd, env: worldEnv(), stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  feed.stop()
  const status = child.exitCode ?? 128 + (constants.signals[child.signalCode as keyof typeof constants.signals] ?? 0)
  const requests = feed.requests.map(
    (r) => `${r.method} ${r.path}${r.credential === null ? "" : "  (with a credential)"}\n`,
  )
  save(dir!, script!, { status, out, err }, `--- feed requests\n${requests.join("")}`)
}

const doctor = () => {
  needWorld()
  const record = JSON.parse(readFileSync(built, "utf8")) as { version: string; sources: string }
  const problems: string[] = []
  const check = (name: string, good: boolean, why: string) => {
    console.log(`${good ? "ok  " : "FAIL"} ${name}${good ? "" : `: ${why}`}`)
    if (!good) problems.push(name)
  }

  const version = sh(world, "land --version")
  check(
    "land answers",
    version.out.trim() === `land ${record.version}`,
    `land --version printed ${JSON.stringify(version.out + version.err)}`,
  )
  check(
    "land on the PATH is this run's copy",
    sh(world, "command -v land").out.trim() === join(world, "bin", "land"),
    "another land comes first on the PATH",
  )
  check(
    "land was built from the checkout as it is now",
    sources() === record.sources,
    `the sources changed after up; start a new run under another id`,
  )
  check(
    "the git identity is the world's",
    sh(world, "git config --global user.email").out.trim() === identity,
    "the global git identity is not the world's",
  )
  for (const name of readdirSync(world)) {
    if (!existsSync(join(world, name, ".git"))) continue
    const urls = sh(join(world, name), "git remote get-url origin; git remote get-url --push origin").out
    check(
      `${name} pushes to the world's origin`,
      urls === `${origin}\n${origin}\n`,
      `its origin is ${JSON.stringify(urls)}`,
    )
  }
  if (problems.length > 0) process.exit(1)
  console.log("ok")
}

const down = () => {
  rmSync(world, { recursive: true, force: true })
  console.log(`removed ${world}`)
  if (existsSync(evidence)) console.log(`kept ${evidence} (${readdirSync(evidence).length} files)`)
}

switch (command) {
  case "up":
    up()
    break
  case "clone":
    needWorld()
    if (rest[0] === undefined) fail("clone takes a name")
    clone(rest[0])
    console.log(`${rest[0]}: a clone of origin, on main`)
    break
  case "do":
    drive(rest[0], rest[1], rest.length - 2)
    break
  case "feed":
    await driveWithFeed(rest[0], rest[1], rest.length - 2)
    break
  case "doctor":
    doctor()
    break
  case "down":
    down()
    break
  default:
    process.stderr.write(usage)
    process.exit(2)
}
