import { Cause, Effect, Exit } from "effect"
import type { LandFailed } from "./failure.ts"
import guide from "./guide.md" with { type: "text" }
import { init } from "./init.ts"
import { land } from "./landing.ts"
import { version } from "../package.json"

const help = `land lands finished commits on main: it rebases onto origin/main, runs the
gate that land.toml names, and pushes.

Usage:
  land             land the commits of the current branch
  land init        adopt land in this repository: write land.toml and the trunk declaration
  land guide       print the procedure for landing a change
  land --help      print this help
  land --version   print land's version

land.toml, at the repository root:
  gate = "bun run check"   a shell command; land pushes only when it exits 0
  main = "main"            the branch to land on; "main" when absent
`

const report = async (command: Effect.Effect<void, LandFailed>) => {
  const exit = await Effect.runPromiseExit(command)
  if (Exit.isSuccess(exit)) return 0
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure === undefined) {
    console.error(`land: ${Cause.pretty(exit.cause)}`)
    return 1
  }
  console.error(`land: ${failure.error.message}`)
  return failure.error.status ?? 1
}

const main = async (args: ReadonlyArray<string>) => {
  switch (args.join(" ")) {
    case "":
      return report(land)
    case "init":
      return report(init)
    case "guide":
      process.stdout.write(guide)
      return 0
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(help)
      return 0
    case "--version":
      console.log(`land ${version}`)
      return 0
    default:
      process.stderr.write(`land: unknown arguments: ${args.join(" ")}\n\n${help}`)
      return 2
  }
}

process.exit(await main(process.argv.slice(2)))
