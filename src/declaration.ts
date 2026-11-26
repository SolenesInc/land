import { Effect, Schema } from "effect"
import { LandFailed } from "./failure.ts"

export const Declaration = Schema.Struct({
  main: Schema.optionalKey(Schema.String), // the branch landings push to; "main" when absent
  gate: Schema.optionalKey(Schema.String), // a shell command; absent skips the stage
  resolve: Schema.optionalKey(Schema.String), // a shell command run on rebase conflicts; exit 0 continues the rebase
  record: Schema.optionalKey(Schema.String), // a shell command that land record runs
  feed: Schema.optionalKey(Schema.String), // the feed that shows landings and hosts their recordings
  visual_paths: Schema.optionalKey(Schema.Array(Schema.String)), // path globs that require media (or --no-media)
  evidence_check: Schema.optionalKey(Schema.String), // a shell command run before the gate to check evidence
  require_note: Schema.optionalKey(Schema.Boolean), // when true, refuse to land without a note
})
export type Declaration = typeof Declaration.Type

export const file = "land.toml"

// An unknown key fails, so a misspelled stage never lands without running.
export const readDeclaration = (root: string) =>
  Effect.gen(function* () {
    const source = Bun.file(`${root}/${file}`)
    if (!(yield* Effect.promise(() => source.exists()))) {
      return yield* new LandFailed({ message: `no ${file} at ${root}; add one that names the gate` })
    }
    const text = yield* Effect.promise(() => source.text())
    const toml = yield* Effect.try({
      try: () => Bun.TOML.parse(text),
      catch: (error) => new LandFailed({ message: `${file}: ${String(error)}` }),
    })
    return yield* Schema.decodeUnknownEffect(Declaration)(toml, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => new LandFailed({ message: `${file}: ${error.message}` })),
    )
  })
