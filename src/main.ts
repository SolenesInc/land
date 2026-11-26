import { Cause, Effect, Exit } from "effect"
import { auth } from "./auth.ts"
import { bug, bugs } from "./bug.ts"
import { event } from "./event.ts"
import { evidence } from "./evidence.ts"
import type { LandFailed } from "./failure.ts"
import guide from "./guide.md" with { type: "text" }
import reviewGuide from "./guide-review.md" with { type: "text" }
import sheriffGuide from "./guide-sheriff.md" with { type: "text" }
import { init } from "./init.ts"
import { land } from "./landing.ts"
import { record } from "./record.ts"
import { brief, comments, review, show } from "./review.ts"
import { normalizeBugId } from "./schema.ts"
import { version } from "../package.json"

const help = `land lands finished commits on main: it rebases onto origin/main, runs the
gate that land.toml names, and pushes main with the landing ref, refs/landings/<head>.

Landing:
  land                 land the commits of the current branch, with the note in
                       .land/note.md when there is one
  land --note <file>   land them with the note in <file>
  land --media <file>  attach a local image, GIF, or video to the landing note
                       (repeatable; any png, jpg, jpeg, gif, webp, mp4, or webm)
  land --no-media <reason>
                       land without media when visual paths changed or unlinked
                       media exists; recorded in landing.json
  land --fixes <id>    mark registered bug <id> fixed by this landing (repeatable;
                       Fixes-Bug: <id> commit trailers are collected automatically)
  land --ack-flake <test> --owner <ref>
                       re-run after a gate failure on an unchanged diff once the
                       flake is diagnosed and tracked by <ref> (or fixed on main)
  land init            adopt land in this repository: write land.toml and the trunk declaration
  land record [args]   run the record command, and print a markdown line for each recording it made

Review, feed & bugs:
  land evidence <sha> <file>... [-m <text> | --detail-file <file>] [--title <title>]
                       attach verification media (images, GIFs, videos) to an already-landed commit
  land show <sha|url>  fetch the markdown review bundle (note, comments, bugs) from the feed
  land comments [<sha|url>] [--open] [--json]
                       list human review comments for a landing or the repository
  land comments resolve <id> [--by <sha>]
                       mark a review comment resolved
  land review check <file> [--base <sha>] [--head <sha>]
                       validate a review document (stops, line ranges, diagrams, file coverage)
  land brief <sha> <file> [--base <sha>] [--no-check]
                       validate and push a review document to refs/land-events/ for the feed
  land event <sha> --kind <kind> --state pass|fail|run|info --title <title>
             [--url <url>] [--detail-file <file>] [--media <file>]... [--repairs <sha>]
                       push an event about the landing <sha> to refs/land-events/, and tell the feed
  land bug <sha> --title <title> [--severity p0|p1|p2] [--source agent|review|ci|prod|human]
           [--location <path[:line]>] [--detail-file <file>] [--fixed-by <sha>] [--url <url>]
                       register a bug attributed to commit <sha> and print its short id
  land bug resolve <id> --by <fix-sha> [--title <title>]
                       mark an existing registered bug fixed by an already-landed commit
  land bugs [--open] [--since <Nd|ISO>] [--path <prefix>] [--severity p0|p1|p2] [--json]
                       list bugs registered for this repository on the feed
  land auth token <token|-> | status | logout
                       manage the land-feed API token (~/.config/land/token or LAND_FEED_TOKEN)

Guides & info:
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
  gate = "bun run check"          a shell command; land pushes only when it exits 0
  main = "main"                   the branch to land on; "main" when absent
  resolve = "<command>"           a shell command run on rebase conflicts; exit 0 stages the fix and continues
  feed = "<url>"                  the feed that shows landings and hosts their recordings
  record = "<command>"            a shell command that writes recordings into $LAND_MEDIA (.land/media/);
                                  land record runs it at the repository root with its arguments appended
  visual_paths = ["src/ui/**"]    path globs that require media (or --no-media "<reason>") when changed
  evidence_check = "<command>"    a shell command run before the gate to verify or suggest evidence
  require_note = true             refuse to land without a note (or --media)
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

type ParsedLandArgs =
  | { readonly kind: "ok"; readonly options: Parameters<typeof land>[0] }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unknown" }

const missingValue = (value: string | undefined) => value === undefined || value.trim() === "" || value.startsWith("-")

const parseLandArgs = (args: ReadonlyArray<string>): ParsedLandArgs => {
  let note: string | undefined
  let noMedia: string | undefined
  let ackFlake: string | undefined
  let owner: string | undefined
  const media: string[] = []
  const fixes: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === "--note") {
      if (note !== undefined) return { kind: "error", message: "--note may only be passed once" }
      if (next === undefined || next === "" || next.startsWith("-"))
        return { kind: "error", message: "--note requires a file path" }
      note = next
      i += 1
    } else if (arg === "--media") {
      if (missingValue(next)) return { kind: "error", message: "--media requires a file path" }
      media.push(next!)
      i += 1
    } else if (arg === "--no-media") {
      if (noMedia !== undefined) return { kind: "error", message: "--no-media may only be passed once" }
      if (next === undefined || next.trim() === "") return { kind: "error", message: "--no-media requires a reason" }
      noMedia = next.trim()
      i += 1
    } else if (arg === "--fixes") {
      if (missingValue(next)) return { kind: "error", message: "--fixes requires a bug id" }
      const normalized = normalizeBugId(next!)
      if (normalized === undefined) {
        return { kind: "error", message: `--fixes: bad bug id ${next}; expected 7-40 hex characters` }
      }
      if (!fixes.includes(normalized)) fixes.push(normalized)
      i += 1
    } else if (arg === "--ack-flake") {
      if (ackFlake !== undefined) return { kind: "error", message: "--ack-flake may only be passed once" }
      if (missingValue(next)) return { kind: "error", message: "--ack-flake requires a test name" }
      ackFlake = next!.trim()
      i += 1
    } else if (arg === "--owner") {
      if (owner !== undefined) return { kind: "error", message: "--owner may only be passed once" }
      if (missingValue(next))
        return { kind: "error", message: "--owner requires a tracking seed, issue, or fix commit" }
      owner = next!.trim()
      i += 1
    } else {
      return { kind: "unknown" }
    }
  }
  if (noMedia !== undefined && media.length > 0) {
    return { kind: "error", message: "--no-media cannot be combined with --media" }
  }
  if (ackFlake !== undefined && owner === undefined) {
    return { kind: "error", message: "--ack-flake requires --owner <seed-issue-or-sha>" }
  }
  if (owner !== undefined && ackFlake === undefined) {
    return { kind: "error", message: "--owner requires --ack-flake <test>" }
  }
  return {
    kind: "ok",
    options: {
      ...(note === undefined ? {} : { note }),
      ...(media.length === 0 ? {} : { media }),
      ...(noMedia === undefined ? {} : { noMedia }),
      ...(ackFlake !== undefined && owner !== undefined ? { ackFlake: { test: ackFlake, owner } } : {}),
      ...(fixes.length === 0 ? {} : { fixes }),
    },
  }
}

const main = async (args: ReadonlyArray<string>) => {
  if (args[0] === "record") return report(record(args.slice(1)))
  if (args[0] === "evidence") return report(evidence(args.slice(1)))
  if (args[0] === "event") return report(event(args.slice(1)))
  if (args[0] === "bug") return report(bug(args.slice(1)))
  if (args[0] === "bugs") return report(bugs(args.slice(1)))
  if (args[0] === "show") return report(show(args.slice(1)))
  if (args[0] === "comments") return report(comments(args.slice(1)))
  if (args[0] === "review") return report(review(args.slice(1)))
  if (args[0] === "brief") return report(brief(args.slice(1)))
  if (args[0] === "auth") return report(auth(args.slice(1)))
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
    default: {
      const parsed = parseLandArgs(args)
      if (parsed.kind === "ok") return report(land(parsed.options))
      if (parsed.kind === "error") {
        process.stderr.write(`land: ${parsed.message}\n`)
        return 2
      }
      process.stderr.write(`land: unknown arguments: ${args.join(" ")}\n\n${help}`)
      return 2
    }
  }
}

process.exit(await main(process.argv.slice(2)))
