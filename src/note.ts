import { readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect } from "effect"
import { LandFailed } from "./failure.ts"
import { succeeds } from "./git.ts"
import { landDir } from "./land-dir.ts"

export type Note = {
  readonly shown: string // the path as the lander knows it
  readonly path: string
  readonly text: string
}

// The note the lander wrote: the file --note names, or .land/note.md when it exists.
export const findNote = (root: string, named: string | undefined) =>
  Effect.gen(function* () {
    const shown = named ?? `${landDir}/note.md`
    const path = named === undefined ? `${root}/${shown}` : resolve(named)
    const text = yield* Effect.promise(() => readFile(path, "utf8").catch(() => undefined))
    if (text === undefined) {
      if (named === undefined) return undefined
      return yield* new LandFailed({ message: `--note ${named}: no such file` })
    }
    // land deletes the note after the push, which would leave a tracked one as a change.
    if (yield* succeeds("ls-files", "--error-unmatch", "--", path)) {
      return yield* new LandFailed({
        message: `the note ${shown} is committed, and land deletes the note after the push; write it in a file git does not track`,
      })
    }
    return { shown, path, text } satisfies Note
  })

export const deleteNote = (note: Note) => Effect.promise(() => rm(note.path, { force: true }))
