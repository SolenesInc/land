# Guide and help

`land guide` prints the procedure around a landing: branch, commit, check,
review, note, land, report and what to do after the push. `land guide review` and
`land guide sheriff` print the procedures that keep `main` healthy after a
landing: review what landed, and get a red `main` green. Any runner follows
them, so they name no attn command. A repository's guidance needs two lines
that point to `land guide`, and holds no copy. `land --help` says what the command takes and what
`land.toml` holds.

## Sub-features

- `guide-print` prints the procedure. It names no repository.
- `guide-review` prints the review procedure. It names
  `.agents/land/review.md` and no attn command.
- `guide-sheriff` prints the sheriff procedure. It names
  `.agents/land/sheriff.md` and no attn command.
- `help` prints the usage and the keys of `land.toml`.
- `version` prints `land <version>`.
- `unknown-arguments` prints what it did not understand and the help, and
  exits 2.

## How to get to it

### People

- Run `land guide`, `land --help` or `land --version` anywhere, inside a
  repository or not (`src/main.ts`, `src/guide.md`).
- Run `land guide review` or `land guide sheriff` anywhere
  (`src/guide-review.md`, `src/guide-sheriff.md`).

### Agents

- A repository's guidance says "Before you land a change, run `land guide` and
  follow it." `land init` writes those two lines; see [Init](init.md).
- A runner's prompt says "run `land guide sheriff` (or `land guide review`)
  and follow it". The README's "Keep main healthy" section gives the prompt
  for each runner.

### Triggers

- A Claude Code routine, a GitHub Actions workflow or an attn automation
  starts an agent with that prompt on a CI completion or a schedule. `land`
  sees only the command.

## Driving it

Preconditions:

- A fresh run, `r`.

- **The guide.** Run `drive.ts r do home 'land guide'`. It starts with
  `# Land on main` and has the sections Branch, Commit, Check, Review, Note,
  Land, Report and After the push. It exits 0.
- **The review and sheriff procedures.** Run
  `drive.ts r do home 'land guide review'` and
  `drive.ts r do home 'land guide sheriff'`. They start with `# Review main`
  and `# Sheriff`, name `.agents/land/review.md` and `.agents/land/sheriff.md`,
  and exit 0. The review procedure has the section "Post each finding to the
  feed" with `land event <sha> --kind finding`; the sheriff procedure has
  `land event <repair sha> --kind repair` with `--repairs`. Run
  `grep -nw attn` on each saved output: it prints nothing.
  The `Attn-Seed:` and `Attn-Session:` trailer names are expected.
- **Version and help.** Run `drive.ts r do home 'land --version'`: it prints
  `land <version>`, the version in `package.json`. Run
  `drive.ts r do home 'land --help'`: it lists `land`, `land --note <file>`,
  `land init`, `land guide`, `land guide review`, `land guide sheriff`,
  `land record`, `land event`, `land bug`, `land bugs`, `land show`,
  `land comments`, `land review check`, `land brief`, `land auth`,
  `land --help`, `land --version`, and the keys `gate`, `main`, `resolve`,
  `feed` and `record`.
- **Unknown arguments.** Run `drive.ts r do home 'land nonsense'`. It prints
  `land: unknown arguments: nonsense` and the help, and exits 2.
- **Proof.** The saved guides, the grep, and the saved output of the three
  commands.

## Contexts

- **The repository's own configuration.** `land guide` and `land --version`
  must work in a repository whose `bunfig.toml` would stop a Bun program. The
  last step of [Declaration](declaration.md) covers it.

## Tests

- `test/land.test.ts`: "land loads no configuration from the repository it
  runs in" runs `land --version`. "land guide review and land guide sheriff
  print procedures that any runner can follow" checks their headings, their
  specifics file, and that they name no attn command. Nothing else tests the
  guides' text.

## Gotchas

- The guide is what agents in every repository follow. When a change alters
  what `land` prints, refuses or installs, read the guide's Land section
  against the new behavior in the same landing.
- A lander gets the guide of the `land` they installed, not of `main`. A
  change to the guide reaches them with the next release.
