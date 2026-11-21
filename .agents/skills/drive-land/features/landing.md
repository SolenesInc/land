# Landing

You finish commits on a private branch, write a note for the readers of `main`
if you like, and run `land`. It puts the commits on top of the latest `main`,
runs the repository's gate, and pushes `main` with the landing ref
`refs/landings/<head>`, whose commit holds `landing.json` and the note. When something is
wrong it stops before the push, says what to do, and leaves your branch as it
was.

## Sub-features

- `land-push` rebases, runs the gate, pushes, and prints one line for the gate
  and one for the push.
- `land-ref` pushes `main` and `refs/landings/<head>` in one atomic push. The
  ref's commit holds `landing.json`: version 1, `land`'s version, the base,
  the head, the gate's command, seconds and the commit it ran on, and the
  `recordings` the note links, empty without one; see [Feed](feed.md).
- `land-note` picks up `.land/note.md`, prints `land: note   .land/note.md`,
  puts it in the landing ref as `note.md`, and deletes it after the push. It
  keeps the note when `land` pushes nothing. A note that links recordings
  prints `, 1 recording` after the path; see [Feed](feed.md).
- `land-note-flag` takes the note from the file `land --note <file>` names,
  and fails with `land: --note <file>: no such file` before the gate when it
  is missing. A note git tracks is refused, because `land` deletes the note
  after the push.
- `land-exclude` adds `.land/` to the clone's `.git/info/exclude` once, so a
  note is never an untracked file.
- `land-gate-env` gives the gate `LAND_BASE`, the `main` commit the landing
  sits on, and `LAND_HEAD`, the commit it pushes.
- `land-nothing` prints `nothing to land` when the branch has nothing ahead of
  `main`.
- `land-gate-fails` pushes nothing and exits with the gate's status.
- `land-untracked` refuses while the worktree holds an untracked file that git
  does not ignore, and names it.
- `land-uncommitted` refuses while a tracked file has uncommitted changes.
- `land-author` refuses a commit whose author is not the global git identity,
  and names it.
- `land-conflict` aborts a rebase that conflicts, names the files, and leaves
  the branch as it was.
- `land-rebase-in-progress` refuses while a rebase is in progress.
- `land-main-moved` rebases and pushes without running the gate again when
  `main` moved while the gate ran, and names the commit the gate ran on.
- `land-side-by-side` lets lands from several worktrees of one clone run at
  once.
- `land-killed` leaves nothing behind that stops the next land, when a land is
  killed.

## How to get to it

### People

- Run `land` in a clone whose root holds a `land.toml` (`src/main.ts`,
  `src/landing.ts`).
- Run `land --note <file>` to land with a note kept outside `.land/`
  (`src/main.ts`, `src/note.ts`).

### Agents

- Run the same command. The repository's guidance sends them to `land guide`
  first.

## Driving it

Preconditions:

- A fresh run, `r`. Run the steps in order: each builds on the last.

- **Land.** Run
  `drive.ts r do lander 'echo two >> story.txt && git commit -qam "Second line"'`,
  then `drive.ts r do lander land`. It prints
  `gate ran on <head>, based on <base>`, `land: gate   sh gate.sh   ok in 0s`
  and `land: push   main is at <head>`, and exits 0.
- **Second view.** Run
  `drive.ts r do origin.git 'git log --format="%h %s" main'`. `Second line` is
  on top of `Start`, at the hash `land` printed.
- **The landing ref.** Run
  `drive.ts r do origin.git 'git for-each-ref refs/landings/ && git ls-tree --name-only "refs/landings/$(git rev-parse main)" && git show "refs/landings/$(git rev-parse main):landing.json"'`.
  One ref, named for `main`'s head; its tree lists `landing.json` alone, whose
  `head` is that commit and whose `gate.ranOn` is too.
- **A note.** Run
  `drive.ts r do lander 'mkdir -p .land && echo "The story has a noted line." > .land/note.md && echo noted >> story.txt && git commit -qam "A noted line"'`,
  then `drive.ts r do lander land`. It prints `land: note   .land/note.md`
  before the gate line, and exits 0. Run
  `drive.ts r do lander 'ls .land; grep -c "^.land/$" .git/info/exclude'`:
  `.land` is empty and the exclude has the line once. Run
  `drive.ts r do origin.git 'git ls-tree --name-only "refs/landings/$(git rev-parse main)" && git show "refs/landings/$(git rev-parse main):note.md"'`:
  `landing.json`, `note.md`, and the sentence.
- **Nothing to land.** Run `drive.ts r do lander land` again. It prints
  `land: nothing to land` and exits 0.
- **A failing gate.** Run
  `drive.ts r do lander 'echo "exit 3" > gate.sh && git commit -qam "A gate that fails" && echo Kept > .land/note.md'`,
  then `drive.ts r do lander land`. It prints
  `land: gate   sh gate.sh   failed with status 3; nothing was pushed` and
  exits 3. The second view still shows `A noted line` on top, and
  `drive.ts r do lander 'cat .land/note.md && rm .land/note.md'` prints
  `Kept`. Put the gate back
  with `drive.ts r do lander 'git reset -q --hard HEAD~1'`.
