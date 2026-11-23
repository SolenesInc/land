import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { feedToken } from "./auth.ts"
import { feedContext, pushEvent, resolveCommitSha } from "./event.ts"
import { LandFailed } from "./failure.ts"
import { git, gitOk } from "./git.ts"
import { metaGet, parseFrontmatter, splitLines, validateReviewDoc } from "./review-doc.ts"
import { Event, ReviewComment, type ReviewChangedFile } from "./schema.ts"

export const showUsage = `land show <sha | feed-url>`
export const commentsUsage = `land comments [<sha | feed-url>] [--open] [--json]
land comments resolve <id> [--by <sha>]`
export const reviewUsage = `land review check <file> [--base <sha>] [--head <sha>]`
export const briefUsage = `land brief <sha> <file> [--base <sha>] [--no-check]`

const feedLandingUrl =
  /^(https?:\/\/[^/]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([0-9a-f]{7,40})(?:\.md)?(?:[?#].*)?$/

const resolveTarget = (target: string, label: string) =>
  Effect.gen(function* () {
    const m = target.match(feedLandingUrl)
    if (m) return { feed: m[1]!, owner: m[2]!, repo: m[3]!, sha: m[4]! }
    const { feed, at } = yield* feedContext
    const sha = yield* resolveCommitSha(target, label)
    return { feed: feed.replace(/\/+$/, ""), owner: at.owner, repo: at.repo, sha }
  })

const fetchFeed = (url: string, init: RequestInit, label: string) =>
  Effect.gen(function* () {
    const token = yield* feedToken()
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
    if (token) headers.authorization = `Bearer ${token}`
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) }),
      catch: () => new LandFailed({ message: `${label}: could not reach ${new URL(url).origin}` }),
    })
    if (response.status === 401 || response.status === 404) {
      return yield* new LandFailed({
        message: `${label}: the feed answered ${response.status}; for a private repository, configure a token with \`land auth token <token>\``,
      })
    }
    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text().catch(() => ""))
      return yield* new LandFailed({
        message: `${label}: the feed answered ${response.status}${text ? `: ${text.trim()}` : ""}`,
      })
    }
    return response
  })

export const show = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length !== 1 || args[0]!.startsWith("--")) {
      return yield* new LandFailed({ message: `show: name a commit sha or feed URL\nUsage: ${showUsage}`, status: 2 })
    }
    const { feed, owner, repo, sha } = yield* resolveTarget(args[0]!, "show")
    const response = yield* fetchFeed(`${feed}/${owner}/${repo}/${sha}.md`, { method: "GET" }, "show")
    const text = yield* Effect.promise(() => response.text())
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
  })

export const comments = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args[0] === "resolve") {
      const id = args[1]
      if (!id || id.startsWith("--")) {
        return yield* new LandFailed({ message: `comments: name a comment id\nUsage:\n  ${commentsUsage}`, status: 2 })
      }
      let bySha: string | undefined
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--by" && args[i + 1]) {
          bySha = yield* resolveCommitSha(args[++i]!, "comments")
        } else {
          return yield* new LandFailed({
            message: `comments: unexpected ${args[i]}\nUsage:\n  ${commentsUsage}`,
            status: 2,
          })
        }
      }
      const { feed } = yield* feedContext
      yield* fetchFeed(
        `${feed.replace(/\/+$/, "")}/api/comments/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "resolved", ...(bySha ? { resolvedBySha: bySha } : {}) }),
        },
        "comments",
      )
      console.log(`land: comment ${id} resolved${bySha ? ` (by ${bySha.slice(0, 7)})` : ""}`)
      return
    }

    let target: string | undefined
    let openOnly = false
    let asJson = false
    for (const arg of args) {
      if (arg === "--open") openOnly = true
      else if (arg === "--json") asJson = true
      else if (!arg.startsWith("--") && target === undefined) target = arg
      else
        return yield* new LandFailed({ message: `comments: unexpected ${arg}\nUsage:\n  ${commentsUsage}`, status: 2 })
    }

    let url: string
    if (target) {
      const t = yield* resolveTarget(target, "comments")
      url = `${t.feed}/api/landings/${t.owner}/${t.repo}/${t.sha}/comments${openOnly ? "?status=open" : ""}`
    } else {
      const { feed, at } = yield* feedContext
      url = `${feed.replace(/\/+$/, "")}/api/repos/${at.owner}/${at.repo}/comments${openOnly ? "?status=open" : ""}`
    }

    const response = yield* fetchFeed(url, { method: "GET" }, "comments")
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new LandFailed({ message: "comments: invalid JSON from feed" }),
    })
    const list = yield* Schema.decodeUnknownEffect(Schema.Array(ReviewComment))(raw).pipe(
      Effect.mapError((error) => new LandFailed({ message: `comments: unexpected response: ${error.message}` })),
    )
    if (asJson) {
      console.log(JSON.stringify(list, null, 2))
      return
    }
    if (list.length === 0) {
      console.log(openOnly ? "No open comments." : "No comments.")
      return
    }
    for (const c of list) {
      const where = c.path
        ? `${c.path}${c.lineStart !== null ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}` : ""}`
        : "(landing)"
      console.log(`[${c.status}] ${c.id}  ${c.head.slice(0, 7)}  ${where}  @${c.author} (${c.kind})`)
      for (const line of c.body.trim().split("\n")) console.log(`  ${line}`)
    }
  })

const statusName: Record<string, string> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "type_changed",
}

