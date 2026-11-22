import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { LandFailed } from "./failure.ts"

export const usage = `land auth token <token | ->   save a land-feed API token (~/.config/land/token)
land auth status              show whether a feed API token is configured
land auth logout              remove the saved feed API token`

export const tokenPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "land", "token")

// Reads LAND_FEED_TOKEN first, then ~/.config/land/token. Returns undefined when neither is set.
export const feedToken = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const fromEnv = process.env.LAND_FEED_TOKEN?.trim()
    if (fromEnv) return fromEnv
    return yield* Effect.promise(() =>
      readFile(tokenPath(), "utf8").then(
        (text) => text.trim() || undefined,
        () => undefined,
      ),
    )
  })

export const auth = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sub, value, ...rest] = args
    if (sub === "status" && value === undefined) {
      const fromEnv = process.env.LAND_FEED_TOKEN?.trim()
      if (fromEnv) return console.log("land: auth   LAND_FEED_TOKEN is set")
      const saved = yield* Effect.promise(() =>
        readFile(tokenPath(), "utf8").then(
          (text) => text.trim(),
          () => "",
        ),
      )
      if (saved) return console.log(`land: auth   token saved at ${tokenPath()}`)
      return console.log("land: auth   no feed token configured (set LAND_FEED_TOKEN or run `land auth token <token>`)")
    }
    if (sub === "logout" && value === undefined) {
      yield* Effect.promise(() => rm(tokenPath(), { force: true }))
      return console.log(`land: auth   removed ${tokenPath()}`)
    }
    if (sub === "token" && value !== undefined && rest.length === 0) {
      const raw = value === "-" ? yield* Effect.promise(() => new Response(Bun.stdin.stream()).text()) : value
      const token = raw.trim()
      if (!token) return yield* new LandFailed({ message: "auth: token is empty", status: 2 })
      const path = tokenPath()
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, `${token}\n`, { mode: 0o600 })
          await chmod(path, 0o600)
        },
        catch: (error) => new LandFailed({ message: `auth: could not write ${path}: ${String(error)}` }),
      })
      return console.log(`land: auth   saved token to ${path}`)
    }
    return yield* new LandFailed({
      message: `auth: unexpected arguments\nUsage:\n  ${usage.replaceAll("\n", "\n  ")}`,
      status: 2,
    })
  })