- **An untracked file.** Run
  `drive.ts r do lander 'echo three >> story.txt && git commit -qam "Third line" && echo scratch > notes.txt'`,
  then `drive.ts r do lander land`. It prints
  `land: the worktree has files the landing does not contain, so the gate could pass because of them:`,
  then `notes.txt`, then
  `Commit, remove or ignore them, then run land again.`, and exits 1.
- **An uncommitted change.** Run
  `drive.ts r do lander 'rm notes.txt && echo draft >> story.txt'`, then
  `drive.ts r do lander land`. It prints
  `land: commit or stash your changes first` and exits 1.
- **Another author.** Run
  `drive.ts r do lander 'git checkout -q story.txt && echo four >> story.txt && git -c user.email=someone@example.com commit -qam "By someone else"'`,
  then `drive.ts r do lander land`. It prints
  `land: these commits are not authored by your global git identity, lander@example.com:`
  and the commit with `someone@example.com`, and exits 1. Drop the commit with
  `drive.ts r do lander 'git reset -q --hard HEAD~1'`.
- **A conflict.** Run `drive.ts r clone other`, then
  `drive.ts r do other 'echo theirs >> story.txt && git commit -qam "Their line" && git push -q origin HEAD:main'`,
  then `drive.ts r do lander land`. It prints
  `land: rebasing onto origin/main conflicts in:`, then `story.txt`, then
  `Rebase with git rebase origin/main, then run land again.`, and exits 1. Run
  `drive.ts r do lander 'git status --short --branch && git log --format=%s -1'`:
  the branch is `work`, ahead 1 and behind 1, with no file listed, and its last
  commit is still `Third line`. Then run
  `drive.ts r do lander 'git reset -q --hard origin/main'`.
- **Main moves while the gate runs.** Run
  `drive.ts r do other 'echo more > other.txt && git add other.txt && git commit -qm "Their file"'`,
  then
  `drive.ts r do lander 'echo "git -C ../other push --quiet origin HEAD:main" > gate.sh && echo four >> story.txt && git commit -qam "Fourth line, and a gate during which main moves"'`,
  then `drive.ts r do lander land`. The gate itself pushes `Their file`. `land`
  prints the gate line, `land: push   main is at <head>`, and
  `land: main moved after the gate ran on <commit>; pushing without running it again`,
  and exits 0. The second view shows the lander's commit on top of
  `Their file`.
- **Proof.** The saved output of each `land`, with its exit status, the
  second view after the first landing, the failing gate and the last landing,
  and the landing refs read from `origin.git`.

## Contexts

- **Several worktrees of one clone.** Each land fetches into a ref of its own
  worktree and pushes to the remote's URL, so two lands write no shared ref.
  When their pushes race, the remote refuses one, which rebases, writes a new
  landing commit for its new head, and pushes again. The refused push wrote
  no landing ref, because the push is atomic. The test holds both gates on FIFOs to force the race. A drive from
  two terminals proves that both land, not that they raced.
- **The repository's own configuration.** See [Declaration](declaration.md).

## Tests

- `test/land.test.ts`: "a landing reaches main", "a second land prints nothing
  to land", "a failing gate pushes nothing, and land exits with the gate's
  status", "an untracked file that the gate depends on stops the landing", "a
  commit by another author is refused", "a conflict stops the landing and
  leaves the branch as it was", "main moving after the gate still lands, and
  land names the commit the gate ran on", "two lands from two worktrees of one
  clone both land", "a land that is killed mid-landing does not stop the next
  land", "a landing with a note pushes main and its landing ref in one push,
  then deletes the note", "a landing without a note pushes a landing ref that
  holds landing.json alone", "land --note lands the note in the file it names",
  "land --note with no such file pushes nothing", "a failing gate keeps the
  note and pushes no landing ref", "land adds .land/ to the clone's exclude
  once, for every worktree".

## Gotchas

- No test or recipe covers `land-uncommitted` or `land-rebase-in-progress`
  beyond the step above. Drive them when you change the checks at the top of
  `land` in `src/landing.ts`.
- `land` rewrites your branch when it rebases. After a landing, the lander's
  hashes differ from the ones before it whenever `main` had moved.
- The last step lands a `gate.sh` that pushes from `../other`. End the run
  there, or put `gate.sh` back before you drive anything else in it.
- Working but wrong: a gate that passes because of a file the landing does not
  contain. `land-untracked` exists for this. If you weaken it, drive a gate of
  `test -f <untracked file>` and check that nothing lands.
- Working but wrong: `land` exits 0 after a push that did not reach `main`.
  Always read `main` from `origin.git`.
- Working but wrong: a landing ref for a head that never reached `main`. It
  happens only if the push stops being atomic. Count the refs under
  `refs/landings/` on `origin.git` against `main`'s landed heads after a
  retry, as the two-worktrees test does.
- A clone does not fetch `refs/landings/*`. Read landing refs on
  `origin.git`, never in a clone.
