import { rm, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import { LandFailed } from "./failure.ts"
import { githubRepository, originUrl, recordingAddress, upload, type Repository } from "./feed.ts"
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

// The note's links to local media files. land record prints them relative to the repository
// root, so a relative link resolves from there.
const localMedia = (root: string, text: string) => {
  const found: { link: string; path: string; ext: Ext }[] = []
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1]!.startsWith("<") ? match[1]!.slice(1, -1) : match[1]!
    if (!isLocal(raw)) continue
    const file = decode(raw.replace(/[?#].*$/, ""))
    const ext = extensions[file.split(".").pop()!.toLowerCase()]
    if (ext === undefined || !file.includes(".")) continue
    found.push({ link: raw, path: isAbsolute(file) ? file : join(root, file), ext })
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
    const recordings: Recording[] = []
    for (const [i, link] of links.entries()) {
      recordings.push({ ...link, sha256: yield* hash(link.path), bytes: sizes[i]! })
    }
    const address = new Map(recordings.map((r) => [r.link, recordingAddress(feed, at, r.sha256, r.ext)]))
    const text = note.text.replace(linkPattern, (whole, target: string, rest: string) => {
      const raw = target.startsWith("<") ? target.slice(1, -1) : target
      const to = address.get(raw)
      return to === undefined ? whole : `](${to}${rest}`
    })
    return { text, recordings, at } satisfies NoteMedia
  })

// What landing.json lists: each file once.
export const listed = (recordings: ReadonlyArray<Recording>): LandingRecord["recordings"] => {
  const seen = new Map<string, LandingRecord["recordings"][number]>()
  for (const r of recordings) seen.set(r.sha256, { sha256: r.sha256, ext: r.ext, bytes: r.bytes })
  return [...seen.values()]
}

export const plural = (n: number) => `${n} recording${n === 1 ? "" : "s"}`

// After the push (D23, D24): upload each recording. One that does not go waits in the outbox,
// and land says why. land deletes the files that went, as it deletes the note.
export const uploadRecordings = (feed: string, at: Repository, head: string, recordings: ReadonlyArray<Recording>) =>
  Effect.gen(function* () {
    const files = new Map(recordings.map((r) => [r.sha256, r]))
    let uploaded = 0
    for (const r of files.values()) {
      const why = yield* upload({ feed, at, head, sha256: r.sha256, path: r.path }).pipe(
        Effect.as(undefined),
        Effect.catch((error: string) => Effect.succeed(error)),
      )
      if (why === undefined) {
        uploaded++
        yield* Effect.promise(() => rm(r.path, { force: true }))
        continue
      }
      yield* keepRecording({ feed, at, head, sha256: r.sha256, ext: r.ext }, r.path)
      console.log(`land: media  ${r.link} waits in the outbox: ${why}`)
    }
    if (uploaded > 0) console.log(`land: media  ${plural(uploaded)} uploaded`)
  })