const gitChangedFiles = (base: string, head: string) =>
  Effect.gen(function* () {
    const nameStatus = yield* gitOk("diff", "--name-status", "-M", `${base}..${head}`)
    const numstat = yield* gitOk("diff", "--numstat", "-M", `${base}..${head}`)
    const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
    for (const line of splitLines(numstat)) {
      const parts = line.split("\t")
      if (parts.length < 3) continue
      const path = parts.at(-1)!
      const binary = parts[0] === "-" || parts[1] === "-"
      counts.set(path, {
        added: binary ? 0 : Number.parseInt(parts[0]!, 10) || 0,
        removed: binary ? 0 : Number.parseInt(parts[1]!, 10) || 0,
        binary,
      })
    }
    const files: ReviewChangedFile[] = []
    for (const line of splitLines(nameStatus)) {
      const parts = line.split("\t")
      if (parts.length < 2) continue
      const code = parts[0]![0]!
      const oldPath = code === "R" || code === "C" ? parts[1]! : null
      const path = code === "R" || code === "C" ? parts[2]! : parts[1]!
      const c = counts.get(path) ?? { added: 0, removed: 0, binary: false }
      files.push({
        path,
        status: statusName[code] ?? "modified",
        added: c.added,
        removed: c.removed,
        binary: c.binary,
        oldPath,
      })
    }
    return files
  })

const validateFileAgainstGit = (text: string, base: string, head: string) =>
  Effect.gen(function* () {
    const files = yield* gitChangedFiles(base, head)
    const lineCounts = new Map<string, number>()
    for (const f of files) {
      const ref = f.status === "deleted" ? `${base}:${f.oldPath ?? f.path}` : `${head}:${f.path}`
      const res = yield* git("show", ref)
      if (res.status === 0) lineCounts.set(f.path, splitLines(res.out).length)
    }
    return validateReviewDoc(text, { files, lineCounts })
  })

export const review = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args[0] !== "check" || !args[1] || args[1].startsWith("--")) {
      return yield* new LandFailed({ message: `review: unexpected arguments\nUsage: ${reviewUsage}`, status: 2 })
    }
    const file = args[1]
    let baseArg: string | undefined
    let headArg: string | undefined
    for (let i = 2; i < args.length; i += 2) {
      if (args[i] === "--base" && args[i + 1]) baseArg = args[i + 1]
      else if (args[i] === "--head" && args[i + 1]) headArg = args[i + 1]
      else return yield* new LandFailed({ message: `review: unexpected ${args[i]}\nUsage: ${reviewUsage}`, status: 2 })
    }
    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: () => new LandFailed({ message: `review: ${file}: no such file` }),
    })
    const meta = parseFrontmatter(splitLines(text))
    const headRef = headArg ?? metaGet(meta, "head")?.value ?? "HEAD"
    const head = yield* resolveCommitSha(headRef, "review")
    const baseRef = baseArg ?? metaGet(meta, "base")?.value ?? `${head}~1`
    const base = yield* resolveCommitSha(baseRef, "review")
    const bundle = yield* validateFileAgainstGit(text, base, head)
    if (bundle.problems.length > 0) {
      for (const p of bundle.problems) {
        console.error(`${file}:${p.line}: ${p.message}`)
      }
      return yield* new LandFailed({
        message: `review check found ${bundle.problems.length} problem${bundle.problems.length === 1 ? "" : "s"}`,
      })
    }
    console.log(
      `land: review ok  frame=${bundle.frame}  ${bundle.stops.length} stop${bundle.stops.length === 1 ? "" : "s"}, ${bundle.coverage.totalFiles} files covered`,
    )
  })

export const brief = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sha, file, ...rest] = args
    let noCheck = false
    let baseArg: string | undefined
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (arg === "--no-check") noCheck = true
      else if (arg === "--base" && rest[i + 1]) baseArg = rest[++i]
      else return yield* new LandFailed({ message: `brief: unexpected ${arg}\nUsage: ${briefUsage}`, status: 2 })
    }
    if (!sha || sha.startsWith("--") || !file || file.startsWith("--")) {
      return yield* new LandFailed({
        message: `brief: name the landing and review file\nUsage: ${briefUsage}`,
        status: 2,
      })
    }
    const { feed, at } = yield* feedContext
    const landing = yield* resolveCommitSha(sha, "brief")
    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: () => new LandFailed({ message: `brief: ${file}: no such file` }),
    })

    let title = "Review brief"
    if (!noCheck) {
      const meta = parseFrontmatter(splitLines(text))
      const metaBase = metaGet(meta, "base")?.value
      const baseRef = baseArg ?? metaBase
      const resolvedBase =
        baseRef !== undefined
          ? yield* resolveCommitSha(baseRef, "brief")
          : (yield* git("rev-parse", "--verify", "--quiet", `${landing}~1^{commit}`)).out
      if (resolvedBase) {
        const bundle = yield* validateFileAgainstGit(text, resolvedBase, landing)
        if (bundle.title) title = bundle.title
        if (bundle.problems.length > 0) {
          for (const p of bundle.problems) console.error(`${file}:${p.line}: ${p.message}`)
          return yield* new LandFailed({
            message: `brief: review check failed with ${bundle.problems.length} problem${bundle.problems.length === 1 ? "" : "s"} (fix them or pass --no-check)`,
          })
        }
      }
    } else {
      const firstH1 = splitLines(text).find((l) => l.startsWith("# "))
      if (firstH1) title = firstH1.slice(2).trim()
    }

    const body = yield* Schema.decodeUnknownEffect(Event)({
      kind: "review-doc",
      state: "info",
      title,
      at: new Date().toISOString(),
      detail: text,
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `brief: ${error.message}`, status: 2 })))

    yield* pushEvent({ feed, at, landing, body, label: "brief" })
  })
