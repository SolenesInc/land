import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { notify, upload, type Failure, type Repository } from "./feed.ts"

// D24: what land could not send the feed, kept on the lander's machine until a later land
// sends it. An entry holds no credential; the ref on GitHub authorizes it.

type Recording = {
  readonly kind: "recording"
  readonly feed: string
  readonly at: Repository
  readonly head: string
  readonly sha256: string
  readonly ext: string
}
type Event = {
  readonly kind: "event"
  readonly feed: string
  readonly at: Repository
  readonly sha: string
  readonly id: string
}
type Entry = Recording | Event

const dir = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "land", "outbox")

// One entry per thing to send: a recording waits once per repository, whichever landing
// listed it last, and an event once.
const name = (entry: Entry) =>
  entry.kind === "recording"
    ? `recording~${entry.at.owner}~${entry.at.repo}~${entry.sha256}`
    : `event~${entry.at.owner}~${entry.at.repo}~${entry.id}`

// The entry's JSON is written last, by rename, so a drain never finds an entry without its bytes.
// Fails with why the entry could not be kept, such as a full disk.
const put = (entry: Entry, bytes?: string) =>
  Effect.tryPromise({
    try: async () => {
      const base = join(dir(), name(entry))
      await mkdir(dir(), { recursive: true })
      if (bytes !== undefined) {
        await copyFile(bytes, `${base}.bytes.tmp`)
        await rename(`${base}.bytes.tmp`, `${base}.bytes`)
      }
      await writeFile(`${base}.json.tmp`, `${JSON.stringify(entry)}\n`)
      await rename(`${base}.json.tmp`, `${base}.json`)
    },
    catch: (error) => `the outbox could not keep it: ${String(error)}`,
  })

export const keepRecording = (entry: Omit<Recording, "kind">, path: string) =>
  put({ kind: "recording", ...entry }, path)
export const keepEvent = (entry: Omit<Event, "kind">) => put({ kind: "event", ...entry })

const send = (entry: Entry, base: string) =>
  entry.kind === "recording" ? Effect.asVoid(upload({ ...entry, path: `${base}.bytes` })) : notify(entry)

const what = (entry: Entry) =>
  entry.kind === "recording"
    ? `the recording ${entry.sha256.slice(0, 12)} of ${entry.at.owner}/${entry.at.repo}`
    : `the event ${entry.id.slice(0, 12)} of ${entry.at.owner}/${entry.at.repo}`

// Send every entry, best effort. An entry the feed refuses is dropped, with why, since asking
// again changes nothing. Returns how many went and how many still wait, with why the first of
// those did not go.
export const drain = Effect.gen(function* () {
  const names = yield* Effect.promise(() => readdir(dir()).catch(() => [] as string[]))
  let sent = 0
  const waiting: string[] = []
  const down = new Map<string, string>() // feeds that did not answer this run, and why
  for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
    const base = join(dir(), file.slice(0, -".json".length))
    const entry = yield* Effect.promise(() =>
      readFile(`${base}.json`, "utf8").then(
        (text) => JSON.parse(text) as Entry,
        () => undefined,
      ),
    )
    if (entry === undefined) continue // another land sent it first
    const skipped = down.get(entry.feed)
    if (skipped !== undefined) {
      waiting.push(skipped)
      continue
    }
    const failure = yield* send(entry, base).pipe(
      Effect.as(undefined),
      Effect.catch((failure: Failure) => Effect.succeed(failure)),
    )
    if (failure?.kind === "unreachable") down.set(entry.feed, failure.why)
    if (failure !== undefined && failure.kind !== "refused") {
      waiting.push(failure.why)
      continue
    }
    if (failure?.kind === "refused") console.log(`land: outbox dropped ${what(entry)}: ${failure.why}`)
    else sent++
    yield* Effect.promise(() =>
      Promise.all([rm(`${base}.json`, { force: true }), rm(`${base}.bytes`, { force: true })]),
    )
  }
  return { sent, waiting: waiting.length, why: waiting[0] }
})
