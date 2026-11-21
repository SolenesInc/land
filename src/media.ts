import { rm, stat } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { Effect } from "effect"
import { LandFailed } from "./failure.ts"
import { githubRepository, originUrl, recordingAddress, upload, type Failure, type Repository } from "./feed.ts"
import { landDir } from "./land-dir.ts"
import type { Note } from "./note.ts"
import { keepRecording } from "./outbox.ts"
import type { LandingRecord } from "./schema.ts"

type Ext = LandingRecord["recordings"][number]["ext"]
const extensions: Record<string, Ext> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  mp4: "mp4",
  webm: "webm",
}

// F36: the largest recording measured is 18 MB. Ten times that is a tripwire.
const maxBytes = 200 * 1024 * 1024

export type Recording = {
  readonly link: string // the target as the note writes it
  readonly path: string
  readonly sha256: string
  readonly ext: Ext
  readonly bytes: number
}

// A markdown link or image: ](target) or ](<target>), with an optional title.
const linkPattern = /\]\(\s*(<[^>\n]*>|[^\s)]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g

const isLocal = (target: string) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//") && !target.startsWith("#")

const decode = (target: string) => {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

// The note with its code blanked out, so a link shown as an example in a code span or a fenced
// block is no link. Positions stay where they were.
const outsideCode = (text: string) =>
  text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))|`+[^`\n]*?`+/gm, (code) =>
    code.replace(/[^\n]/g, " "),
  )

type Link = { readonly at: number; readonly length: number; readonly link: string; readonly rest: string }

// The note's links to local media files. land record prints them relative to the repository
// root, so a relative link resolves from there.
const localMedia = (root: string, text: string) => {
  const found: (Link & { path: string; ext: Ext })[] = []
  for (const match of outsideCode(text).matchAll(linkPattern)) {
    const raw = match[1]!.startsWith("<") ? match[1]!.slice(1, -1) : match[1]!
    if (!isLocal(raw)) continue
    const file = decode(raw.replace(/[?#].*$/, ""))
    const ext = extensions[file.split(".").pop()!.toLowerCase()]
    if (ext === undefined || !file.includes(".")) continue
    const path = isAbsolute(file) ? file : join(root, file)
    found.push({ at: match.index, length: match[0].length, link: raw, rest: match[2]!, path, ext })
  }
  return found
}

const hash = (path: string) =>
  Effect.promise(async () => {
    const hasher = new Bun.CryptoHasher("sha256")
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
    return hasher.digest("hex")
  })

export type NoteMedia = {
  readonly text: string // the note with its local links rewritten to feed addresses (D25)
  readonly recordings: ReadonlyArray<Recording>
  readonly at?: Repository
}

// Before the gate: every local recording the note links exists, is small enough, and has a
// feed to go to. Then the note links each by the address the feed will serve it at.
export const readNoteMedia = (root: string, note: Note, feed: string | undefined) =>
  Effect.gen(function* () {
    const links = localMedia(root, note.text)
    if (links.length === 0) return { text: note.text, recordings: [] } satisfies NoteMedia
    const sizes: number[] = []
    for (const link of links) {
      const info = yield* Effect.promise(() => stat(link.path).catch(() => undefined))
      if (info === undefined || !info.isFile()) {
        return yield* new LandFailed({
          message: `the note ${note.shown} links ${link.link}, and there is no such file; nothing was pushed`,
        })
      }
      if (info.size > maxBytes) {
        return yield* new LandFailed({
          message: `the note ${note.shown} links ${link.link}, which is ${(info.size / 1024 / 1024).toFixed(0)} MB; the feed takes recordings up to 200 MB, so record a shorter one`,
        })
      }
      sizes.push(info.size)
    }
    if (feed === undefined) {
      return yield* new LandFailed({
        message: `the note ${note.shown} links the recording ${links[0]!.link}, and land.toml names no feed to host it; add
  feed = "https://land-feed.caketroll.cloud"
to land.toml, or link no local file`,
      })
    }
    const at = yield* githubRepository
    if (at === undefined) {
      return yield* new LandFailed({
        message: `the note ${note.shown} links the recording ${links[0]!.link}, and the feed hosts recordings of GitHub repositories only; origin is ${yield* originUrl}`,
      })
    }
    // Each file once, however many links name it.
    const recordings = new Map<string, Recording>()
    const address: string[] = []
    for (const [i, link] of links.entries()) {
      const sha256 = yield* hash(link.path)
      if (!recordings.has(sha256))
        recordings.set(sha256, { link: link.link, path: link.path, sha256, ext: link.ext, bytes: sizes[i]! })
      address.push(recordingAddress(feed, at, sha256, recordings.get(sha256)!.ext))
    }
    let text = note.text
    for (const [i, link] of [...links.entries()].reverse()) {
      text = `${text.slice(0, link.at)}](${address[i]}${link.rest}${text.slice(link.at + link.length)}`
    }
    return { text, recordings: [...recordings.values()], at } satisfies NoteMedia
  })

export const listed = (recordings: ReadonlyArray<Recording>): LandingRecord["recordings"] =>
  recordings.map((r) => ({ sha256: r.sha256, ext: r.ext, bytes: r.bytes }))

export const plural = (n: number) => `${n} recording${n === 1 ? "" : "s"}`

// After the push (D23, D24): upload each recording. One that does not go waits in the outbox,
// and land says why. land deletes the files that went, as it deletes the note, but only those in
// .land/: a note may link a file the repository tracks, or one outside it.
export const uploadRecordings = (
  root: string,
  feed: string,
  at: Repository,
  head: string,
  recordings: ReadonlyArray<Recording>,
) =>
  Effect.gen(function* () {
    let uploaded = 0
    let down: Failure | undefined
    for (const r of recordings) {
      const failure =
        down ??
        (yield* upload({ feed, at, head, sha256: r.sha256, path: r.path }).pipe(
          Effect.as(undefined),
          Effect.catch((failure: Failure) => Effect.succeed(failure)),
        ))
      if (failure === undefined) {
        uploaded++
        if (!relative(join(root, landDir), r.path).startsWith("..")) {
          yield* Effect.promise(() => rm(r.path, { force: true }))
        }
        continue
      }
      if (failure.kind === "unreachable") down = failure
      if (failure.kind === "refused") {
        console.log(
          `land: media  ${r.link} is not uploaded: ${failure.why}; is the Attn Land App installed on ${at.owner}/${at.repo}?`,
        )
        continue
      }
      const kept = yield* keepRecording({ feed, at, head, sha256: r.sha256, ext: r.ext }, r.path).pipe(
        Effect.as(`waits in the outbox: ${failure.why}`),
        Effect.catch((why: string) => Effect.succeed(`is not uploaded: ${failure.why}, and ${why}`)),
      )
      console.log(`land: media  ${r.link} ${kept}`)
    }
    if (uploaded > 0) console.log(`land: media  ${plural(uploaded)} uploaded`)
  })
