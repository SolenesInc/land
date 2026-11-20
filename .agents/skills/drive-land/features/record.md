# Record

`land record [args]` runs the repository's `record` command, which captures the
change's visible surface, and prints one markdown line per recording it made, to
paste into a note. `land` holds no capture code: the command is the
repository's.

## Sub-features

- `record-run` runs the `record` key of `land.toml` with `sh -c` at the
  repository root, with `LAND_MEDIA` set to the absolute path of
  `.land/media/` (created when missing) and the arguments appended.
- `record-lines` prints `![<name without extension>](.land/media/<file>)` for
  each file the command created or wrote again, sorted by name, with the file name percent-encoded in the link. Dotfiles and directories in `.land/media/` are not recordings. The command's
  own stdout goes to stderr, so stdout holds only those lines.
- `record-no-key` fails when `land.toml` has no `record` key, names the key and
  shows an example.
- `record-failed` exits with the command's status and prints no line when the
  command fails.
- `record-exclude` adds `.land/` to the clone's `.git/info/exclude`, so the
  untracked-file check of a landing never sees the recordings.

## How to get to it

### People

- Run `land record [args]` in a clone of a repository whose `land.toml` has a
  `record` key (`src/record.ts`).

### Agents

- The same command. `land --help` lists it and the key.

## Driving it

Preconditions:

- A fresh run, `r`. Run the steps in order.
- A record command in the repository. Run
  `drive.ts r do lander 'printf "for n in \"\$@\"; do echo shot > \"\$LAND_MEDIA/\$n\"; done\n" > record.sh && echo "record = \"sh record.sh\"" >> land.toml && git add . && git commit -qm "Declare record"'`.

- **Recordings.** From a subdirectory, run
  `drive.ts r do lander 'mkdir -p src && cd src && land record one.png "two shots.gif"'`.
  It prints `![one](.land/media/one.png)` and
  `![two shots](.land/media/two%20shots.gif)`, and exits 0. Run
  `drive.ts r do lander 'ls .land/media && git status --short'`: both files
  are there, and the status is empty.
- **Only new files.** Run `drive.ts r do lander 'land record three.png'`. It
  prints only `![three](.land/media/three.png)`.
- **Still lands.** Run
  `drive.ts r do lander 'echo two > story.txt && git commit -qam Two && land'`.
  It lands, and exits 0.
- **No record key.** Run
  `drive.ts r do lander 'git reset -q --hard origin/main && sed -i.bak "/^record/d" land.toml && rm land.toml.bak && land record'`.
  It prints `land: land.toml names no record command; add the key, for example:`
  and an example line, prints nothing on stdout, and exits 1.
- **A failing command.** Restore the key, then run
  `drive.ts r do lander 'git checkout -q land.toml && echo "exit 7" > record.sh && land record; echo status=$?'`.
  It prints `land: record   sh record.sh   failed with status 7` and
  `status=7`, and no markdown line.
- **Proof.** The saved output of each command, with its status.

## Contexts

- **Several worktrees of one clone.** `.git/info/exclude` is shared by the
  worktrees, and each worktree has its own `.land/media/`.
- **Run from a subdirectory.** The command still runs at the repository root.

## Tests

- `test/land.test.ts`: "land record prints one markdown line per new
  recording, and the repository still lands", "land record names the key when
  the declaration has no record command" and "a failing record command makes
  land exit with its status and print no line".

## Gotchas

- A recording that the command writes again under the same name counts as
  new, so a re-record prints its line again.
- Arguments are appended to the last command of the `record` string, as
  `"$@"`. A `record` with a pipe or `;` receives them on its last part. A string that ends in `;` or in a `#` comment
  breaks the appended `"$@"`.
