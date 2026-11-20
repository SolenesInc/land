import { mkdir, readdir, readFile, appendFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { constants } from "node:os"
import { Effect } from "effect"
import { readDeclaration } from "./declaration.ts"
import { LandFailed } from "./failure.ts"
import { gitOk } from "./git.ts"

const land = ".land"

// land keeps its files in .land/, which no repository commits an ignore rule for: the
// clone's exclude file hides it from the untracked-file check.
export const excludeLandDir = Effect.gen(function* () {
  const path = yield* gitOk("rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
  const text = yield* Effect.promise(() => readFile(path, "utf8").catch(() => ""))
  if (text.split("\n").includes(`${land}/`)) return
  yield* Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}${land}/\n`)
  })
})

// A file counts as recorded when the command created it or wrote it again.
const snapshot = (dir: string) =>
  Effect.promise(async () => {
    const files = new Map<string, number>()
    for (const name of await readdir(dir)) files.set(name, (await stat(join(dir, name))).mtimeMs)
    return files
  })

const link = (name: string) => `![${name.replace(/\.[^.]*$/, "")}](${land}/media/${name})`

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
    const media = join(root, land, "media")
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
