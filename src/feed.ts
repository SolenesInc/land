import { Effect } from "effect"
import { git } from "./git.ts"

// The feed's HTTP surface as land uses it. land sends no credential: the landing ref, or the
// event ref, on GitHub authorizes each request, and the feed reads it before it answers.

export type Repository = { readonly owner: string; readonly repo: string }

// The GitHub repository origin names, from the URL as configured, before any insteadOf.
export const githubRepository = Effect.gen(function* () {
  const { out } = yield* git("config", "--get", "remote.origin.url")
  const found = out.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return found === null ? undefined : ({ owner: found[1]!, repo: found[2]! } satisfies Repository)
})

export const originUrl = Effect.map(git("config", "--get", "remote.origin.url"), ({ out }) => out)

// D25: the address a note links a recording by, whether or not the feed holds it yet.
export const recordingAddress = (feed: string, at: Repository, sha256: string, ext: string) =>
  `${trim(feed)}/m/${at.owner}/${at.repo}/${sha256}.${ext}`

export const landingAddress = (feed: string, at: Repository, head: string) =>
  `${trim(feed)}/${at.owner}/${at.repo}/${head.slice(0, 7)}`

const trim = (feed: string) => feed.replace(/\/+$/, "")

// Tripwires. Receipts, 2026-11-21, from Victor's Mac: a POST to the live feed that reads a ref
// on GitHub answered in 0.37 to 0.59 s, so a call gets 30 s. A 3.66 MB PUT to the feed's R2
// bucket took about 1 s (2026-11-21), and 18.4 MB, the largest recording measured (F36),
// reached Cloudflare's edge in 2.6 to 3.1 s; a PUT gets 10 minutes, which still carries the
// 200 MB tripwire over a 2.7 Mbit/s uplink.
const callTimeout = 30_000
const putTimeout = 600_000

// Why a request did not do its job, in words for the lander. A feed that is unreachable gets no
// more requests this run, so a hanging feed costs one timeout. One that refuses, 404, does not
// list the file or the event, and asking again will not change that.
export type Failure = { readonly why: string; readonly kind: "unreachable" | "refused" | "failed" }

const unreachable = (error: unknown, ms: number): Failure => ({
  kind: "unreachable",
  why:
    error instanceof DOMException && error.name === "TimeoutError"
      ? `no answer in ${ms / 1000}s`
      : "the feed did not answer",
})

const call = (url: string, init: RequestInit, ms = callTimeout) =>
  Effect.tryPromise({
    try: () => fetch(url, { ...init, signal: AbortSignal.timeout(ms) }),
    catch: (error) => unreachable(error, ms),
  })

const answered = (response: Response, who: string): Failure => ({
  kind: response.status === 404 ? "refused" : "failed",
  why: `${who} answered ${response.status}`,
})
const failed = (why: string): Failure => ({ kind: "failed", why })

export type Upload = {
  readonly feed: string
  readonly at: Repository
  readonly head: string // the landing whose ref lists the recording
  readonly sha256: string
  readonly path: string // the bytes
}

// D23: ask the feed for a PUT, send the bytes to it, then tell the feed. Succeeds with what the
// feed holds now; fails with why the recording is not uploaded.
export const upload = (u: Upload) =>
  Effect.gen(function* () {
    const api = `${trim(u.feed)}/api/media/${u.at.owner}/${u.at.repo}/${u.head}/${u.sha256}`
    const asked = yield* call(api, { method: "POST" })
    if (!asked.ok) return yield* Effect.fail(answered(asked, "the feed"))
    const answer = (yield* Effect.tryPromise({
      try: () => asked.json(),
      catch: () => failed("the feed answered with no JSON"),
    })) as { put?: { url: string; headers: Record<string, string> }; present?: boolean; removed?: boolean } | null
    if (answer?.removed === true) return "removed" as const
    if (answer?.present === true) return "present" as const
    if (typeof answer?.put?.url !== "string") return yield* Effect.fail(failed("the feed answered with no PUT"))

    const put = yield* call(
      answer.put.url,
      { method: "PUT", headers: answer.put.headers, body: Bun.file(u.path) },
      putTimeout,
    )
    if (!put.ok) return yield* Effect.fail(failed(`the storage answered ${put.status}`))
    const told = yield* call(`${api}/uploaded`, { method: "POST" })
    if (told.status === 410) return "removed" as const
    if (!told.ok) return yield* Effect.fail(answered(told, "the feed"))
    return "uploaded" as const
  })

export type Notice = { readonly feed: string; readonly at: Repository; readonly sha: string; readonly id: string }

// D27: tell the feed an event ref exists. The feed reads the ref before it stores anything.
export const notify = (n: Notice) =>
  Effect.gen(function* () {
    const told = yield* call(`${trim(n.feed)}/api/landings/${n.at.owner}/${n.at.repo}/${n.sha}/events/${n.id}`, {
      method: "POST",
    })
    if (!told.ok) return yield* Effect.fail(answered(told, "the feed"))
  })
