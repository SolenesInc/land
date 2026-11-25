import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { feedToken } from "./auth.ts"
import { feedContext, pushEvent, resolveCommitSha } from "./event.ts"
import { LandFailed } from "./failure.ts"
import { bugIdFromSource, BugSummary, Event, normalizeBugId, type CodeLocation } from "./schema.ts"

export const bugUsage = `land bug <culprit-sha> --title <title> [--severity p0|p1|p2]
         [--source agent|review|ci|prod|human] [--location <path[:line]>]
         [--detail-file <file>] [--fixed-by <sha>] [--url <url>]
land bug resolve <bug-id> --by <fix-sha> [--title <title>]`

export const bugsUsage = `land bugs [--open] [--since <Nd|ISO>] [--path <prefix>] [--severity p0|p1|p2] [--json]`

const bugFlags = ["title", "severity", "source", "location", "detail-file", "fixed-by", "url"] as const
type BugFlag = (typeof bugFlags)[number]

const resolveFlags = ["by", "title"] as const
type ResolveFlag = (typeof resolveFlags)[number]

const parseLocation = (raw: string): Effect.Effect<CodeLocation, LandFailed> => {
  const match = raw.match(/^(.+?)(?::(\d+))?$/)
  if (!match || !match[1]) {
    return Effect.fail(new LandFailed({ message: `bug: bad --location ${raw}; use path or path:line`, status: 2 }))
  }
  const line = match[2] ? Number.parseInt(match[2], 10) : undefined
  if (line !== undefined && line < 1) {
    return Effect.fail(new LandFailed({ message: `bug: --location line must be >= 1: ${raw}`, status: 2 }))
  }
  return Effect.succeed({ path: match[1], ...(line === undefined ? {} : { line }) })
}

const resolveBug = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [rawId, ...rest] = args
    const given: Partial<Record<ResolveFlag, string>> = {}
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i]!.replace(/^--/, "") as ResolveFlag
      const value = rest[i + 1]
      if (!rest[i]!.startsWith("--") || !resolveFlags.includes(flag) || value === undefined || flag in given) {
        return yield* new LandFailed({
          message: `bug resolve: unexpected ${rest[i]}\nUsage:\n  ${bugUsage}`,
          status: 2,
        })
      }
      given[flag] = value
    }
    if (rawId === undefined || rawId.startsWith("--") || !given.by) {
      return yield* new LandFailed({
        message: `bug resolve: name the bug id and --by <fix-sha>\nUsage:\n  ${bugUsage}`,
        status: 2,
      })
    }
    const bugId = normalizeBugId(rawId)
    if (bugId === undefined) {
      return yield* new LandFailed({
        message: `bug resolve: bad bug id ${rawId}; expected 7-40 hex characters`,
        status: 2,
      })
    }

    const { feed, at } = yield* feedContext
    const fixedBy = yield* resolveCommitSha(given.by, "bug resolve")
    const repair = yield* Schema.decodeUnknownEffect(Event)({
      kind: "repair",
      state: "pass",
      title: given.title ?? `Fixed bug ${bugId.slice(0, 7)}`,
      at: new Date().toISOString(),
      fixesBug: bugId,
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `bug resolve: ${error.message}`, status: 2 })))
    yield* pushEvent({ feed, at, landing: fixedBy, body: repair, label: "repair" })
  })

export const bug = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args[0] === "resolve") {
      return yield* resolveBug(args.slice(1))
    }
    const [sha, ...rest] = args
    const given: Partial<Record<BugFlag, string>> = {}
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i]!.replace(/^--/, "") as BugFlag
      const value = rest[i + 1]
      if (!rest[i]!.startsWith("--") || !bugFlags.includes(flag) || value === undefined || flag in given) {
        return yield* new LandFailed({ message: `bug: unexpected ${rest[i]}\nUsage:\n  ${bugUsage}`, status: 2 })
      }
      given[flag] = value
    }
    if (sha === undefined || sha.startsWith("--") || !given.title) {
      return yield* new LandFailed({
        message: `bug: name the culprit commit and --title\nUsage:\n  ${bugUsage}`,
        status: 2,
      })
    }

    const { feed, at } = yield* feedContext
    const culprit = yield* resolveCommitSha(sha, "bug")
    const fixedBy = given["fixed-by"] ? yield* resolveCommitSha(given["fixed-by"], "bug") : undefined
    const location = given.location ? yield* parseLocation(given.location) : undefined
    const detail =
      given["detail-file"] === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => readFile(given["detail-file"]!, "utf8"),
            catch: () => new LandFailed({ message: `--detail-file ${given["detail-file"]}: no such file` }),
          })

    const now = new Date().toISOString()
    const body = yield* Schema.decodeUnknownEffect(Event)({
      kind: "bug",
      state: "fail",
      title: given.title,
      at: now,
      severity: given.severity ?? "p1",
      source: given.source ?? "agent",
      culprit,
      ...(location === undefined ? {} : { location }),
      ...(given.url === undefined ? {} : { url: given.url }),
      ...(detail === undefined ? {} : { detail }),
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `bug: ${error.message}`, status: 2 })))

    const pushed = yield* pushEvent({ feed, at, landing: culprit, body, label: "bug" })
    console.log(`land: id     ${pushed.id.slice(0, 7)}`)

    if (fixedBy !== undefined) {
      const repair = yield* Schema.decodeUnknownEffect(Event)({
        kind: "repair",
        state: "pass",
        title: `Fixed: ${given.title}`,
        at: new Date().toISOString(),
        fixesBug: pushed.id,
      }).pipe(Effect.mapError((error) => new LandFailed({ message: `bug: ${error.message}`, status: 2 })))
      yield* pushEvent({ feed, at, landing: fixedBy, body: repair, label: "repair" })
    }
  })

