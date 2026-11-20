import { mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { constants } from "node:os"
import { Effect } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { gitOk } from "./git.ts"
import { excludeLandDir, landDir } from "./land-dir.ts"

// A file counts as recorded when the command created it or wrote it again. The media
// directory is flat: a directory or a dotfile in it is not a recording.
const snapshot = (dir: string) =>
  Effect.promise(async () => {
    const files = new Map<string, number>()
    for (const name of await readdir(dir)) {
      const info = await stat(join(dir, name))
      if (info.isFile() && !name.startsWith(".")) files.set(name, info.mtimeMs)
    }
    return files
  })

const link = (name: string) => `![${name.replace(/\.[^.]*$/, "")}](${landDir}/media/${encodeURIComponent(name)})`

export const record = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const root = yield* gitOk("rev-parse", "--show-toplevel")
    const { record } = yield* readDeclaration(root)
    if (record === undefined) {
      return yield* new LandFailed({
        message: `land.toml names no record command; add the key, for example:
  record = "scripts/record.sh"   a shell command that writes recordings into $LAND_MEDIA`,
      })
    }
    const media = join(root, landDir, "media")
    yield* Effect.promise(() => mkdir(media, { recursive: true }))
    yield* excludeLandDir
    const before = yield* snapshot(media)

    // The recordings' markdown is land's whole stdout, so the command's own stdout goes to stderr.
    const { status, signal } = yield* Effect.promise(async () => {
      const child = Bun.spawn(["sh", "-c", `${record} "$@"`, "land", ...args], {
        cwd: root,
        stdio: ["inherit", 2, "inherit"],
        env: { ...process.env, LAND_MEDIA: media },
      })
      await child.exited
      return { status: child.exitCode, signal: child.signalCode }
    })
    if (status !== 0) {
      const exit = status ?? 128 + (typeof signal === "string" ? constants.signals[signal] : (signal ?? 0))
      return yield* new LandFailed({ message: `record   ${record}   failed with status ${exit}`, status: exit })
    }

    const after = yield* snapshot(media)
    const recorded = [...after].filter(([name, mtime]) => before.get(name) !== mtime).map(([name]) => name)
    for (const name of recorded.sort()) console.log(link(name))
  })
