# Init

`land init` adopts `land` in a repository. It writes `land.toml` with a gate it
proposes from what the repository has, and adds the trunk declaration, the two
lines that point agents to `land guide`, to the repository's guidance. It
prints what it wrote and what the person must decide, and it never overwrites
either file.

## Sub-features

- `init-gate` proposes the gate: a `check` script in `package.json`, a `check`
  target in the `Makefile`, a `test` script, a `test` target, `go test ./...`
  for a `go.mod`, `cargo test` for a `Cargo.toml`, in that order. The script's
  runner follows the lockfile: `bun`, `pnpm`, `yarn`, else `npm`. It skips
  the test script `npm init` writes, which always fails.
- `init-broken-package` stops with `land: package.json: <error>` and writes
  nothing when `package.json` does not parse.
- `init-no-gate` writes no `land.toml` when it finds no check, and says to name
  the gate.
- `init-keep` leaves an existing `land.toml` as it is, and reads its `main`
  for the declaration.
- `init-declare` appends the declaration under `## Landing` to `AGENTS.md`, or
  to `CLAUDE.md` when only that exists, or creates `AGENTS.md` when neither
  does. A file that already holds `` `land guide` `` is left alone.
- `init-branch` writes `main = "<branch>"` and names that branch in the
  declaration when `origin`'s HEAD is not `main`.
- `init-hooks` installs the [Push hook](push-hook.md) and the
  [Trailer hook](trailer-hook.md), and prints
  `land: hooks      installed pre-push and prepare-commit-msg`, so commits made
  before the first `land` carry trailers too. It prints nothing for a hook
  already there.
- `init-again` changes nothing on a second run, and prints `Nothing changed.`

## How to get to it

### People

- Run `land init` in a clone (`src/init.ts`). The README's "Adopt land in a
  repository" shows its output. `land --help` lists it.

### Agents

- The same command. `land guide` says a repository adopts `land` with it.

## Driving it

Preconditions:

- A fresh run, `r`. The world's `lander` already has a `land.toml`, so the
  first step removes it.

- **Adopt.** Run
  `drive.ts r do lander 'git rm -q land.toml && printf "check:\n\tsh gate.sh\n" > Makefile && git add Makefile && git commit -qm "A Makefile with a check" && land init'`.
  It prints `land: land.toml  wrote gate = "make check", from the check target in the Makefile`,
  `land: AGENTS.md  created with the trunk declaration`, a Decide list about
  the gate's speed, and `Then commit land.toml and AGENTS.md`. Exit 0.
- **Read what it wrote.** Run
  `drive.ts r do lander 'cat land.toml AGENTS.md'`: `gate = "make check"`,
  then the two lines that name `main` and `land guide`.
- **Again.** Run `drive.ts r do lander 'land init'`. It says `land.toml`
  exists and `AGENTS.md` already declares land, then `Nothing changed.`
- **Land it.** Run
  `drive.ts r do lander 'git add land.toml AGENTS.md && git commit -qm "Land with land" && land'`.
  It prints `land: gate   make check   ok in` and `land: push   main is at <head>`.
  Run `drive.ts r do origin.git 'git log --format="%h %s" -2 main'`: `main`
  holds `Land with land`.
- **An existing land.toml.** In a fresh run, run
  `drive.ts r do lander 'cp land.toml ../before.toml; echo "# Project" > CLAUDE.md && git add CLAUDE.md && git commit -qm guidance && land init && cmp land.toml ../before.toml && tail -3 CLAUDE.md'`.
  It says `land.toml` exists, adds the declaration to `CLAUDE.md`, and `cmp`
  finds `land.toml` unchanged.
- **Proof.** The saved output of each `land init`, the file contents, the
  landing, and the second view of `main`.

## Contexts

- **A branch other than `main`.** The clone's `origin/HEAD` decides it; a
  clone without one gets `main`. The test
  "land init names the branch origin lands on when it is not main" covers it.

## Tests

- `test/land.test.ts`: "land init writes land.toml and the trunk declaration,
  and the repository then lands", "a second land init changes nothing",
  "land init leaves an existing land.toml as it is", "land init proposes the
  gate from what the repository has", "land init names the branch origin lands
  on when it is not main", "land init names a package.json it cannot parse,
  and writes nothing", "land init installs the hooks, so a commit before the
  first land names its session".

## Gotchas

- `land init` commits nothing. `land` refuses a dirty worktree, so the person
  commits the files, then lands that commit.
- Working but wrong: a proposed gate that is the whole slow suite. `land init`
  cannot time it; it says to decide, and the person reads that line.
- The declaration is found by `` `land guide` `` anywhere in the file, so a
  hand-written declaration wrapped across lines counts.
