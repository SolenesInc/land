# Declaration

A repository tells `land` what its gate is in `land.toml`, at its root. The
gate is the fast check that must pass before a push. The file can also name a
branch other than `main` to land on.

## Sub-features

- `decl-gate` runs the `gate` command with `sh -c` at the repository root, and
  pushes only when it exits 0.
- `decl-no-gate` lands with no check when the file names no gate.
- `decl-main` lands on the branch that `main` names.
- `decl-resolve` runs the `resolve` command with `sh -c` at the repository
  root (with `LAND_BASE` set) when rebasing hits conflicts, continuing the
  rebase when it exits 0 and leaves no unmerged files.
- `decl-record` names the `record` command that `land record` runs; see
  [Record](record.md).
- `decl-feed` names the feed that shows landings and hosts their recordings;
  see [Feed](feed.md).
- `decl-missing` refuses to land in a repository with no `land.toml`.
- `decl-unknown-key` refuses a key it does not know, so a misspelled `gate`
  never lands unchecked.
- `decl-invalid` refuses a file that is not valid TOML, with the parser's
  message.
- `decl-own-config` reads no other configuration from the repository: not its
  `bunfig.toml`, `.env`, `tsconfig.json` or `package.json`.

## How to get to it

### People

- Write `land.toml` at the repository root and commit it
  (`src/declaration.ts`), or let `land init` write it (see [Init](init.md)).

### Agents

- The same file. `land --help` lists its keys.

## Driving it

Preconditions:

- A fresh run, `r`. Run the steps in order.

- **No declaration.** Run
  `drive.ts r do lander 'git rm -q land.toml && git commit -qm "No declaration"'`,
  then `drive.ts r do lander land`. It prints
  `land: no land.toml at <root>; add one that names the gate` and exits 1.
  Undo with `drive.ts r do lander 'git reset -q --hard HEAD~1'`.
- **A misspelled key.** Run
  `drive.ts r do lander 'echo "gaet = \"true\"" >> land.toml && git commit -qam "A misspelled key"'`,
  then `drive.ts r do lander land`. It prints
  `land: land.toml: Expected no excess property` and `at ["gaet"]`, and exits
  1. Undo with `drive.ts r do lander 'git reset -q --hard HEAD~1'`.
- **Invalid TOML.** Run
  `drive.ts r do lander 'echo "gate = " > land.toml && git commit -qam "Broken TOML"'`,
  then `drive.ts r do lander land`. It prints `land: land.toml: SyntaxError:`
  with the parser's reason, and exits 1. Undo with
  `drive.ts r do lander 'git reset -q --hard HEAD~1'`.
- **Another branch.** Run
  `drive.ts r do lander 'git push -q origin origin/main:refs/heads/trunk && echo "main = \"trunk\"" >> land.toml && git commit -qam "Land on trunk"'`,
  then `drive.ts r do lander land`. It prints
  `land: push   trunk is at <head>` and exits 0. Run
  `drive.ts r do origin.git 'git log --format="%h %s" -1 trunk && git log --format="%h %s" -1 main'`:
  `trunk` holds `Land on trunk`, and `main` still holds `Start`.
- **No gate.** Run
  `drive.ts r do lander 'git reset -q --hard origin/main && : > land.toml && git commit -qam "No gate"'`,
  then `drive.ts r do lander land`. It prints only
  `land: push   main is at <head>` and exits 0.
- **The repository's own configuration.** In a fresh run, run
  `drive.ts r do lander 'echo "preload = [\"./missing.ts\"]" > bunfig.toml && echo "FROM_DOTENV=set" > .env && echo "test -z \"\$FROM_DOTENV\"" > gate.sh && git add . && git commit -qm "A repository with its own Bun configuration" && land'`.
  `land` starts despite the preload that does not exist, the gate passes
  because it does not see `FROM_DOTENV`, and the landing exits 0.
- **Proof.** The saved output of each `land`, and the second view of `trunk`
  and `main`.

## Contexts

- **A branch other than `main`.** The hook that `land` installs names the
  branch of the first landing in the clone. See [Push hook](push-hook.md).

## Tests

- `test/land.test.ts`: "land loads no configuration from the repository it
  runs in". The other tests use a `land.toml` with a gate.

## Gotchas

- No test covers `decl-missing`, `decl-unknown-key`, `decl-invalid`,
  `decl-main` or `decl-no-gate`. The steps above are their only proof.
- A new key needs a new `land` on every machine that lands the repository: an
  older `land` refuses the file. That is on purpose, so that an older `land`
  never skips a stage a newer file names.
- Working but wrong: `land` passing in the land repository and failing in a
  Bun project. The land repository has no `bunfig.toml`, so only the last step
  shows it.
