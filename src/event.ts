import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { githubRepository, notify, originUrl, type Failure, type Repository } from "./feed.ts"
import { git, gitOk, gitWith, run } from "./git.ts"
import { listed, readMediaBundle, uploadRecordings } from "./media.ts"
import { keepEvent } from "./outbox.ts"
import { Event } from "./schema.ts"

export const usage = `land event <sha> --kind <kind> --state pass|fail|run|info --title <title>
           [--url <url>] [--detail-file <file>] [--media <file>]... [--repairs <sha>]`

const flags = ["kind", "state", "title", "url", "detail-file", "repairs"] as const
type Flag = (typeof flags)[number]

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sha, ...rest] = args
    const given: Partial<Record<Flag, string>> = {}
    const media: string[] = []
    for (let i = 0; i < rest.length; i += 2) {
      const arg = rest[i]!
      const value = rest[i + 1]
      if (arg === "--media") {
        if (value === undefined || value.trim() === "" || value.startsWith("-")) {
          return yield* new LandFailed({ message: `event: --media requires a file path\nUsage: ${usage}`, status: 2 })
        }
        media.push(value)
        continue
      }
      const flag = arg.replace(/^--/, "") as Flag
      if (!arg.startsWith("--") || !flags.includes(flag) || value === undefined || flag in given) {
        return yield* new LandFailed({ message: `event: unexpected ${arg}\nUsage: ${usage}`, status: 2 })
      }
      given[flag] = value
    }
    if (sha === undefined || sha.startsWith("--") || !given.kind || !given.state || !given.title) {
      return yield* new LandFailed({
        message: `event: name the landing, --kind, --state and --title\nUsage: ${usage}`,
        status: 2,
      })
    }
    return { sha, given, media }
  })

export const feedContext = Effect.gen(function* () {
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
  return { root, feed, at }
})

export const resolveCommitSha = (sha: string, label = "event") =>
  Effect.gen(function* () {
    // A runner may not hold the landing, so a full sha needs no lookup.
    const resolved = /^[0-9a-f]{40}$/.test(sha)
      ? sha
      : (yield* git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`)).out
    if (resolved === "")
      return yield* new LandFailed({ message: `${label}: no commit ${sha}; name the landing by its full sha` })
    return resolved
  })

export const pushEvent = (opts: {
  readonly feed: string
  readonly at: Repository
  readonly landing: string
  readonly body: Event
  readonly label?: string
}) =>
  Effect.gen(function* () {
    const label = opts.label ?? "event"
    const blob = yield* gitWith(`${JSON.stringify(opts.body, null, 2)}\n`, "hash-object", "-w", "--stdin")
    const tree = yield* gitWith(`100644 blob ${blob}\tevent.json\n`, "mktree")
    // Dated by the event, so the same event makes the same commit.
    const made = yield* run(["git", "commit-tree", tree, "-m", `Event ${opts.body.kind} for ${opts.landing}`], {
      GIT_AUTHOR_DATE: opts.body.at,
      GIT_COMMITTER_DATE: opts.body.at,
    })
    if (made.status !== 0) return yield* new LandFailed({ message: `git commit-tree: ${made.err}` })
    const id = made.out
    const ref = `refs/land-events/${opts.landing}/${id}`
    const url = yield* gitOk("remote", "get-url", "--push", "origin")
    const pushed = yield* git("push", "--quiet", url, `${id}:${ref}`)
    if (pushed.status !== 0) return yield* new LandFailed({ message: `git push ${ref} failed:\n${pushed.err}` })

    const failure = yield* notify({ feed: opts.feed, at: opts.at, sha: opts.landing, id }).pipe(
      Effect.as(undefined),
      Effect.catch((failure: Failure) => Effect.succeed(failure)),
    )
    const pad = label.padEnd(6, " ")
    if (failure === undefined) {
      console.log(`land: ${pad} ${ref} pushed; the feed has it`)
      return { id, ref }
    }
    if (failure.kind === "refused") {
      console.log(
        `land: ${pad} ${ref} pushed; the feed refused the notice: ${failure.why}; is the Attn Land App installed on ${opts.at.owner}/${opts.at.repo}?`,
      )
      return { id, ref }
    }
    const kept = yield* keepEvent({ feed: opts.feed, at: opts.at, sha: opts.landing, id }).pipe(
      Effect.as(`the notice waits in the outbox: ${failure.why}`),
      Effect.catch((why: string) => Effect.succeed(`the notice is not sent: ${failure.why}, and ${why}`)),
    )
    console.log(`land: ${pad} ${ref} pushed; ${kept}`)
    return { id, ref, ...(failure.kind === "unreachable" ? { unreachable: failure } : {}) }
  })

// D27: an event is a commit with no parent whose tree holds event.json. land pushes it to
// refs/land-events/<landing sha>/<event commit sha>, then tells the feed, which reads the ref.
export const event = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { sha, given, media } = yield* parse(args)
    const { root, feed, at } = yield* feedContext
    const landing = yield* resolveCommitSha(sha, "event")

    const detailRaw =
      given["detail-file"] === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => readFile(given["detail-file"]!, "utf8"),
            catch: () => new LandFailed({ message: `--detail-file ${given["detail-file"]}: no such file` }),
          })
    const bundle = yield* readMediaBundle({
      root,
      cwd: process.cwd(),
      text: detailRaw,
      noteLabel: given["detail-file"] === undefined ? "event detail" : `--detail-file ${given["detail-file"]}`,
      extraFiles: media,
      extraLabel: "--media",
      feed,
      pushContext: false,
    })
    const now = new Date().toISOString()
    const body = yield* Schema.decodeUnknownEffect(Event)({
      kind: given.kind,
      state: given.state,
      title: given.title,
      at: now,
      ...(given.url === undefined ? {} : { url: given.url }),
      ...(bundle.text === undefined ? {} : { detail: bundle.text }),
      ...(given.repairs === undefined ? {} : { repairs: given.repairs }),
      ...(bundle.recordings.length === 0 ? {} : { recordings: listed(bundle.recordings) }),
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `event: ${error.message}`, status: 2 })))

    const pushed = yield* pushEvent({ feed, at, landing, body, label: "event" })
    if (bundle.recordings.length > 0) {
      yield* uploadRecordings(root, feed, at, landing, bundle.recordings, pushed.id, pushed.unreachable)
    }
  })
