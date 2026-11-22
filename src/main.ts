import { Cause, Effect, Exit } from "effect"
import { auth } from "./auth.ts"
import { bug, bugs } from "./bug.ts"
import { event } from "./event.ts"
import type { LandFailed } from "./failure.ts"
import guide from "./guide.md" with { type: "text" }
import reviewGuide from "./guide-review.md" with { type: "text" }
import sheriffGuide from "./guide-sheriff.md" with { type: "text" }
import { init } from "./init.ts"
import { land } from "./landing.ts"
import { record } from "./record.ts"
import { brief, comments, review, show } from "./review.ts"
import { version } from "../package.json"

const help = `land lands finished commits on main: it rebases onto origin/main, runs the
gate that land.toml names, and pushes main with the landing ref, refs/landings/<head>.

Usage:
  land                 land the commits of the current branch, with the note in
                       .land/note.md when there is one
  land --note <file>   land them with the note in <file>
  land init            adopt land in this repository: write land.toml and the trunk declaration
  land record [args]   run the record command, and print a markdown line for each recording it made
  land event <sha> --kind <kind> --state pass|fail|run|info --title <title>
             [--url <url>] [--detail-file <file>] [--repairs <sha>]
                       push an event about the landing <sha> to refs/land-events/, and tell the feed
  land bug <sha> --title <title> [--severity p0|p1|p2] [--source agent|review|ci|prod|human]
           [--location <path[:line]>] [--detail-file <file>] [--fixed-by <sha>] [--url <url>]
                       register a bug attributed to commit <sha>
  land bugs [--open] [--since <Nd|ISO>] [--path <prefix>] [--severity p0|p1|p2] [--json]
                       list bugs registered for this repository on the feed
  land show <sha|url>  fetch the LLM-ready markdown review bundle (note, comments, bugs) from the feed
  land comments [<sha|url>] [--open] [--json]
                       list human review comments for a landing or the repository
  land comments resolve <id> [--by <sha>]
                       mark a review comment resolved
  land review check <file> [--base <sha>] [--head <sha>]
                       validate a review document (stops, line ranges, diagrams, file coverage)
  land brief <sha> <file> [--no-check]
                       validate and push a review document to refs/land-events/ for the feed
  land auth token <token|-> | status | logout
                       manage the land-feed API token (~/.config/land/token or LAND_FEED_TOKEN)
  land guide           print the procedure for landing a change
  land guide review    print the procedure for reviewing what landed on main
  land guide sheriff   print the procedure for getting main's CI green
  land --help          print this help
  land --version       print land's version

The note is markdown for the readers of main. The landing ref's commit holds it,
beside landing.json, and land deletes the note file after the push. A note that
links a local recording, such as .land/media/demo.mp4, links it by its feed address
instead, and land uploads it after the push. What land cannot send to the feed
waits in the outbox, $XDG_STATE_HOME/land/outbox, and every later land sends it.

land.toml, at the repository root:
  gate = "bun run check"   a shell command; land pushes only when it exits 0
  main = "main"            the branch to land on; "main" when absent
  feed = "<url>"           the feed that shows landings and hosts their recordings
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
  if (args[0] === "event") return report(event(args.slice(1)))
  if (args[0] === "bug") return report(bug(args.slice(1)))
  if (args[0] === "bugs") return report(bugs(args.slice(1)))
  if (args[0] === "show") return report(show(args.slice(1)))
  if (args[0] === "comments") return report(comments(args.slice(1)))
  if (args[0] === "review") return report(review(args.slice(1)))
  if (args[0] === "brief") return report(brief(args.slice(1)))
  if (args[0] === "auth") return report(auth(args.slice(1)))
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
