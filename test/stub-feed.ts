// A stand-in for land-feed: its media API (D23), events notice (D27), and review/bug read APIs,
// with a fake R2 behind it. Like the real feed, it reads the landing ref or the event ref in origin
// before it answers, and its R2 refuses bytes whose SHA-256 differs from the one the PUT names.
// The tests and drive.ts both use it.

import type { BugSummary, Event, ReviewComment } from "../src/schema.ts"

export type Request = { method: string; path: string; credential: string | null }

const read = (origin: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["git", ...args], { cwd: origin, stdout: "pipe", stderr: "pipe" })
  return ran.exitCode === 0 ? ran.stdout.toString() : undefined
}

const name = "[A-Za-z0-9_.-]+"
const mediaPath = new RegExp(`^/api/media/${name}/${name}/([0-9a-f]{40})/([0-9a-f]{64})(/uploaded)?$`)
const eventPath = new RegExp(`^/api/landings/${name}/${name}/([0-9a-f]{40})/events/([0-9a-f]{40})$`)
const showMdPath = new RegExp(`^/(${name})/(${name})/([0-9a-f]{7,40})\\.md$`)
const landingCommentsPath = new RegExp(`^/api/landings/(${name})/(${name})/([0-9a-f]{7,40})/comments$`)
const repoCommentsPath = new RegExp(`^/api/repos/(${name})/(${name})/comments$`)
const commentPatchPath = new RegExp(`^/api/comments/([^/]+)$`)
const repoBugsPath = new RegExp(`^/api/repos/(${name})/(${name})/bugs$`)

export type StubFeedOptions = {
  port?: number
  installed?: boolean
  requireToken?: string
  comments?: ReviewComment[]
  onRequest?: (request: Request) => void
}

