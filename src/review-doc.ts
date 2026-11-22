import type {
  ReviewChangedFile,
  ReviewDocBundle,
  ReviewFlow,
  ReviewFlowGroup,
  ReviewFlowMessage,
  ReviewFrame,
  ReviewNote,
  ReviewNotShown,
  ReviewProblem,
  ReviewStop,
} from "./schema.ts"

// Pure TypeScript port of attn's review document grammar and validator (internal/review/grammar.go & bundle.go).
// Used both by `land review check` / `land brief` against a local repo and by `land-feed` to resolve & validate
// briefs generated via Claude API or pushed via `refs/land-events/`.

export type FrontmatterField = { readonly key: string; readonly value: string; readonly line: number }
export type Frontmatter = { readonly fields: FrontmatterField[]; readonly bodyStart: number }

type StopRef = { line: number; path: string; from: number; to: number }
type Caption = { line: number; text: string }

type ParsedStop = {
  line: number
  path: string
  from: number
  to: number
  notes: ReviewNote[]
}

type OpenFlowGroup = {
  line: number
  kind: string
  label: string
  first: number
  last: number
  block: number
}

type ParsedFlowMessage = {
  line: number
  from: string
  to: string
  arrow: string
  text: string
  ref: StopRef | null
  note: Caption | null
  section: number
}

type ParsedFlow = {
  line: number
  start: number
  side: "before" | "after" | null
  undrawable: number
  participants: { id: string; label: string; actor: boolean }[]
  messages: ParsedFlowMessage[]
  note: Caption | null
  groups: OpenFlowGroup[]
  open: OpenFlowGroup[]
}

export type ParsedReviewDoc = {
  meta: Frontmatter
  title: string | null
  stops: ParsedStop[]
  flows: ParsedFlow[]
  notShown: ReviewNotShown[]
  problems: ReviewProblem[]
}

