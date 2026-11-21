import { existsSync, readFileSync } from "node:fs"
import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { file as declarationFile, readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { git, gitOk } from "./git.ts"
import { installHooks } from "./landing.ts"

// A gate land can propose, and where it found it.
type Proposal = { readonly gate: string; readonly from: string }

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

const packageRunner = (root: string) => {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun"
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(root, "yarn.lock"))) return "yarn"
  return "npm"
}

type Scripts = Record<string, unknown>

// The scripts of package.json, parsed here so a broken file stops init with its name.
const packageScripts = (root: string) =>
  Effect.try({
    try: (): Scripts => {
      const text = read(join(root, "package.json"))
      if (text === undefined) return {}
      const scripts = JSON.parse(text.replace(/^\uFEFF/, ""))?.scripts
      return typeof scripts === "object" && scripts !== null ? scripts : {}
    },
    catch: (error) => new LandFailed({ message: `package.json: ${String(error)}` }),
  })

// What npm init writes as the test script. It always fails, so it is no gate.
const npmPlaceholder = "Error: no test specified"

// The first match wins: a check the repository already names beats its tests, and its
// tests beat a language's default.
const proposeGate = (root: string, scripts: Scripts): Proposal | undefined => {
  const makefile = read(join(root, "Makefile"))
  // A target line, not a variable assignment such as check := x.
  const target = (name: string) => makefile !== undefined && new RegExp(`^${name}:(?!=)`, "m").test(makefile)
  const runner = packageRunner(root)

  if (typeof scripts.check === "string")
    return { gate: `${runner} run check`, from: "the check script in package.json" }
  if (target("check")) return { gate: "make check", from: "the check target in the Makefile" }
  if (typeof scripts.test === "string" && !scripts.test.includes(npmPlaceholder))
    return { gate: `${runner} run test`, from: "the test script in package.json" }
  if (target("test")) return { gate: "make test", from: "the test target in the Makefile" }
  if (existsSync(join(root, "go.mod"))) return { gate: "go test ./...", from: "go.mod" }
  if (existsSync(join(root, "Cargo.toml"))) return { gate: "cargo test", from: "Cargo.toml" }
  return undefined
}

// The branch origin's HEAD names, which is where a clone lands; "main" when origin names none.
const defaultBranch = Effect.gen(function* () {
  const head = yield* git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
  return head.status === 0 && head.out.startsWith("origin/") ? head.out.slice("origin/".length) : "main"
})

const trunkDeclaration = (main: string) =>
  `This repository lands on \`${main}\` with \`land\`, with no pull request.
Before you land a change, run \`land guide\` and follow it.
`

// The guidance files agents read. The first that exists gets the declaration.
const guidanceFiles = ["AGENTS.md", "CLAUDE.md"]

// D29: a repository joins the feed with the feed key and the App installed on it.
const feed = "https://land-feed.caketroll.cloud"
const appInstall = "https://github.com/apps/attn-land/installations/new"

const say = (subject: string, line: string) => console.log(`land: ${subject.padEnd(10)} ${line}`)

export const init = Effect.gen(function* () {
  const root = yield* gitOk("rev-parse", "--show-toplevel")
  const written: string[] = []
  const decide: string[] = []

  let main: string
  if (existsSync(join(root, declarationFile))) {
    const declaration = yield* readDeclaration(root)
    main = declaration.main ?? "main"
    say(declarationFile, "exists, so land left it as it is")
    if (declaration.feed === undefined) {
      decide.push(
        `Whether landings show in the feed. To join it, add feed = ${JSON.stringify(feed)} to ${declarationFile}, and install the App: ${appInstall}`,
      )
    }
  } else {
    main = yield* defaultBranch
    const proposal = proposeGate(root, yield* packageScripts(root))
    if (proposal === undefined) {
      say(declarationFile, "not written: land found no check to propose as the gate")
      const branch = main === "main" ? "" : `, and main = ${JSON.stringify(main)} on a line of its own`
      decide.push(
        `Which command must pass before every push. Write it in ${declarationFile} as gate = "<command>"${branch}, with feed = ${JSON.stringify(feed)} so landings show in the feed once the App is installed: ${appInstall}`,
      )
    } else {
      const branch = main === "main" ? "" : `main = ${JSON.stringify(main)}\n`
      yield* Effect.promise(() =>
        writeFile(
          join(root, declarationFile),
          `gate = ${JSON.stringify(proposal.gate)}\n${branch}feed = ${JSON.stringify(feed)}\n`,
        ),
      )
      written.push(declarationFile)
      say(declarationFile, `wrote gate = ${JSON.stringify(proposal.gate)}, from ${proposal.from}`)
      if (branch !== "") say(declarationFile, `wrote main = ${JSON.stringify(main)}, the branch origin/HEAD names`)
      say(declarationFile, `wrote feed = ${JSON.stringify(feed)}, where landings show`)
      decide.push(
        `Whether ${proposal.gate} should run before every push. It holds every landing until it passes, so name a faster check in ${declarationFile} if it is slow, and leave the rest to CI.`,
      )
    }
  }

  // "`land guide`" is the one phrase every trunk declaration holds, however its lines wrap.
  const declaredIn = guidanceFiles.find((name) => read(join(root, name))?.includes("`land guide`"))
  if (declaredIn !== undefined) {
    say(declaredIn, "already declares that the repository lands with land")
  } else {
    const target = guidanceFiles.find((name) => existsSync(join(root, name))) ?? guidanceFiles[0]!
    const existing = read(join(root, target))
    if (existing === undefined) {
      yield* Effect.promise(() => writeFile(join(root, target), trunkDeclaration(main)))
      say(target, "created with the trunk declaration")
    } else {
      const separator = existing === "" || existing.endsWith("\n") ? "" : "\n"
      yield* Effect.promise(() =>
        appendFile(join(root, target), `${separator}\n## Landing\n\n${trunkDeclaration(main)}`),
      )
      say(target, "added the trunk declaration under ## Landing")
    }
    written.push(target)
  }

  // Install the hooks now, so commits made before the first land carry attn trailers too.
  const installed = yield* installHooks(main)
  if (installed.length > 0) say("hooks", `installed ${installed.join(" and ")}`)

  if (decide.length > 0) {
    console.log(`\nDecide:\n${decide.map((line) => `  - ${line}`).join("\n")}`)
  }
  if (written.includes(declarationFile)) {
    console.log(`\nInstall the App on the repository, so the feed shows its landings: ${appInstall}`)
  }
  if (written.length > 0) {
    console.log(`\nThen commit ${written.join(" and ")}, and land the commit with land.`)
  } else if (decide.length === 0 && installed.length === 0) {
    console.log("\nNothing changed.")
  }
})
