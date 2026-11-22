import { describe, expect, test } from "bun:test"
import { isReviewDoc, parseReviewDoc, validateReviewDoc } from "../src/review-doc.ts"
import type { ReviewChangedFile } from "../src/schema.ts"

const sampleMapDoc = `---
land: review
frame: map
---

# Decide changes inside one transaction

Both reads now sit inside one write transaction.

> [!IMPORTANT]
> One line changes behavior: \`compareRecords\` uses structural equality.

\`\`\`mermaid before
sequenceDiagram
  participant poll as PR poll<br/>daemon.go
  participant store as Store<br/>store.go
  poll->>store: ListPRs()
  poll->>store: ReplacePRs()
\`\`\`

\`\`\`mermaid after
sequenceDiagram
  participant poll as PR poll<br/>daemon.go
  participant store as Store<br/>store.go
  Note over poll,store: Both reads sit inside the write transaction.
  poll->>store: ReplacePRs()
  %% stop: src/daemon.ts:10-20
  Note over poll,store: one call does all of it
  critical one transaction
    store->>store: queryRecords
    %% stop: src/store.ts:5-15
    Note right of store: first read
  end
\`\`\`

## Poll calls replace

### src/daemon.ts:10-20

- L12: Removed extra read.
  Continued on next line.

## Store compares records

### src/store.ts:5-15

- L9!: Look here — structural compare replaces JSON compare.

## Not shown

- test/store.test.ts: updated fixture return value.
`

const changedFiles: ReviewChangedFile[] = [
  { path: "src/daemon.ts", status: "modified", added: 4, removed: 6, binary: false, oldPath: null },
  { path: "src/store.ts", status: "modified", added: 8, removed: 2, binary: false, oldPath: null },
  { path: "test/store.test.ts", status: "modified", added: 1, removed: 1, binary: false, oldPath: null },
]

describe("review-doc grammar and validation", () => {
  test("parses valid map review document with before/after flows, stops, notes, and coverage", () => {
    expect(isReviewDoc(sampleMapDoc)).toBe(true)
    const parsed = parseReviewDoc(sampleMapDoc)
    expect(parsed.problems).toEqual([])
    expect(parsed.title).toBe("Decide changes inside one transaction")
    expect(parsed.stops).toHaveLength(2)
    expect(parsed.stops[0]!.notes[0]!.text).toBe("Removed extra read. Continued on next line.")
    expect(parsed.stops[1]!.notes[0]!.look).toBe(true)
    expect(parsed.flows).toHaveLength(2)
    expect(parsed.flows[0]!.side).toBe("before")
    expect(parsed.flows[1]!.side).toBe("after")
    expect(parsed.flows[1]!.groups).toHaveLength(1)

    const lineCounts = new Map([
      ["src/daemon.ts", 50],
      ["src/store.ts", 40],
      ["test/store.test.ts", 30],
    ])
    const bundle = validateReviewDoc(sampleMapDoc, { files: changedFiles, lineCounts })
    expect(bundle.problems).toEqual([])
    expect(bundle.frame).toBe("map")
    expect(bundle.offeredFrames).toEqual(["brief", "walkthrough", "map"])
    expect(bundle.flows[1]!.messages[0]!.stopLine).toBe(bundle.stops[0]!.headingLine)
    expect(bundle.flows[1]!.messages[1]!.stopLine).toBe(bundle.stops[1]!.headingLine)
    expect(bundle.coverage.totalFiles).toBe(3)
    expect(bundle.coverage.shownFiles).toBe(2)
  })

  test("reports missing file coverage, out-of-range notes, and undrawable mermaid lines", () => {
    const bad = `---
frame: map
---

# Bad doc

\`\`\`mermaid
sequenceDiagram
  activate a
  a->>b: call
  %% stop: src/missing.ts:1-5
\`\`\`

## Step

### src/daemon.ts:10-15

- L99: outside stop
`
    const bundle = validateReviewDoc(bad, {
      files: changedFiles,
      lineCounts: new Map([["src/daemon.ts", 20]]),
    })
    expect(bundle.frame).toBe("brief") // falls back because map cannot be filled
    expect(bundle.offeredFrames).toEqual(["brief", "walkthrough"])
    expect(bundle.problems.some((p) => p.message.includes("activate a"))).toBe(true)
    expect(bundle.problems.some((p) => p.message.includes("outside the stop"))).toBe(true)
    expect(bundle.problems.some((p) => p.message.includes("names lines no stop shows"))).toBe(true)
    expect(bundle.problems.some((p) => p.message.includes("neither shown by a stop nor listed"))).toBe(true)
  })
})
