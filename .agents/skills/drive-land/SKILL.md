---
name: drive-land
description: Drive the real land (the land command in a person's or an agent's shell, and the pre-push hook git runs) in a scratch world with a local bare repository as origin, and keep proof that a change works. Use before reporting any change to land done, and to reproduce a bug someone reports.
---

# Drive land

Prove a change by using `land` the way its users do: someone in a clone, with
commits to land, runs `land`. The tests guard promises. This skill shows the
change working once, on the real command, with evidence a reviewer can read. A
green `bun run check` is not that evidence.

Everything goes through one helper, run from the repository root:

```sh
.agents/skills/drive-land/drive.ts <run> <command>
```

`<run>` is a short id you choose, such as `gate-1`. Each run gets a world at
`/tmp/land-drive/<run>/world` and an evidence folder at
`/tmp/land-drive/<run>/evidence`. A world holds its own home and git identity,
a bare repository `origin.git` that stands in for GitHub, the clone `lander`,
and its own copy of `land`. A world shares nothing with your clones, your git
configuration or another run, so several runs can go at once. Run the helper
with no arguments for its usage. `drive.ts` below means that path.

## Launch

```sh
bun install          # once per checkout
drive.ts r1 up
```

`up` builds `land` from this checkout, copies the binary into the world, and
makes `origin.git` with one commit on `main`. The clone `lander` is on the
branch `work` at `origin/main`. Its `land.toml` names the gate `sh gate.sh`,
and `gate.sh` prints `gate ran on $LAND_HEAD, based on $LAND_BASE`. The world
is ready when `up` prints its four lines and the doctor ends with `ok`.

The world's `land` is a copy, because `bun run check` and another agent's
build both rewrite `dist/land`. After you change the source, start a new run:
an old world still holds the old binary, and the doctor says so.

## Doctor

```sh
drive.ts r1 doctor
```

It reads and changes nothing. It checks that the world's `land` answers with
this checkout's version, that `land` on the world's `PATH` is the world's
copy, that the sources have not changed since `up`, that the git identity is
the world's, and that every clone pushes to the world's `origin.git`. It ends
with `ok`. Run it first, and again whenever something looks wrong.

## Drive

`land` has one way in for people and agents alike: the command, run in a
clone. Git is the other actor: it runs the pre-push hook that `land` installs.

```sh
drive.ts r1 do lander 'echo two >> story.txt && git commit -qam "Second line"'
drive.ts r1 do lander land
drive.ts r1 do origin.git 'git log --format="%h %s" main'
drive.ts r1 clone other
```

`drive.ts r1 feed lander land` is `do` while the world's stub feed answers at
the address `up` printed, and its evidence lists the requests the feed got;
see [Feed](features/feed.md). With `do`, the feed is down.

`do <dir> '<command>'` runs one shell command in a directory of the world:
`lander`, another clone, `origin.git`, or `home` for a place outside any
repository. Put the whole command in one pair of quotes. It prints what the
command printed and exits with its status, or with 128 plus the signal when a
signal killed the command.
Inside, `land` is the world's copy, `HOME` and the global git identity are the
world's, and every `LAND_` and `GIT_` variable of your shell is cleared. So a
drive behaves the same from a plain shell, from inside a gate, and from inside
a landing. `clone <name>` adds a second clone, on `main`, for a second lander
or for moving `main` under the first.

Set up state with the same commands a lander uses: `git commit`, `git push`,
edits to `land.toml` and `gate.sh`. Never write into `origin.git` or a clone's
`.git` by hand to fake a state, except where a feature file says to.

## Evidence

Each `do` saves one numbered file in `/tmp/land-drive/<run>/evidence`: the
command, its directory, its exit status, its stdout and its stderr. The proof
of a landing is two files: what `land` printed, and a second view from
`origin.git`, such as `git log main`, that shows what `main` holds. A refusal
needs both too: the message, and `origin.git` unchanged.

Attach the evidence folder, or the files that matter, where the work was asked
for, and name the feature and sub-feature beside each file.

## Cleanup

```sh
drive.ts r1 down
```

`down` removes the world and keeps the evidence. A run id is used once: a new
world needs a new id, so one evidence folder never holds the output of two
builds. A run starts no process that
outlives its command, the stub feed included, so there is nothing to stop. Check that the evidence
folder is still there before you report.

## The feature map

Read [features/README.md](features/README.md), then the file of each feature
your change touches. Drive every way in and every context listed there that
applies to the change. Update a feature's file in the same landing that adds,
removes or alters a way into it, and whenever you find a trap or a test the
file lacks.
