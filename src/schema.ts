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
  acknowledgedFlake: Schema.optionalKey(
    Schema.Struct({
      test: Schema.String,
      owner: Schema.String,
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

export const BugSeverity = Schema.Literals(["p0", "p1", "p2"])
export type BugSeverity = typeof BugSeverity.Type

export const BugSource = Schema.Literals(["agent", "review", "ci", "prod", "human"])
export type BugSource = typeof BugSource.Type

export const CodeLocation = Schema.Struct({
  path: Schema.String,
  line: Schema.optionalKey(Schema.Number),
})
export type CodeLocation = typeof CodeLocation.Type

// One fact about a landing that arrives after its push. land event, land bug and land brief write it.
export const Event = Schema.Struct({
  kind: Schema.String, // "stage" | "read" | "review" | "finding" | "repair" | "bug" | "review-doc" | a new kind
  state: Schema.Literals(["pass", "fail", "run", "info"]),
  title: Schema.String, // one line the timeline shows
  at: Schema.String, // ISO time
  url: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String), // markdown, shown folded (or review document markdown for "review-doc")
  repairs: Schema.optionalKey(Schema.String), // kind "repair": the sha it repairs
  severity: Schema.optionalKey(BugSeverity), // kind "bug": p0 | p1 | p2
  source: Schema.optionalKey(BugSource), // kind "bug": how the bug was found
  location: Schema.optionalKey(CodeLocation), // kind "bug" / "finding": pinned file:line
  culprit: Schema.optionalKey(Schema.String), // exact culprit commit sha (may be interior to a multi-commit landing)
})
export type Event = typeof Event.Type

// Post-landing human review state, comments, review documents (attn grammar), and bug summaries.

export const ReviewFrame = Schema.Literals(["brief", "walkthrough", "map"])
export type ReviewFrame = typeof ReviewFrame.Type

export const ReviewStatus = Schema.Literals(["unreviewed", "reviewed", "flagged", "skipped"])
export type ReviewStatus = typeof ReviewStatus.Type

export const CommentKind = Schema.Literals(["comment", "question", "concern", "nit"])
export type CommentKind = typeof CommentKind.Type

export const CommentStatus = Schema.Literals(["open", "resolved"])
export type CommentStatus = typeof CommentStatus.Type

export const CommentSide = Schema.Literals(["additions", "deletions"])
export type CommentSide = typeof CommentSide.Type

export const ReviewState = Schema.Struct({
  status: ReviewStatus,
  viewedFiles: Schema.Array(Schema.String),
  updatedAt: Schema.Number,
})
export type ReviewState = typeof ReviewState.Type

export const ReviewComment = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  head: Schema.String,
  author: Schema.String,
  path: Schema.NullOr(Schema.String),
  side: Schema.NullOr(CommentSide),
  lineStart: Schema.NullOr(Schema.Number),
  lineEnd: Schema.NullOr(Schema.Number),
  kind: CommentKind,
  body: Schema.String,
  status: CommentStatus,
  resolvedBy: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.Number),
  resolvedBySha: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type ReviewComment = typeof ReviewComment.Type

export const ReviewProblem = Schema.Struct({
  line: Schema.Number,
  message: Schema.String,
})
export type ReviewProblem = typeof ReviewProblem.Type

export const ReviewNote = Schema.Struct({
  line: Schema.Number,
  from: Schema.Number,
  to: Schema.Number,
  look: Schema.Boolean,
  text: Schema.String,
})
export type ReviewNote = typeof ReviewNote.Type

export const ReviewStop = Schema.Struct({
  headingLine: Schema.Number,
  path: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
  notes: Schema.Array(ReviewNote),
})
export type ReviewStop = typeof ReviewStop.Type

export const ReviewFlowParticipant = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  actor: Schema.Boolean,
})
export type ReviewFlowParticipant = typeof ReviewFlowParticipant.Type

export const ReviewFlowGroup = Schema.Struct({
  line: Schema.Number,
  kind: Schema.String,
  label: Schema.String,
  firstMessage: Schema.Number,
  lastMessage: Schema.Number,
  block: Schema.NullOr(Schema.Number),
})
export type ReviewFlowGroup = typeof ReviewFlowGroup.Type

export const ReviewFlowMessage = Schema.Struct({
  line: Schema.Number,
  from: Schema.String,
  to: Schema.String,
  arrow: Schema.String,
  text: Schema.String,
  note: Schema.NullOr(Schema.String),
  stopLine: Schema.NullOr(Schema.Number),
})
export type ReviewFlowMessage = typeof ReviewFlowMessage.Type

export const ReviewFlow = Schema.Struct({
  line: Schema.Number,
  side: Schema.NullOr(Schema.Literals(["before", "after"])),
  drawn: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
  participants: Schema.Array(ReviewFlowParticipant),
  messages: Schema.Array(ReviewFlowMessage),
  groups: Schema.Array(ReviewFlowGroup),
})
export type ReviewFlow = typeof ReviewFlow.Type

export const ReviewNotShown = Schema.Struct({
  line: Schema.Number,
  path: Schema.String,
  reason: Schema.String,
})
export type ReviewNotShown = typeof ReviewNotShown.Type

export const ReviewChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  binary: Schema.Boolean,
  oldPath: Schema.NullOr(Schema.String),
})
export type ReviewChangedFile = typeof ReviewChangedFile.Type

export const ReviewDocBundle = Schema.Struct({
  frame: ReviewFrame,
  offeredFrames: Schema.Array(ReviewFrame),
  title: Schema.NullOr(Schema.String),
  stops: Schema.Array(ReviewStop),
  flows: Schema.Array(ReviewFlow),
  notShown: Schema.Array(ReviewNotShown),
  files: Schema.Array(ReviewChangedFile),
  problems: Schema.Array(ReviewProblem),
  coverage: Schema.Struct({
    totalFiles: Schema.Number,
    shownFiles: Schema.Number,
    totalChangedLines: Schema.Number,
    coveredChangedLines: Schema.Number,
  }),
})
export type ReviewDocBundle = typeof ReviewDocBundle.Type

export const BugSummary = Schema.Struct({
  source: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  head: Schema.String,
  culprit: Schema.String,
  landingTitle: Schema.NullOr(Schema.String),
  title: Schema.String,
  severity: BugSeverity,
  bugSource: BugSource,
  location: Schema.NullOr(CodeLocation),
  detail: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  at: Schema.String,
  pushedAt: Schema.NullOr(Schema.Number),
  fixedBy: Schema.NullOr(Schema.String),
  fixedAt: Schema.NullOr(Schema.String),
})
export type BugSummary = typeof BugSummary.Type