// installed: false answers as the real feed does for a repository without the App: 404.
export const stubFeed = (
  origin: string,
  { port = 0, installed = true, requireToken, comments = [], onRequest = () => {} }: StubFeedOptions = {},
) => {
  const requests: Request[] = []
  const stored = new Map<string, string>()
  const reviewComments: ReviewComment[] = [...comments]
  const events: Array<{ owner: string; name: string; head: string; id: string; body: Event }> = []

  const listed = (head: string, sha256: string) => {
    const record = read(origin, "show", `refs/landings/${head}:landing.json`)
    if (record === undefined) return undefined
    return (JSON.parse(record).recordings as { sha256: string; bytes: number }[]).find((r) => r.sha256 === sha256)
  }

  const authorized = (request: globalThis.Request) => {
    if (!requireToken) return true
    return request.headers.get("authorization") === `Bearer ${requireToken}`
  }

  const server: Bun.Server<undefined> = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url)
      const path = url.pathname
      const seen = {
        method: request.method,
        path,
        credential: request.headers.get("authorization") ?? request.headers.get("cookie"),
      }
      requests.push(seen)
      onRequest(seen)
      if (!installed && path.startsWith("/api/")) return new Response("not installed\n", { status: 404 })

      const media = request.method === "POST" ? path.match(mediaPath) : null
      if (media) {
        const [, head, sha256, done] = media as unknown as [string, string, string, string?]
        const file = listed(head, sha256)
        if (file === undefined) return new Response("the landing lists no such recording\n", { status: 404 })
        if (done) return new Response(null, { status: stored.has(sha256) ? 204 : 409 })
        if (stored.has(sha256)) return Response.json({ present: true })
        const headers = {
          "content-length": String(file.bytes),
          "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
        }
        return Response.json({ put: { url: `${server.url}r2/${sha256}`, headers } })
      }
      const put = request.method === "PUT" ? path.match(/^\/r2\/([0-9a-f]{64})$/) : null
      if (put) {
        const bytes = await request.text()
        const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("base64")
        if (sum !== request.headers.get("x-amz-checksum-sha256")) return new Response("BadDigest\n", { status: 400 })
        stored.set(put[1]!, bytes)
        return new Response(null, { status: 200 })
      }
      const event = request.method === "POST" ? path.match(eventPath) : null
      if (event) {
        const [, head, id] = event as unknown as [string, string, string]
        const raw = read(origin, "show", `refs/land-events/${head}/${id}:event.json`)
        if (raw === undefined) return new Response(null, { status: 404 })
        const [, owner, repo] = path.match(/^\/api\/landings\/([^/]+)\/([^/]+)\//)!
        events.push({ owner: owner!, name: repo!, head, id, body: JSON.parse(raw) as Event })
        return new Response(null, { status: 201 })
      }

      const md = request.method === "GET" ? path.match(showMdPath) : null
      if (md) {
        if (!authorized(request)) return new Response("not found\n", { status: 404 })
        const [, owner, repo, sha] = md as unknown as [string, string, string, string]
        const matching = reviewComments.filter(
          (c) => c.owner === owner && c.name === repo && c.head.startsWith(sha) && c.status === "open",
        )
        const lines = [`# ${owner}/${repo} ${sha.slice(0, 7)}`, ""]
        if (matching.length === 0) lines.push("No open review comments.")
        else {
          lines.push("## Open review comments", "")
          for (const c of matching) {
            const loc = c.path ? `${c.path}${c.lineStart ? `:${c.lineStart}` : ""}` : "landing"
            lines.push(`- **${loc}** (@${c.author}, ${c.kind}): ${c.body}`)
          }
        }
        return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "text/markdown; charset=utf-8" } })
      }

      const lc = request.method === "GET" ? path.match(landingCommentsPath) : null
      if (lc) {
        if (!authorized(request)) return new Response("not found\n", { status: 404 })
        const [, owner, repo, sha] = lc as unknown as [string, string, string, string]
        const statusFilter = url.searchParams.get("status")
        const list = reviewComments.filter(
          (c) =>
            c.owner === owner &&
            c.name === repo &&
            c.head.startsWith(sha) &&
            (!statusFilter || c.status === statusFilter),
        )
        return Response.json(list)
      }

      const rc = request.method === "GET" ? path.match(repoCommentsPath) : null
      if (rc) {
        if (!authorized(request)) return new Response("not found\n", { status: 404 })
        const [, owner, repo] = rc as unknown as [string, string, string]
        const statusFilter = url.searchParams.get("status")
        const list = reviewComments.filter(
          (c) => c.owner === owner && c.name === repo && (!statusFilter || c.status === statusFilter),
        )
        return Response.json(list)
      }

      const cp = request.method === "PATCH" ? path.match(commentPatchPath) : null
      if (cp) {
        if (!authorized(request)) return new Response("unauthorized\n", { status: 401 })
        const id = decodeURIComponent(cp[1]!)
        const idx = reviewComments.findIndex((c) => c.id === id)
        if (idx === -1) return new Response("not found\n", { status: 404 })
        const patch = (await request.json()) as { status?: "open" | "resolved"; resolvedBySha?: string }
        const cur = reviewComments[idx]!
        reviewComments[idx] = {
          ...cur,
          status: patch.status ?? cur.status,
          resolvedBySha: patch.resolvedBySha ?? cur.resolvedBySha,
          resolvedAt: patch.status === "resolved" ? Date.now() : null,
          updatedAt: Date.now(),
        }
        return Response.json(reviewComments[idx])
      }

      const rb = request.method === "GET" ? path.match(repoBugsPath) : null
      if (rb) {
        if (!authorized(request)) return new Response("not found\n", { status: 404 })
        const [, owner, repo] = rb as unknown as [string, string, string]
        const openOnly = url.searchParams.get("open") === "1"
        const severityFilter = url.searchParams.get("severity")
        const pathPrefix = url.searchParams.get("path")
        const repairs = events.filter((e) => e.body.repairs)
        const list: BugSummary[] = events
          .filter((e) => e.owner === owner && e.name === repo && e.body.kind === "bug")
          .map((e) => {
            const culprit = e.body.culprit ?? e.head
            const fix = repairs.find((r) => culprit.startsWith(r.body.repairs!))
            return {
              source: `ref:${e.id}`,
              owner: e.owner,
              name: e.name,
              head: e.head,
              culprit,
              landingTitle: null,
              title: e.body.title,
              severity: e.body.severity ?? "p1",
              bugSource: e.body.source ?? "agent",
              location: e.body.location ?? null,
              detail: e.body.detail ?? null,
              url: e.body.url ?? null,
              at: e.body.at,
              pushedAt: null,
              fixedBy: fix?.head ?? null,
              fixedAt: fix?.body.at ?? null,
            }
          })
          .filter((b) => (!openOnly || b.fixedBy === null) && (!severityFilter || b.severity === severityFilter))
          .filter((b) => !pathPrefix || (b.location?.path.startsWith(pathPrefix) ?? false))
        return Response.json(list)
      }

      return new Response("not found\n", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    requests,
    stored,
    comments: reviewComments,
    events,
    stop: () => server.stop(true),
  }
}
