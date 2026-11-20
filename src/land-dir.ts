import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect } from "effect"
import { gitOk } from "./git.ts"

// The lander's folder in the worktree: the note, and the recordings land record makes.
export const landDir = ".land"

// No repository commits an ignore rule for .land/: the clone's exclude file, which every
// worktree of the clone shares, hides it from the untracked-file check.
export const excludeLandDir = Effect.gen(function* () {
  const path = yield* gitOk("rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
  const text = yield* Effect.promise(() => readFile(path, "utf8").catch(() => ""))
  if (text.split(/\r?\n/).includes(`${landDir}/`)) return
  yield* Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}${landDir}/\n`)
  })
})