const STOP_HEADING = /^(\S+):(\d+)(?:\s*[-–—]\s*(\d+))?$/
const NOTE_ITEM = /^- L(\d+)(?:\s*[-–—]\s*L?(\d+))?(!?):\s*(.*)$/
const NOTE_LIKE = /^\s*[-*+]\s*\**\s*[Ll]\s*\d/
const FLOW_MESSAGE_LINE = /^\s*([^\s%:;+-][^:;]*?)\s*(-{1,2}(?:>>|>|x|\)))([+-]?)\s*([^:;]+?)\s*:(.*)$/
const PARTICIPANT_LINE = /^\s*(participant|actor)\s+(.+?)(?:\s+as\s+(.+?))?\s*$/
const FLOW_STOP_NOTE = /^\s*%%\s*stop:\s*(.*?)\s*$/
const FLOW_NOTE_LINE = /^\s*note\s+(?:left\s+of|right\s+of|over)\s+([^:]+?)\s*:(.*)$/i
const FLOW_BLOCK_LINE = /^\s*(rect|opt|loop|alt|critical|par|break)(?:\s+(.*?))?\s*$/
const FLOW_SECTION_LINE = /^\s*(else|option|and)(?:\s+(.*?))?\s*$/
const FLOW_END_LINE = /^\s*end\s*$/
const FENCE = /^\s*(```+|~~~+)\s*(\S*)\s*(\S*)/

const SECTION_OF: Record<string, string> = { else: "alt", option: "critical", and: "par" }

export const splitLines = (text: string): string[] => {
  if (text === "") return []
  const normalized = text.replace(/\r\n/g, "\n")
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n")
}

export const parseFrontmatter = (lines: ReadonlyArray<string>): Frontmatter => {
  if (lines.length === 0 || lines[0]!.trim() !== "---") return { fields: [], bodyStart: 0 }
  const fields: FrontmatterField[] = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return { fields, bodyStart: i + 1 }
    const colon = lines[i]!.indexOf(":")
    if (colon !== -1) {
      fields.push({
        key: lines[i]!.slice(0, colon).trim(),
        value: lines[i]!.slice(colon + 1).trim(),
        line: i + 1,
      })
    }
  }
  return { fields: [], bodyStart: 0 }
}

export const metaGet = (meta: Frontmatter, key: string): FrontmatterField | undefined =>
  meta.fields.find((f) => f.key === key)

export const isReviewDoc = (text: string): boolean => {
  const meta = parseFrontmatter(splitLines(text))
  const attn = metaGet(meta, "attn")?.value
  const land = metaGet(meta, "land")?.value
  const frame = metaGet(meta, "frame")?.value
  return attn === "review" || land === "review" || frame === "brief" || frame === "walkthrough" || frame === "map"
}

const cleanPosix = (p: string): string => {
  const parts: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop()
      else parts.push("..")
    } else {
      parts.push(seg)
    }
  }
  return parts.join("/")
}

const stripBackticks = (s: string) => s.replace(/^`+|`+$/g, "")

const parseRange = (text: string): StopRef | null => {
  const match = stripBackticks(text.trim()).match(STOP_HEADING)
  if (!match) return null
  const from = Number.parseInt(match[2]!, 10)
  const to = match[3] ? Number.parseInt(match[3], 10) : from
  return { line: 0, path: match[1]!, from, to }
}

const sequenceDiagramAt = (lines: ReadonlyArray<string>, fenceMark: string): number | null => {
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (trimmed.startsWith(fenceMark)) return null
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter || trimmed === "" || trimmed.startsWith("%%")) continue
    return trimmed.startsWith("sequenceDiagram") ? i : null
  }
  return null
}

const ensureParticipant = (flow: ParsedFlow, rawId: string, rawLabel: string, actor: boolean): string => {
  const id = rawId.trim()
  const label = rawLabel.trim()
  const existing = flow.participants.find((p) => p.id === id)
  if (existing) {
    if (label !== "") existing.label = label
    existing.actor = existing.actor || actor
    return id
  }
  flow.participants.push({ id, label: label || id, actor })
  return id
}

const isSection = (g: OpenFlowGroup) => g.kind in SECTION_OF
const currentSection = (f: ParsedFlow) => (f.open.length === 0 ? 0 : f.open.at(-1)!.line)

export const parseReviewDoc = (text: string): ParsedReviewDoc => {
  const lines = splitLines(text)
  const doc: ParsedReviewDoc = {
    meta: parseFrontmatter(lines),
    title: null,
    stops: [],
    flows: [],
    notShown: [],
    problems: [],
  }
  const problem = (line: number, message: string) => doc.problems.push({ line, message })
  const flowProblem = (open: ParsedFlow, line: number, message: string) => {
    if (open.undrawable === 0) problem(line, message)
  }

  const closeGroup = (open: ParsedFlow) => {
    const group = open.open.pop()!
    if (group.first === 0) {
      flowProblem(
        open,
        group.line,
        `the \`${group.kind}\` on line ${group.line} holds no message, so there is nothing to draw it around. Put a message in it, or remove it.`,
      )
      return
    }
    open.groups.push(group)
  }

  const closeBlock = (open: ParsedFlow) => {
    if (isSection(open.open.at(-1)!)) closeGroup(open)
    closeGroup(open)
  }

  const closeFlow = (open: ParsedFlow, number: number) => {
    while (open.open.length > 0) {
      let block = open.open.at(-1)!
      if (isSection(block)) block = open.open[open.open.length - 2]!
      flowProblem(
        open,
        block.line,
        `the \`${block.kind}\` block on line ${block.line} has no \`end\`. Add \`end\` after its last message, before line ${number}.`,
      )
      closeBlock(open)
    }
    open.groups.sort((a, b) => a.line - b.line)
  }

  const handleFlowNote = (open: ParsedFlow, note: Caption) => {
    if (open.messages.length === 0 && currentSection(open) === 0) {
      if (open.note !== null) {
        flowProblem(
          open,
          note.line,
          `the diagram already has its caption on line ${open.note.line}, and a diagram has one. Merge the two notes.`,
        )
        return
      }
      open.note = note
      return
    }
    const last = open.messages.at(-1)
    if (!last || last.section !== currentSection(open)) {
      flowProblem(
        open,
        note.line,
        `a Note captions the message right before it in the same block, and this one has none. Move it under a message in its block, or put the text in the block's label.`,
      )
      return
    }
    if (last.note !== null) {
      flowProblem(
        open,
        note.line,
        `the message on line ${last.line} already has its caption on line ${last.note.line}, and a message has one. Merge the two notes.`,
      )
      return
    }
    last.note = note
  }

  const handleFlowSection = (open: ParsedFlow, section: OpenFlowGroup) => {
    const blockKind = SECTION_OF[section.kind]!
    let at = open.open.length - 1
    if (at >= 0 && isSection(open.open[at]!)) at--
    if (at < 0 || open.open[at]!.kind !== blockKind) {
      flowProblem(
        open,
        section.line,
        `\`${section.kind}\` divides a block opened by \`${blockKind}\`, and this line is inside none. Open the block with \`${blockKind}\`, or remove the line.`,
      )
      return
    }
    if (at < open.open.length - 1) closeGroup(open)
    section.block = open.open[at]!.line
    open.open.push(section)
  }

  const handleFlowLine = (open: ParsedFlow, line: string, number: number) => {
    const stopMatch = line.match(FLOW_STOP_NOTE)
    if (stopMatch) {
      if (open.messages.length === 0) {
        problem(number, "`%% stop:` comes before any message. Put it on the line after the message it ties to a stop.")
        return
      }
      const last = open.messages.at(-1)!
      const ref = parseRange(stopMatch[1]!)
      if (!ref) {
        problem(number, `\`%% stop: ${stopMatch[1]}\` does not name a range. Write \`%% stop: path:from-to\`.`)
        return
      }
      ref.line = number
      if (last.ref !== null) {
        problem(
          number,
          `the message on line ${last.line} is already tied to a stop by \`%% stop:\` on line ${last.ref.line}, and a message ties to one stop. Tie these lines to a message of their own, or widen that stop.`,
        )
        return
      }
      last.ref = ref
      return
    }
    const msgMatch = line.match(FLOW_MESSAGE_LINE)
    if (msgMatch) {
      const from = ensureParticipant(open, msgMatch[1]!, "", false)
      const to = ensureParticipant(open, msgMatch[4]!, "", false)
      open.messages.push({
        line: number,
        from,
        to,
        arrow: msgMatch[2]!,
        text: msgMatch[5]!.trim(),
        ref: null,
        note: null,
        section: currentSection(open),
      })
      for (const g of open.open) {
        if (g.first === 0) g.first = number
        g.last = number
      }
      return
    }
    const partMatch = line.match(PARTICIPANT_LINE)
    if (partMatch) {
      ensureParticipant(open, partMatch[2]!, partMatch[3] ?? "", partMatch[1] === "actor")
      return
    }
    const noteMatch = line.match(FLOW_NOTE_LINE)
    if (noteMatch) {
      for (const id of noteMatch[1]!.split(",")) ensureParticipant(open, id, "", false)
      handleFlowNote(open, { line: number, text: noteMatch[2]!.trim() })
      return
    }
    const blockMatch = line.match(FLOW_BLOCK_LINE)
    if (blockMatch) {
      open.open.push({
        line: number,
        kind: blockMatch[1]!,
        label: (blockMatch[2] ?? "").trim(),
        first: 0,
        last: 0,
        block: 0,
      })
      return
    }
    const secMatch = line.match(FLOW_SECTION_LINE)
    if (secMatch) {
      handleFlowSection(open, {
        line: number,
        kind: secMatch[1]!,
        label: (secMatch[2] ?? "").trim(),
        first: 0,
        last: 0,
        block: 0,
      })
      return
    }
    if (FLOW_END_LINE.test(line)) {
      if (open.open.length === 0) {
        flowProblem(
          open,
          number,
          "`end` closes no block. Remove it, or open the block it ends with rect, opt, loop, alt, critical, par or break.",
        )
        return
      }
      closeBlock(open)
      return
    }
    const trimmed = line.trim()
    if (trimmed === "" || trimmed === "sequenceDiagram" || trimmed.startsWith("%%") || open.undrawable !== 0) return
    open.undrawable = number
    problem(
      number,
      `drawn sequence diagrams support participants, actors, messages, notes and the blocks rect, opt, loop, alt, critical, par and break; \`${trimmed}\` is outside that, so this diagram shows as a mermaid figure and the Map frame cannot walk it. Remove the line, or say it in the prose.`,
    )
  }

  let current: ParsedStop | null = null
  let lastNote: ReviewNote | null = null
  let inNotShown = false
  let fenceMark = ""
  let openFlow: ParsedFlow | null = null

  for (let i = doc.meta.bodyStart; i < lines.length; i++) {
    const line = lines[i]!
    const number = i + 1
    if (fenceMark !== "") {
      if (line.trim().startsWith(fenceMark)) {
        if (openFlow) closeFlow(openFlow, number)
        fenceMark = ""
        openFlow = null
        continue
      }
      if (openFlow && number > openFlow.start) handleFlowLine(openFlow, line, number)
      continue
    }
    const fenceMatch = line.match(FENCE)
    if (fenceMatch) {
      fenceMark = fenceMatch[1]!
      if (fenceMatch[2] === "mermaid") {
        const startOffset = sequenceDiagramAt(lines.slice(i + 1), fenceMark)
        if (startOffset !== null) {
          const side = fenceMatch[3] === "before" || fenceMatch[3] === "after" ? fenceMatch[3] : null
          openFlow = {
            line: number,
            start: number + 1 + startOffset,
            side,
            undrawable: 0,
            participants: [],
            messages: [],
            note: null,
            groups: [],
            open: [],
          }
          doc.flows.push(openFlow)
        }
      }
      lastNote = null
      continue
    }
    if (line.startsWith("## ")) {
      current = null
      lastNote = null
      inNotShown = line.slice(3).trim().toLowerCase() === "not shown"
      continue
    }
    if (line.startsWith("# ")) {
      if (doc.title === null) doc.title = line.slice(2).trim()
      current = null
      lastNote = null
      inNotShown = false
      continue
    }
    if (line.startsWith("### ")) {
      lastNote = null
      inNotShown = false
      const raw = line.slice(4).trim()
      const ref = parseRange(raw)
      if (!ref) {
        if (!/[ \t]/.test(raw) && /[./]/.test(raw)) {
          problem(
            number,
            `the stop ${raw} has no range. Write \`### ${stripBackticks(raw)}:<from>-<to>\` with lines at head.`,
          )
        }
        current = null
        continue
      }
      if (ref.path.startsWith("/") || ref.path !== cleanPosix(ref.path) || ref.path.startsWith("../")) {
        problem(number, `the stop path ${ref.path} must be relative to the repository root, like src/main.ts.`)
        current = null
        continue
      }
      let { from, to } = ref
      const written = stripBackticks(raw)
      if (to < from) {
        ;[from, to] = [to, from]
        if (from >= 1) problem(number, `the stop ${written} runs backwards. Write ${ref.path}:${from}-${to}.`)
      }
      if (from < 1) {
        from = 1
        to = Math.max(to, 1)
        problem(
          number,
          `the stop ${written} starts before line 1. Lines count from 1: write ${ref.path}:${from}-${to}.`,
        )
      }
      current = { line: number, path: ref.path, from, to, notes: [] }
      doc.stops.push(current)
      continue
    }
    if (inNotShown) {
      if (line.startsWith("- ")) {
        const item = line.slice(2)
        const sep = item.indexOf(": ")
        const path = stripBackticks((sep === -1 ? item : item.slice(0, sep)).trim())
        const reason = sep === -1 ? "" : item.slice(sep + 2).trim()
        doc.notShown.push({ line: number, path, reason })
      }
      continue
    }
    const noteMatch = line.match(NOTE_ITEM)
    if (noteMatch) {
      if (!current) {
        problem(
          number,
          `the note ${JSON.stringify(line)} sits outside a stop. Put it under a \`### path:from-to\` heading.`,
        )
        lastNote = null
        continue
      }
      let from = Number.parseInt(noteMatch[1]!, 10)
      let to = noteMatch[2] ? Number.parseInt(noteMatch[2], 10) : from
      if (to < from) {
        problem(number, `the note L${from}-${to} runs backwards. Write L${to}-${from}.`)
        ;[from, to] = [to, from]
      }
      const note: ReviewNote = { line: number, from, to, look: noteMatch[3] === "!", text: noteMatch[4]! }
      current.notes.push(note)
      lastNote = note
      continue
    }
    if (lastNote && line.startsWith("  ") && line.trim() !== "") {
      ;(lastNote as { text: string }).text += " " + line.trim()
      continue
    }
    lastNote = null
    if (current && NOTE_LIKE.test(line)) {
      problem(
        number,
        `${JSON.stringify(line.trim())} looks like a note but does not parse. Write \`- L12: text\`, \`- L12-14: text\`, or \`- L12!: text\` for the place to look.`,
      )
    }
  }
  if (openFlow) closeFlow(openFlow, lines.length + 1)
  return doc
}

