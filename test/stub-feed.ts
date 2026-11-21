// A stand-in for land-feed: its media API (D23) and its events notice (D27), with a fake R2
// behind it. Like the real feed, it reads the landing ref or the event ref in origin before it
// answers, and its R2 refuses bytes whose SHA-256 differs from the one the PUT names. The tests
// and drive.ts both use it.

export type Request = { method: string; path: string; credential: string | null }

const read = (origin: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["git", ...args], { cwd: origin, stdout: "pipe", stderr: "pipe" })
  return ran.exitCode === 0 ? ran.stdout.toString() : undefined
}

const name = "[A-Za-z0-9_.-]+"
const mediaPath = new RegExp(`^/api/media/${name}/${name}/([0-9a-f]{40})/([0-9a-f]{64})(/uploaded)?$`)
const eventPath = new RegExp(`^/api/landings/${name}/${name}/([0-9a-f]{40})/events/([0-9a-f]{40})$`)

export const stubFeed = (origin: string, { port = 0, onRequest = (_: Request) => {} } = {}) => {
  const requests: Request[] = []
  const stored = new Map<string, string>()
  const listed = (head: string, sha256: string) => {
    const record = read(origin, "show", `refs/landings/${head}:landing.json`)
    if (record === undefined) return undefined
    return (JSON.parse(record).recordings as { sha256: string; bytes: number }[]).find((r) => r.sha256 === sha256)
  }
  const server: Bun.Server<undefined> = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: async (request): Promise<Response> => {
      const path = new URL(request.url).pathname
      const seen = {
        method: request.method,
        path,
        credential: request.headers.get("authorization") ?? request.headers.get("cookie"),
      }
      requests.push(seen)
      onRequest(seen)
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
        const ref = read(origin, "rev-parse", "--verify", `refs/land-events/${event[1]}/${event[2]}`)
        return new Response(null, { status: ref === undefined ? 404 : 201 })
      }
      return new Response("not found\n", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, requests, stored, stop: () => server.stop(true) }
}
