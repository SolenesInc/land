# land feature map

The maintained source for driving land's behavior. Read this index and the
[skill](../SKILL.md) first, then follow the feature file as the recipe.
`drive.ts` below is `.agents/skills/drive-land/drive.ts`, run from the
repository root.

## Audiences

| Audience | Ways in                                                                                            | Source                                        |
| -------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| People   | The `land` command in their own shell, in a clone of a repository that has a `land.toml`           | `src/main.ts`, `src/landing.ts`               |
| People   | `land init`, in a clone of a repository that does not land with `land` yet                         | `src/init.ts`                                 |
| Agents   | The same command, and the text of `land guide`, which a repository's guidance tells them to follow | `src/main.ts`, `src/guide.md`                 |
| Runners  | `land guide review` and `land guide sheriff`, which a scheduled or event-started agent follows     | `src/guide-review.md`, `src/guide-sheriff.md` |
| Git      | The hooks that `land` installs: pre-push on every push, prepare-commit-msg on every commit         | `installHooks` in `src/landing.ts`            |
| CI       | The workflow that publishes a release when a landing changes the version                           | `.github/workflows/ci.yml`                    |

## Baseline preconditions

- `bun install` has run in this checkout, and `git` is installed.
- A fresh run: `drive.ts <run> up`.
- `drive.ts <run> doctor` ends with `ok`.
- Each recipe starts from a fresh run unless it says otherwise. Recipes leave
  commits on the world's `main`, so a second recipe in one run starts from a
  different history.

## Driving conventions

- Run every command through `drive.ts <run> do <dir> '<command>'`, so the
  command sees the world's home, identity and `land`, and its output is saved.
- Commands are literal. Keep the quoting as written.
- Nothing in a recipe waits for time. A gate that must hold a landing open
  blocks on a FIFO, as `holdGate` in `test/land.test.ts` does.
- Read `main` from `origin.git`, never from a clone's `origin/main`: the
  clone's ref is what that clone last saw.
- Hashes differ in every run. Match the words around them.

## Proof and skip reporting

- Proof of a landing is the saved output of `land` and a saved second view of
  `origin.git` that shows the commit on `main`.
- Proof of a refusal is the saved message with its exit status, and a second
  view that shows `main` unchanged.
- Proof of the hook is the saved output of the refused `git push`.
- Name the feature and sub-feature with each piece of evidence.
- Report a way in you could not drive with the command you tried and the
  precondition that failed. A different way in is not proof of it.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on what the user sees,
then these H2s in this order: `Sub-features` (short ids, one line each),
`How to get to it` (every way in, under `### People` and `### Agents`, each
saying `None.` when it has none, and `### Triggers` when something starts the
feature without anyone invoking it), `Driving it` (`Preconditions:`, then
labeled steps that pair an action, its exact command and what you observe,
ending with **Proof**), `Contexts` (only those that apply), `Tests` (pointers
to the committed tests by name) and `Gotchas`. Keep implementation out: name
commands, messages, state and proof.

## Contexts

- **Platform.** `land` ships for macOS arm64 and Linux x64. A drive proves the
  platform it ran on. CI runs the tests on both.
- **This checkout's build or the released binary.** A world drives this
  checkout's build. [Install](install.md) drives the released one.
- **Several worktrees of one clone.** Lands from them run at once and share no
  ref.
- **The repository's own configuration.** A repository can hold a
  `bunfig.toml`, a `.env`, a `tsconfig.json` or a `package.json`. `land` reads
  none of them.
- **Hooks.** A clone can set `core.hooksPath`, or hold a pre-push or
  prepare-commit-msg hook of its own.
- **A branch other than `main`.** `land.toml` can name it.

## Index

| Feature                         | Audiences               | What it is for                                                                                                     |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Landing](landing.md)           | People, agents          | Put finished commits on `main`: rebase, gate, push, or stop and say why                                            |
| [Declaration](declaration.md)   | People, agents          | Tell `land` what a repository's gate is, in `land.toml`                                                            |
| [Init](init.md)                 | People, agents          | Adopt `land` in a repository: write `land.toml` and the trunk declaration                                          |
| [Push hook](push-hook.md)       | People, agents, git     | Refuse a plain `git push` to `main`, so changes go through the gate                                                |
| [Trailer hook](trailer-hook.md) | People, agents, git     | Name the attn session and seeds a commit was made in, in its trailers                                              |
| [Guide and help](guide.md)      | People, agents, runners | Tell a lander the procedure around a landing, a runner how to review and repair `main`, and what the command takes |
| [Install](install.md)           | People, agents, CI      | Get `land` onto a machine that has no Bun, and publish each new version                                            |
