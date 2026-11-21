import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { githubRepository, notify, originUrl, type Failure } from "./feed.ts"
import { git, gitOk, gitWith, run } from "./git.ts"
import { keepEvent } from "./outbox.ts"
import { Event } from "./schema.ts"

export const usage = `land event <sha> --kind <kind> --state pass|fail|run|info --title <title>
           [--url <url>] [--detail-file <file>] [--repairs <sha>]`

const flags = ["kind", "state", "title", "url", "detail-file", "repairs"] as const
type Flag = (typeof flags)[number]

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sha, ...rest] = args
    const given: Partial<Record<Flag, string>> = {}
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i]!.replace(/^--/, "") as Flag
      const value = rest[i + 1]
      if (!rest[i]!.startsWith("--") || !flags.includes(flag) || value === undefined || flag in given) {
        return yield* new LandFailed({ message: `event: unexpected ${rest[i]}\nUsage: ${usage}`, status: 2 })
      }
      given[flag] = value
    }
    if (sha === undefined || sha.startsWith("--") || !given.kind || !given.state || !given.title) {
      return yield* new LandFailed({
        message: `event: name the landing, --kind, --state and --title\nUsage: ${usage}`,
        status: 2,
      })
    }
    return { sha, given }
  })

// D27: an event is a commit with no parent whose tree holds event.json. land pushes it to
// refs/land-events/<landing sha>/<event commit sha>, then tells the feed, which reads the ref.
export const event = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { sha, given } = yield* parse(args)
    const root = yield* gitOk("rev-parse", "--show-toplevel")
    const { feed } = yield* readDeclaration(root)
    if (feed === undefined) {
      return yield* new LandFailed({
        message: `land.toml names no feed to send the event to; add\n  feed = "https://land-feed.caketroll.cloud"`,
      })
    }
    const at = yield* githubRepository
    if (at === undefined) {
      return yield* new LandFailed({
        message: `the feed takes events of GitHub repositories only; origin is ${yield* originUrl}`,
      })
    }
    // A runner may not hold the landing, so a full sha needs no lookup.
    const landing = /^[0-9a-f]{40}$/.test(sha)
      ? sha
      : (yield* git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`)).out
    if (landing === "")
      return yield* new LandFailed({ message: `event: no commit ${sha}; name the landing by its full sha` })

    const detail =
      given["detail-file"] === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => readFile(given["detail-file"]!, "utf8"),
            catch: () => new LandFailed({ message: `--detail-file ${given["detail-file"]}: no such file` }),
          })
    const now = new Date().toISOString()
    const body = yield* Schema.decodeUnknownEffect(Event)({
      kind: given.kind,
      state: given.state,
      title: given.title,
      at: now,
      ...(given.url === undefined ? {} : { url: given.url }),
      ...(detail === undefined ? {} : { detail }),
      ...(given.repairs === undefined ? {} : { repairs: given.repairs }),
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `event: ${error.message}`, status: 2 })))

    const blob = yield* gitWith(`${JSON.stringify(body, null, 2)}\n`, "hash-object", "-w", "--stdin")
    const tree = yield* gitWith(`100644 blob ${blob}\tevent.json\n`, "mktree")
    // Dated by the event, so the same event makes the same commit.
    const made = yield* run(["git", "commit-tree", tree, "-m", `Event ${body.kind} for ${landing}`], {
      GIT_AUTHOR_DATE: now,
      GIT_COMMITTER_DATE: now,
    })
    if (made.status !== 0) return yield* new LandFailed({ message: `git commit-tree: ${made.err}` })
    const id = made.out
    const ref = `refs/land-events/${landing}/${id}`
    const url = yield* gitOk("remote", "get-url", "--push", "origin")
    const pushed = yield* git("push", "--quiet", url, `${id}:${ref}`)
    if (pushed.status !== 0) return yield* new LandFailed({ message: `git push ${ref} failed:\n${pushed.err}` })

    const failure = yield* notify({ feed, at, sha: landing, id }).pipe(
      Effect.as(undefined),
      Effect.catch((failure: Failure) => Effect.succeed(failure)),
    )
    if (failure === undefined) return console.log(`land: event  ${ref} pushed; the feed has it`)
    if (failure.kind === "refused") {
      return console.log(
        `land: event  ${ref} pushed; the feed refused the notice: ${failure.why}; is the Attn Land App installed on ${at.owner}/${at.repo}?`,
      )
    }
    const kept = yield* keepEvent({ feed, at, sha: landing, id }).pipe(
      Effect.as(`the notice waits in the outbox: ${failure.why}`),
      Effect.catch((why: string) => Effect.succeed(`the notice is not sent: ${failure.why}, and ${why}`)),
    )
    console.log(`land: event  ${ref} pushed; ${kept}`)
  })
