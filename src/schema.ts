import { Schema } from "effect"

// The schemas land and the feed share. The feed imports them from land at a pinned commit.

// landing.json in the commit of refs/landings/<head>: what land knew at the push.
export const LandingRecord = Schema.Struct({
  version: Schema.Literal(1),
  land: Schema.String, // land's version
  base: Schema.String, // the main commit the landing sits on
  head: Schema.String,
  gate: Schema.optionalKey(
    Schema.Struct({
      command: Schema.String,
      seconds: Schema.Number,
      ranOn: Schema.String, // differs from head when main moved after the gate
    }),
  ),
  // The recordings the note links, which the feed may accept for this landing.
  recordings: Schema.Array(
    Schema.Struct({
      sha256: Schema.String,
      ext: Schema.Literals(["png", "jpg", "gif", "webp", "mp4", "webm"]),
      bytes: Schema.Number,
    }),
  ),
})
export type LandingRecord = typeof LandingRecord.Type

// One fact about a landing that arrives after its push. land event will write it.
export const Event = Schema.Struct({
  kind: Schema.String, // "stage" | "read" | "review" | "finding" | "repair" | a new kind
  state: Schema.Literals(["pass", "fail", "run", "info"]),
  title: Schema.String, // one line the timeline shows
  at: Schema.String, // ISO time
  url: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String), // markdown, shown folded
  repairs: Schema.optionalKey(Schema.String), // kind "repair": the sha it repairs
})
export type Event = typeof Event.Type