export type ReviewValidationContext = {
  readonly files: ReadonlyArray<ReviewChangedFile>
  // Optional total line count at head (or base if deleted) for files referenced by stops.
  readonly lineCounts?: ReadonlyMap<string, number>
  // Optional per-file changed line numbers at head for exact line-coverage computation.
  readonly changedLineNumbers?: ReadonlyMap<string, ReadonlySet<number>>
}

const hasMap = (flows: ReadonlyArray<ReviewFlow>) =>
  flows.some((f) => f.drawn && f.messages.some((m) => m.stopLine !== null))

export const validateReviewDoc = (text: string, ctx: ReviewValidationContext): ReviewDocBundle => {
  const doc = parseReviewDoc(text)
  const problems: ReviewProblem[] = [...doc.problems]

  let frame: ReviewFrame = "brief"
  const frameField = metaGet(doc.meta, "frame")
  if (frameField && frameField.value !== "") {
    if (frameField.value === "brief" || frameField.value === "walkthrough" || frameField.value === "map") {
      frame = frameField.value
    } else {
      problems.push({
        line: frameField.line,
        message: `frame: ${frameField.value} is not a frame. Use brief, walkthrough or map.`,
      })
    }
  }

  // Validate stops & notes
  const stops: ReviewStop[] = []
  for (const s of doc.stops) {
    let to = s.to
    const maxLines = ctx.lineCounts?.get(s.path)
    if (maxLines !== undefined) {
      if (maxLines === 0) {
        problems.push({ line: s.line, message: `${s.path} is empty at head, so it has no lines to show.` })
        continue
      }
      if (s.from > maxLines) {
        problems.push({
          line: s.line,
          message: `the stop ${s.path}:${s.from}-${s.to} starts past the end of the file (${maxLines} lines). Use a range inside 1-${maxLines}.`,
        })
        continue
      }
      if (to > maxLines) {
        problems.push({
          line: s.line,
          message: `the stop ${s.path}:${s.from}-${s.to} ends past the file (${maxLines} lines). Use ${s.from}-${maxLines}.`,
        })
        to = maxLines
      }
    }
    const validNotes: ReviewNote[] = []
    for (const n of s.notes) {
      if (n.from < s.from || n.to > to) {
        const range = n.from === n.to ? `${n.from}` : `${n.from}-${n.to}`
        problems.push({
          line: n.line,
          message: `the note L${range} is outside the stop ${s.path}:${s.from}-${to}. Move it under a stop that shows those lines, or widen the range.`,
        })
        continue
      }
      validNotes.push(n)
    }
    stops.push({ headingLine: s.line, path: s.path, from: s.from, to, notes: validNotes })
  }

  // Resolve flows and link %% stop: refs
  const findStopShowing = (ref: StopRef) =>
    stops.find((s) => s.path === ref.path && s.from <= ref.from && ref.to <= s.to)

  const flows: ReviewFlow[] = doc.flows.map((f) => {
    const groups: ReviewFlowGroup[] = f.groups.map((g) => ({
      line: g.line,
      kind: g.kind,
      label: g.label,
      firstMessage: g.first,
      lastMessage: g.last,
      block: g.block === 0 ? null : g.block,
    }))
    const messages: ReviewFlowMessage[] = f.messages.map((m) => {
      let stopLine: number | null = null
      if (m.ref !== null) {
        const hit = findStopShowing(m.ref)
        if (hit) stopLine = hit.headingLine
        else {
          problems.push({
            line: m.ref.line,
            message: `\`%% stop: ${m.ref.path}:${m.ref.from}-${m.ref.to}\` names lines no stop shows. Add a stop \`### ${m.ref.path}:${m.ref.from}-${m.ref.to}\`, or name a range inside an existing stop of ${m.ref.path}.`,
          })
        }
      }
      return {
        line: m.line,
        from: m.from,
        to: m.to,
        arrow: m.arrow,
        text: m.text,
        note: m.note?.text ?? null,
        stopLine,
      }
    })
    return {
      line: f.line,
      side: f.side,
      drawn: f.undrawable === 0,
      note: f.note?.text ?? null,
      participants: f.participants,
      messages,
      groups,
    }
  })

  // Coverage check against changed files
  if (ctx.files.length > 0) {
    const accounted = new Set<string>(stops.map((s) => s.path))
    const changed = new Set<string>(ctx.files.map((f) => f.path))
    const coversDir = (dir: string) => ctx.files.some((f) => f.path.startsWith(`${dir}/`))
    for (const entry of doc.notShown) {
      const cleaned = entry.path.replace(/\/+$/, "")
      if (changed.has(cleaned) || coversDir(cleaned)) {
        accounted.add(cleaned)
      } else {
        problems.push({
          line: entry.line,
          message: `${entry.path} is listed under Not shown but did not change since base. Remove it.`,
        })
      }
    }
    const underNotShownDir = (path: string) =>
      doc.notShown.some((e) => path.startsWith(`${e.path.replace(/\/+$/, "")}/`))
    const missing = ctx.files.filter((f) => !accounted.has(f.path) && !underNotShownDir(f.path)).map((f) => f.path)
    if (missing.length > 0) {
      problems.push({
        line: 0,
        message: `${missing.length} changed ${missing.length === 1 ? "file is" : "files are"} neither shown by a stop nor listed under \`## Not shown\`: ${missing.join(", ")}. Add a stop, or list each as \`- path: why it is left out\`.`,
      })
    }
  }

  // Frame eligibility
  const offeredFrames: ReviewFrame[] = ["brief"]
  if (stops.length > 0) offeredFrames.push("walkthrough")
  if (hasMap(flows)) offeredFrames.push("map")

  if (frame === "walkthrough" && stops.length === 0) {
    problems.push({
      line: frameField?.line ?? 1,
      message:
        "frame: walkthrough steps through the stops, and the document has none, so the review opens in brief. Add a `### path:from-to` stop, or pick brief.",
    })
    frame = "brief"
  } else if (frame === "map" && !hasMap(flows)) {
    problems.push({
      line: frameField?.line ?? 1,
      message:
        "frame: map walks a sequence diagram's messages, and no drawn diagram has a message with `%% stop: path:from-to` after it, so the review opens in brief. Add one, or pick walkthrough or brief.",
    })
    frame = "brief"
  }

  // Coverage metrics
  const shownPaths = new Set(stops.map((s) => s.path))
  let totalChangedLines = 0
  let coveredChangedLines = 0
  if (ctx.changedLineNumbers) {
    for (const [path, lineSet] of ctx.changedLineNumbers) {
      totalChangedLines += lineSet.size
      const fileStops = stops.filter((s) => s.path === path)
      for (const ln of lineSet) {
        if (fileStops.some((s) => ln >= s.from && ln <= s.to)) coveredChangedLines++
      }
    }
  } else {
    for (const f of ctx.files) {
      const delta = f.added + f.removed
      totalChangedLines += delta
      if (shownPaths.has(f.path)) coveredChangedLines += delta
    }
  }

  problems.sort((a, b) => a.line - b.line)

  return {
    frame,
    offeredFrames,
    title: doc.title,
    stops,
    flows,
    notShown: doc.notShown,
    files: [...ctx.files],
    problems,
    coverage: {
      totalFiles: ctx.files.length,
      shownFiles: ctx.files.filter((f) => shownPaths.has(f.path)).length,
      totalChangedLines,
      coveredChangedLines,
    },
  }
}

