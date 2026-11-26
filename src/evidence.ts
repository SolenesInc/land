import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { Effect, Schema } from "effect"
import { feedContext, pushEvent, resolveCommitSha } from "./event.ts"
import { LandFailed } from "./failure.ts"
import { listed, plural, readMediaBundle, uploadRecordings } from "./media.ts"
import { Event } from "./schema.ts"

export const evidenceUsage = `land evidence <sha> <file>... [-m <text> | --detail-file <file>] [--title <title>]`

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let sha: string | undefined
    const files: string[] = []
    let message: string | undefined
    let detailFile: string | undefined
    let title: string | undefined

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === "-m" || arg === "--message") {
        if (message !== undefined) {
          return yield* new LandFailed({ message: `evidence: -m/--message may only be passed once`, status: 2 })
        }
        const next = args[++i]
        if (next === undefined || next.trim() === "") {
          return yield* new LandFailed({
            message: `evidence: ${arg} requires text\nUsage: ${evidenceUsage}`,
            status: 2,
          })
        }
        message = next
      } else if (arg === "--detail-file") {
        if (detailFile !== undefined) {
          return yield* new LandFailed({ message: `evidence: --detail-file may only be passed once`, status: 2 })
        }
        const next = args[++i]
        if (next === undefined || next.trim() === "" || next.startsWith("-")) {
          return yield* new LandFailed({
            message: `evidence: --detail-file requires a file path\nUsage: ${evidenceUsage}`,
            status: 2,
          })
        }
        detailFile = next
      } else if (arg === "--title") {
        if (title !== undefined) {
          return yield* new LandFailed({ message: `evidence: --title may only be passed once`, status: 2 })
        }
        const next = args[++i]
        if (next === undefined || next.trim() === "") {
          return yield* new LandFailed({
            message: `evidence: --title requires a title\nUsage: ${evidenceUsage}`,
            status: 2,
          })
        }
        title = next.trim()
      } else if (arg.startsWith("-")) {
        return yield* new LandFailed({
          message: `evidence: unexpected ${arg}\nUsage: ${evidenceUsage}`,
          status: 2,
        })
      } else if (sha === undefined) {
        sha = arg
      } else {
        files.push(arg)
      }
    }

    if (sha === undefined || files.length === 0) {
      return yield* new LandFailed({
        message: `evidence: name the landing sha and at least one media file\nUsage: ${evidenceUsage}`,
        status: 2,
      })
    }
    if (message !== undefined && detailFile !== undefined) {
      return yield* new LandFailed({
        message: `evidence: pass either -m or --detail-file, not both`,
        status: 2,
      })
    }
    return { sha, files, message, detailFile, title }
  })

const defaultTitle = (files: ReadonlyArray<string>) => {
  if (files.length <= 3) return `Evidence: ${files.map((f) => basename(f)).join(", ")}`
  return `Evidence: ${plural(files.length)}`
}

export const evidence = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* parse(args)
    const { root, feed, at } = yield* feedContext
    const landing = yield* resolveCommitSha(parsed.sha, "evidence")

    const detailText =
      parsed.detailFile !== undefined
        ? yield* Effect.tryPromise({
            try: () => readFile(parsed.detailFile!, "utf8"),
            catch: () => new LandFailed({ message: `evidence: --detail-file ${parsed.detailFile}: no such file` }),
          })
        : parsed.message

    const bundle = yield* readMediaBundle({
      root,
      cwd: process.cwd(),
      text: detailText,
      noteLabel: parsed.detailFile !== undefined ? `--detail-file ${parsed.detailFile}` : "evidence message",
      extraFiles: parsed.files,
      extraLabel: "evidence",
      feed,
      pushContext: false,
    })

    const body = yield* Schema.decodeUnknownEffect(Event)({
      kind: "evidence",
      state: "info",
      title: parsed.title ?? defaultTitle(parsed.files),
      at: new Date().toISOString(),
      ...(bundle.text === undefined ? {} : { detail: bundle.text }),
      recordings: listed(bundle.recordings),
    }).pipe(Effect.mapError((error) => new LandFailed({ message: `evidence: ${error.message}`, status: 2 })))

    const pushed = yield* pushEvent({ feed, at, landing, body, label: "evidence" })
    yield* uploadRecordings(root, feed, at, landing, bundle.recordings, pushed.id, pushed.unreachable)
  })
