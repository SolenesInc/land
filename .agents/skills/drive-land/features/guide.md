# Guide and help

`land guide` prints the procedure around a landing: branch, commit, check,
review, land and report. A repository's guidance needs two lines that point to
it, and holds no copy. `land --help` says what the command takes and what
`land.toml` holds.

## Sub-features

- `guide-print` prints the procedure. It names no repository.
- `help` prints the usage and the keys of `land.toml`.
- `version` prints `land <version>`.
- `unknown-arguments` prints what it did not understand and the help, and
  exits 2.

## How to get to it

### People

- Run `land guide`, `land --help` or `land --version` anywhere, inside a
  repository or not (`src/main.ts`, `src/guide.md`).

### Agents

- A repository's guidance says "Before you land a change, run `land guide` and
  follow it." The README's "Adopt land in a repository" gives those two lines.

## Driving it

Preconditions:

- A fresh run, `r`.

- **The guide.** Run `drive.ts r do home 'land guide'`. It starts with
  `# Land on main` and has the sections Branch, Commit, Check, Review, Land
  and Report. It exits 0.
- **Version and help.** Run `drive.ts r do home 'land --version'`: it prints
  `land <version>`, the version in `package.json`. Run
  `drive.ts r do home 'land --help'`: it lists `land`, `land guide`,
  `land --help`, `land --version`, and the keys `gate` and `main`.
- **Unknown arguments.** Run `drive.ts r do home 'land nonsense'`. It prints
  `land: unknown arguments: nonsense` and the help, and exits 2.
- **Proof.** The saved guide, and the saved output of the three commands.

## Contexts

- **The repository's own configuration.** `land guide` and `land --version`
  must work in a repository whose `bunfig.toml` would stop a Bun program. The
  last step of [Declaration](declaration.md) covers it.

## Tests

- `test/land.test.ts`: "land loads no configuration from the repository it
  runs in" runs `land --version`. Nothing tests the guide's text.

## Gotchas

- The guide is what agents in every repository follow. When a change alters
  what `land` prints, refuses or installs, read the guide's Land section
  against the new behavior in the same landing.
- A lander gets the guide of the `land` they installed, not of `main`. A
  change to the guide reaches them with the next release.