export const REVIEW_DOC_GRAMMAR_PROMPT = `Write a review document in markdown with YAML frontmatter:
---
land: review
frame: brief | walkthrough | map
---

Grammar:
- \`# Title\`, then 2-4 sentences explaining what changed and why.
- Include a \`> [!IMPORTANT]\` callout naming the key behavioral change or risk, plus a concrete before/after example when helpful.
- Organize by \`## Step heading\` in the best reading order (not file order).
- Under steps, add stops as \`### path:from-to\` (1-based line numbers at head). Show the lines that carry the point, not whole files.
- Under a stop, annotate key lines with \`- L12: note\` (or \`- L12-14: note\`), and \`- L12!: note\` for the single most important place to look.
- Every changed file MUST either appear in at least one stop OR be listed under \`## Not shown\` as \`- path: reason\` (or \`- dir/: reason\`).
- Pick \`frame: map\` when the change is a flow across components and include a mermaid \`sequenceDiagram\` with \`%% stop: path:from-to\` right after messages tied to stops. Use \`\`\`mermaid before and \`\`\`mermaid after fences when showing before/after flows. Only use \`participant\`, \`actor\`, messages, \`Note\`, and blocks (\`rect\`, \`opt\`, \`loop\`, \`alt\`/\`else\`, \`critical\`/\`option\`, \`par\`/\`and\`, \`break\`, \`end\`) — never \`activate\` or \`autonumber\`.
- Pick \`frame: walkthrough\` when the change sits in 1-2 files. Pick \`frame: brief\` otherwise.`