const parseSince = (raw: string): Effect.Effect<string, LandFailed> => {
  const days = raw.match(/^(\d+)d$/)
  if (days) {
    const ms = Number.parseInt(days[1]!, 10) * 86_400_000
    return Effect.succeed(new Date(Date.now() - ms).toISOString())
  }
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) {
    return Effect.fail(new LandFailed({ message: `bugs: bad --since ${raw}; use e.g. 30d or ISO date`, status: 2 }))
  }
  return Effect.succeed(new Date(parsed).toISOString())
}

export const bugs = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let openOnly = false
    let asJson = false
    let since: string | undefined
    let pathPrefix: string | undefined
    let severity: string | undefined
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === "--open") {
        openOnly = true
      } else if (arg === "--json") {
        asJson = true
      } else if (arg === "--since" && args[i + 1]) {
        since = yield* parseSince(args[++i]!)
      } else if (arg === "--path" && args[i + 1]) {
        pathPrefix = args[++i]!
      } else if (arg === "--severity" && args[i + 1]) {
        severity = args[++i]!
        if (!["p0", "p1", "p2"].includes(severity)) {
          return yield* new LandFailed({ message: `bugs: --severity must be p0, p1 or p2`, status: 2 })
        }
      } else {
        return yield* new LandFailed({ message: `bugs: unexpected ${arg}\nUsage: ${bugsUsage}`, status: 2 })
      }
    }

    const { feed, at } = yield* feedContext
    const token = yield* feedToken()
    const params = new URLSearchParams()
    if (openOnly) params.set("open", "1")
    if (since) params.set("since", since)
    if (pathPrefix) params.set("path", pathPrefix)
    if (severity) params.set("severity", severity)
    const qs = params.toString()
    const url = `${feed.replace(/\/+$/, "")}/api/repos/${at.owner}/${at.repo}/bugs${qs ? `?${qs}` : ""}`

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(30_000),
        }),
      catch: () => new LandFailed({ message: `bugs: could not reach ${feed}` }),
    })
    if (response.status === 401 || response.status === 404) {
      return yield* new LandFailed({
        message: `bugs: the feed answered ${response.status}; for a private repository, configure a token with \`land auth token <token>\``,
      })
    }
    if (!response.ok) {
      return yield* new LandFailed({ message: `bugs: the feed answered ${response.status}` })
    }
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new LandFailed({ message: "bugs: the feed returned invalid JSON" }),
    })
    const list = yield* Schema.decodeUnknownEffect(Schema.Array(BugSummary))(raw).pipe(
      Effect.mapError((error) => new LandFailed({ message: `bugs: unexpected response shape: ${error.message}` })),
    )

    if (asJson) {
      console.log(JSON.stringify(list, null, 2))
      return
    }
    if (list.length === 0) {
      console.log("No registered bugs.")
      return
    }
    for (const b of list) {
      const id = bugIdFromSource(b.source).slice(0, 7)
      const loc = b.location ? ` (${b.location.path}${b.location.line ? `:${b.location.line}` : ""})` : ""
      const status = b.fixedBy ? `fixed in ${b.fixedBy.slice(0, 7)}` : "open"
      console.log(
        `${id}  ${b.severity.toUpperCase()}  ${b.culprit.slice(0, 7)}  [${status}]  ${b.title}${loc}  (${b.bugSource}, ${b.at.slice(0, 10)})`,
      )
    }
  })
