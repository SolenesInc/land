import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
import { LandFailed } from "./failure.ts"
import { githubRepository, originUrl, recordingAddress, upload, type Failure, type Repository } from "./feed.ts"
import { git, gitOk } from "./git.ts"
import { landDir } from "./land-dir.ts"
import type { Note } from "./note.ts"
import { keepRecording } from "./outbox.ts"
import { parseAttnSeedTrailers, type RecordingEntry, type RecordingExt } from "./schema.ts"

const extensions: Record<string, RecordingExt> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  mp4: "mp4",
  webm: "webm",
}

export const supportedMediaExtensions = "png, jpg, jpeg, gif, webp, mp4, or webm"

export const mediaExt = (file: string): RecordingExt | undefined => {
  const ext = extname(file).slice(1).toLowerCase()
  return ext === "" ? undefined : extensions[ext]
}

// F36: the largest recording measured is 18 MB. Ten times that is a tripwire.
const maxBytes = 200 * 1024 * 1024

export type Recording = {
  readonly link: string // the target as the note or CLI wrote it
  readonly path: string
  readonly paths: ReadonlyArray<string> // every linked path with these bytes (for .land/ cleanup)
  readonly sha256: string
  readonly ext: RecordingExt
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

// The markdown's links to local media files. land record prints them relative to the repository
// root, so a relative link resolves from there.
const localMedia = (root: string, text: string) => {
  const found: (Link & { path: string; ext: RecordingExt })[] = []
  for (const match of outsideCode(text).matchAll(linkPattern)) {
    const raw = match[1]!.startsWith("<") ? match[1]!.slice(1, -1) : match[1]!
    if (!isLocal(raw)) continue
    const file = decode(raw.replace(/[?#].*$/, ""))
    const ext = mediaExt(file)
    if (ext === undefined) continue
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

const canonicalPath = (path: string) => Effect.promise(() => realpath(path).catch(() => resolve(path)))

const altFromPath = (path: string) => basename(path).replace(/\.[^.]*$/, "") || basename(path)

export type NoteMedia = {
  readonly text: string | undefined // the markdown with local links rewritten to feed addresses (D25)
  readonly recordings: ReadonlyArray<Recording>
  readonly linkedPaths: ReadonlySet<string>
  readonly at?: Repository
}

export const readMediaBundle = (opts: {
  readonly root: string
  readonly cwd: string
  readonly text: string | undefined
  readonly noteLabel: string // e.g. "the note .land/note.md" or "--detail-file finding.md"
  readonly extraFiles?: ReadonlyArray<string>
  readonly extraLabel?: string // e.g. "--media" or "evidence"
  readonly feed: string | undefined
  readonly pushContext?: boolean // true for land (adds "; nothing was pushed")
}) =>
  Effect.gen(function* () {
    const links = opts.text === undefined ? [] : localMedia(opts.root, opts.text)
    const extras = (opts.extraFiles ?? []).map((raw) => ({
      raw,
      path: isAbsolute(raw) ? raw : resolve(opts.cwd, raw),
    }))
    if (links.length === 0 && extras.length === 0) {
      return { text: opts.text, recordings: [], linkedPaths: new Set<string>() } satisfies NoteMedia
    }

    const notPushed = opts.pushContext ? "; nothing was pushed" : ""
    const extraLabel = opts.extraLabel ?? "--media"

    const linkSizes: number[] = []
    for (const link of links) {
      const info = yield* Effect.promise(() => stat(link.path).catch(() => undefined))
      if (info === undefined || !info.isFile()) {
        return yield* new LandFailed({
          message: `${opts.noteLabel} links ${link.link}, and there is no such file${notPushed}`,
        })
      }
      if (info.size > maxBytes) {
        return yield* new LandFailed({
          message: `${opts.noteLabel} links ${link.link}, which is ${(info.size / 1024 / 1024).toFixed(0)} MB; the feed takes recordings up to 200 MB, so record a shorter one`,
        })
      }
      linkSizes.push(info.size)
    }

    const extraValidated: Array<{ raw: string; path: string; ext: RecordingExt; bytes: number }> = []
    for (const extra of extras) {
      const ext = mediaExt(extra.path)
      if (ext === undefined) {
        return yield* new LandFailed({
          message: `${extraLabel} ${extra.raw}: unsupported media type; expected ${supportedMediaExtensions}${notPushed}`,
        })
      }
      const info = yield* Effect.promise(() => stat(extra.path).catch(() => undefined))
      if (info === undefined || !info.isFile()) {
        return yield* new LandFailed({
          message: `${extraLabel} ${extra.raw}: no such file${notPushed}`,
        })
      }
      if (info.size > maxBytes) {
        return yield* new LandFailed({
          message: `${extraLabel} ${extra.raw} is ${(info.size / 1024 / 1024).toFixed(0)} MB; the feed takes recordings up to 200 MB, so record a shorter one`,
        })
      }
      extraValidated.push({ raw: extra.raw, path: extra.path, ext, bytes: info.size })
    }

    const firstLink = links[0]?.link ?? extraValidated[0]!.raw
    const firstSource =
      links.length > 0 ? `${opts.noteLabel} links the recording ${firstLink}` : `${extraLabel} ${firstLink}`
    if (opts.feed === undefined) {
      return yield* new LandFailed({
        message: `${firstSource}, and land.toml names no feed to host it; add
  feed = "https://land-feed.caketroll.cloud"
to land.toml, or link no local file`,
      })
    }
    const at = yield* githubRepository
    if (at === undefined) {
      return yield* new LandFailed({
        message: `${firstSource}, and the feed hosts recordings of GitHub repositories only; origin is ${yield* originUrl}`,
      })
    }

    // Each file once, however many links or flags name it.
    const recordings = new Map<
      string,
      { link: string; path: string; paths: string[]; sha256: string; ext: RecordingExt; bytes: number }
    >()
    const linkedPaths = new Set<string>()
    const linkedInText = new Set<string>()
    const linkAddresses: string[] = []
    for (const [i, link] of links.entries()) {
      const sha256 = yield* hash(link.path)
      linkedInText.add(sha256)
      linkedPaths.add(yield* canonicalPath(link.path))
      const existing = recordings.get(sha256)
      if (existing === undefined) {
        recordings.set(sha256, {
          link: link.link,
          path: link.path,
          paths: [link.path],
          sha256,
          ext: link.ext,
          bytes: linkSizes[i]!,
        })
      } else if (!existing.paths.includes(link.path)) {
        existing.paths.push(link.path)
      }
      linkAddresses.push(recordingAddress(opts.feed, at, sha256, recordings.get(sha256)!.ext))
    }

    const appendedLines: string[] = []
    for (const extra of extraValidated) {
      const sha256 = yield* hash(extra.path)
      linkedPaths.add(yield* canonicalPath(extra.path))
      const existing = recordings.get(sha256)
      if (existing === undefined) {
        recordings.set(sha256, {
          link: extra.raw,
          path: extra.path,
          paths: [extra.path],
          sha256,
          ext: extra.ext,
          bytes: extra.bytes,
        })
      } else if (!existing.paths.includes(extra.path)) {
        existing.paths.push(extra.path)
      }
      if (!linkedInText.has(sha256)) {
        linkedInText.add(sha256)
        const address = recordingAddress(opts.feed, at, sha256, recordings.get(sha256)!.ext)
        appendedLines.push(`![${altFromPath(extra.path)}](${address})`)
      }
    }

    let text = opts.text
    if (text !== undefined && links.length > 0) {
      for (const [i, link] of [...links.entries()].reverse()) {
        text = `${text.slice(0, link.at)}](${linkAddresses[i]}${link.rest}${text.slice(link.at + link.length)}`
      }
    }
    if (appendedLines.length > 0) {
      const block = `${appendedLines.join("\n\n")}\n`
      if (text === undefined || text.trim() === "") {
        text = block
      } else {
        const trimmed = text.replace(/\s+$/, "")
        text = `${trimmed}\n\n${block}`
      }
    }
    return { text, recordings: [...recordings.values()], linkedPaths, at } satisfies NoteMedia
  })

// Before the gate: every local recording the note or --media names exists, is small enough, and has a
// feed to go to. Then the note links each by the address the feed will serve it at.
export const readNoteMedia = (
  root: string,
  cwd: string,
  note: Note | undefined,
  extraFiles: ReadonlyArray<string>,
  feed: string | undefined,
) =>
  readMediaBundle({
    root,
    cwd,
    text: note?.text,
    noteLabel: note === undefined ? "the note" : `the note ${note.shown}`,
    extraFiles,
    extraLabel: "--media",
    feed,
    pushContext: true,
  })

export const listed = (recordings: ReadonlyArray<Recording>): RecordingEntry[] =>
  recordings.map((r) => ({ sha256: r.sha256, ext: r.ext, bytes: r.bytes }))

export const plural = (n: number) => `${n} recording${n === 1 ? "" : "s"}`

// Unlinked media files sitting in .land/media/ (e.g. from `land record` or screenshots saved there
// that the lander forgot to paste into .land/note.md or pass with --media).
export const findUnlinkedLandMedia = (root: string, linkedPaths: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const mediaDir = join(root, landDir, "media")
    const entries = yield* Effect.promise(() => readdir(mediaDir).catch(() => [] as string[]))
    const unlinked: string[] = []
    for (const name of entries.sort()) {
      if (name.startsWith(".") || mediaExt(name) === undefined) continue
      const full = join(mediaDir, name)
      const info = yield* Effect.promise(() => stat(full).catch(() => undefined))
      if (info === undefined || !info.isFile()) continue
      const canon = yield* canonicalPath(full)
      if (!linkedPaths.has(canon)) unlinked.push(`${landDir}/media/${name}`)
    }
    return unlinked
  })

// Files in `changed` matching the ordered patterns declared in `visual_paths` (supports `!pattern` negation).
export const matchVisualPaths = (patterns: ReadonlyArray<string>, changed: ReadonlyArray<string>): string[] => {
  const rules = patterns.map((p) =>
    p.startsWith("!") ? { negate: true, glob: new Bun.Glob(p.slice(1)) } : { negate: false, glob: new Bun.Glob(p) },
  )
  return changed.filter((file) => {
    let matched = false
    for (const rule of rules) {
      if (rule.glob.match(file)) matched = !rule.negate
    }
    return matched
  })
}

export type SeedMediaGroup = {
  readonly seedId: string
  readonly files: ReadonlyArray<string>
}

type AttnSeedArtifact = {
  readonly filename?: unknown
  readonly relative_target?: unknown
  readonly modified_at?: unknown
}

type AttnSeedShow = {
  readonly artifact_dir?: unknown
  readonly artifacts?: unknown
}

// Receipt, 2026-11-26, Victor's Mac: `attn seed show <id> --json` answered in 0.12s.
// 5s is a ~40x tripwire so a stuck daemon never stalls a landing.
const attnShowTimeoutMs = 5_000
const seedHistoryWindow = 200
const seedRecordRetentionMs = 30 * 24 * 60 * 60 * 1000

const queryAttnSeed = (attnBin: string, seedId: string) =>
  Effect.promise(async (): Promise<AttnSeedShow | undefined> => {
    try {
      const child = Bun.spawn([attnBin, "seed", "show", seedId, "--json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }, attnShowTimeoutMs)
      try {
        const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
        if (status !== 0 || out.trim() === "") return undefined
        return JSON.parse(out) as AttnSeedShow
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return undefined
    }
  })

const seedLandedPath = (commonDir: string, seedId: string) => join(commonDir, "land-seed-landed", `${seedId}.txt`)

const readSeedLandedMs = (commonDir: string, seedId: string) =>
  Effect.promise(async () => {
    const raw = await readFile(seedLandedPath(commonDir, seedId), "utf8").catch(() => "")
    const n = Number(raw.trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  })

// Record the wall-clock push time for every Attn-Seed trailer in base..head so later landings
// of the same seed ignore screenshots captured after the prior commit but before it pushed.
export const recordSeedLanding = (commonDir: string, base: string, head: string) =>
  Effect.gen(function* () {
    const log = yield* gitOk("log", "--reverse", "--format=%B%x1e", `${base}..${head}`)
    const seeds = new Set<string>()
    for (const msg of log.split("\x1e")) {
      for (const id of parseAttnSeedTrailers(msg)) seeds.add(id)
    }
    if (seeds.size === 0) return
    const now = String(Date.now())
    const dir = join(commonDir, "land-seed-landed")
    yield* Effect.promise(async () => {
      await mkdir(dir, { recursive: true })
      for (const seedId of seeds) {
        await writeFile(seedLandedPath(commonDir, seedId), `${now}\n`)
      }
      const cutoff = Date.now() - seedRecordRetentionMs
      for (const entry of await readdir(dir).catch(() => [])) {
        const full = join(dir, entry)
        const info = await stat(full).catch(() => undefined)
        if (info !== undefined && info.mtimeMs < cutoff) await rm(full, { force: true }).catch(() => undefined)
      }
    })
  }).pipe(Effect.catch(() => Effect.void))

// Most recent committer time (rounded up past its second) on `base` carrying `Attn-Seed: <seedId>`,
// parsed with the same trailer parser so multi-seed and lowercase trailers match consistently.
const priorSeedCommitCutoffMs = (base: string, seeds: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const cutoffs = new Map<string, number>()
    const res = yield* git("log", `-${seedHistoryWindow}`, "--format=%ct%x00%B%x1e", base)
    if (res.status !== 0) return cutoffs
    for (const chunk of res.out.split("\x1e")) {
      const sep = chunk.indexOf("\x00")
      if (sep === -1) continue
      const ct = Number(chunk.slice(0, sep).trim())
      if (!Number.isFinite(ct) || ct <= 0) continue
      const msg = chunk.slice(sep + 1)
      for (const id of parseAttnSeedTrailers(msg)) {
        if (seeds.has(id) && !cutoffs.has(id)) cutoffs.set(id, (ct + 1) * 1000)
      }
      if (cutoffs.size === seeds.size) break
    }
    return cutoffs
  })

// Best-effort discovery of fresh media artifacts attached to Attn-Seed trailers on base..head.
// Silently skips if commits carry no Attn-Seed trailers, `attn` is not on PATH, or the daemon
// does not answer, so non-attn workflows and offline runs are never affected.
export const findUnlinkedSeedMedia = (commonDir: string, base: string, head: string) =>
  Effect.gen(function* () {
    const log = yield* gitOk("log", "--reverse", "--format=%B%x1e", `${base}..${head}`)
    const seeds = new Set<string>()
    for (const msg of log.split("\x1e")) {
      for (const id of parseAttnSeedTrailers(msg)) seeds.add(id)
    }
    if (seeds.size === 0) return [] as SeedMediaGroup[]
    const attnBin = Bun.which("attn")
    if (attnBin === null) return [] as SeedMediaGroup[]

    const commitCutoffs = yield* priorSeedCommitCutoffMs(base, seeds)
    const groups: SeedMediaGroup[] = []
    for (const seedId of seeds) {
      const cutoffMs = Math.max(commitCutoffs.get(seedId) ?? 0, yield* readSeedLandedMs(commonDir, seedId))
      const shown = yield* queryAttnSeed(attnBin, seedId)
      if (shown === undefined || typeof shown.artifact_dir !== "string" || !Array.isArray(shown.artifacts)) continue
      const files: string[] = []
      for (const raw of shown.artifacts as AttnSeedArtifact[]) {
        const name =
          typeof raw.relative_target === "string" && raw.relative_target !== "" ? raw.relative_target : raw.filename
        if (typeof name !== "string" || mediaExt(name) === undefined) continue
        const full = isAbsolute(name) ? name : join(shown.artifact_dir, name)
        const info = yield* Effect.promise(() => stat(full).catch(() => undefined))
        if (info === undefined || !info.isFile()) continue
        if (cutoffMs > 0) {
          const parsedMtime = typeof raw.modified_at === "string" ? Date.parse(raw.modified_at) : Number.NaN
          const mtime = Number.isNaN(parsedMtime) ? info.mtimeMs : parsedMtime
          if (mtime <= cutoffMs) continue
        }
        files.push(full)
      }
      if (files.length > 0) groups.push({ seedId, files: files.sort() })
    }
    return groups
  })

const removeLandCopies = (landRoot: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const p of paths) {
      const canon = yield* canonicalPath(p)
      const rel = relative(landRoot, canon)
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
        yield* Effect.promise(() => rm(p, { force: true }))
      }
    }
  })

// After the push (D23, D24): upload each recording. One that does not go waits in the outbox,
// and land says why. land deletes the files in .land/ once uploaded or safely persisted in the
// outbox, leaving tracked or outside files untouched.
export const uploadRecordings = (
  root: string,
  feed: string,
  at: Repository,
  head: string,
  recordings: ReadonlyArray<Recording>,
  eventId?: string,
  initialDown?: Failure,
) =>
  Effect.gen(function* () {
    const landRoot = yield* canonicalPath(join(root, landDir))
    let uploaded = 0
    let down: Failure | undefined = initialDown
    for (const r of recordings) {
      const failure =
        down ??
        (yield* upload({
          feed,
          at,
          head,
          ...(eventId === undefined ? {} : { eventId }),
          sha256: r.sha256,
          path: r.path,
        }).pipe(
          Effect.as(undefined),
          Effect.catch((failure: Failure) => Effect.succeed(failure)),
        ))
      if (failure === undefined) {
        uploaded++
        yield* removeLandCopies(landRoot, r.paths)
        continue
      }
      if (failure.kind === "unreachable") down = failure
      if (failure.kind === "refused") {
        console.log(
          `land: media  ${r.link} is not uploaded: ${failure.why}; is the Attn Land App installed on ${at.owner}/${at.repo}?`,
        )
        continue
      }
      const saved = yield* keepRecording(
        { feed, at, head, ...(eventId === undefined ? {} : { eventId }), sha256: r.sha256, ext: r.ext },
        r.path,
      ).pipe(
        Effect.as({ ok: true as const, note: `waits in the outbox: ${failure.why}` }),
        Effect.catch((why: string) =>
          Effect.succeed({ ok: false as const, note: `is not uploaded: ${failure.why}, and ${why}` }),
        ),
      )
      if (saved.ok) yield* removeLandCopies(landRoot, r.paths)
      console.log(`land: media  ${r.link} ${saved.note}`)
    }
    if (uploaded > 0) console.log(`land: media  ${plural(uploaded)} uploaded`)
  })
