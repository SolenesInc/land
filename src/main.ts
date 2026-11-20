import { Cause, Effect, Exit } from "effect"
import type { LandFailed } from "./failure.ts"
import guide from "./guide.md" with { type: "text" }
import reviewGuide from "./guide-review.md" with { type: "text" }
import sheriffGuide from "./guide-sheriff.md" with { type: "text" }
import { init } from "./init.ts"
import { land } from "./landing.ts"
import { record } from "./record.ts"
import { version } from "../package.json"

const help = `land lands finished commits on main: it rebases onto origin/main, runs the
gate that land.toml names, and pushes main with the landing ref, refs/landings/<head>.

Usage:
  land                 land the commits of the current branch, with the note in
                       .land/note.md when there is one
  land --note <file>   land them with the note in <file>
  land init            adopt land in this repository: write land.toml and the trunk declaration
  land record [args]   run the record command, and print a markdown line for each recording it made
  land guide           print the procedure for landing a change
  land guide review    print the procedure for reviewing what landed on main
  land guide sheriff   print the procedure for getting main's CI green
  land --help          print this help
  land --version       print land's version

The note is markdown for the readers of main. The landing ref's commit holds it,
beside landing.json, and land deletes the note file after the push.

land.toml, at the repository root:
  gate = "bun run check"   a shell command; land pushes only when it exits 0
  main = "main"            the branch to land on; "main" when absent
  record = "<command>"     a shell command that writes recordings into $LAND_MEDIA, which is
                           .land/media/; land record runs it at the repository root with its
                           arguments appended
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
  if (args[0] === "record") return report(record(args.slice(1)))
  if (args.length === 2 && args[0] === "--note") return report(land({ note: args[1] }))
  switch (args.join(" ")) {
    case "":
      return report(land({}))
    case "init":
      return report(init)
    case "guide":
      process.stdout.write(guide)
      return 0
    case "guide review":
      process.stdout.write(reviewGuide)
      return 0
    case "guide sheriff":
      process.stdout.write(sheriffGuide)
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
