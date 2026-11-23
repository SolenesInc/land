# Feed

A repository whose `land.toml` names a `feed` shows its landings there. A note
can link a recording that `land record` made: `land` links it by its feed
address in the pushed note, lists it in `landing.json`, and uploads it after
the push. `land event` tells the feed what happened after a landing. Nothing
the feed does can fail a landing: what does not go waits in the outbox on the
lander's machine, and the next `land` sends it.

## Sub-features

- `feed-recording` finds the note's links to local media files (`png`, `jpg`,
  `jpeg`, `gif`, `webp`, `mp4`, `webm`), relative to the repository root as
  `land record` prints them, outside code spans and fenced blocks. It prints
  `land: note   .land/note.md, 1 recording`, rewrites each link to
  `<feed>/m/<owner>/<repo>/<sha256>.<ext>`, and lists each file once in
  `landing.json`'s `recordings` (`sha256`, `ext`, `bytes`).
- `feed-upload` uploads each recording after the push, sending no credential,
  prints `land: media  1 recording uploaded`, deletes the uploaded files that
  are in `.land/` with the note (a tracked or outside file stays), and prints `land: feed   <feed>/<owner>/<repo>/<short head>`.
- `feed-refuse` stops before the gate, with nothing pushed and the note kept,
  for a link to a missing file, a recording over 200 MB, a local recording with
  no `feed` key, and a local recording when origin is not on GitHub.
- `feed-outbox` keeps a recording that did not upload, and prints
  `land: media  <link> waits in the outbox: <why>`; the file stays in
  `.land/media/`. The outbox is `$XDG_STATE_HOME/land/outbox`, or
  `~/.local/state/land/outbox`.
- `feed-refused` drops a recording or an event notice the feed answers 404
  for, as it does for a repository without the App, and says
  `is not uploaded: the feed answered 404; is the Attn Land App installed on <owner>/<repo>?`.
  A drain prints `land: outbox dropped <what>: <why>` for such an entry.
- `feed-drain` sends the outbox at the start of every `land`, before
  `nothing to land`, in any repository. It prints `land: outbox 1 sent`, or
  `land: outbox 1 wait to send: <why>` while entries remain. After one feed
  does not answer, the run sends it nothing more, so a hanging feed costs one
  timeout (30 s per call, 10 minutes per PUT).
- `feed-event` is `land event <sha> --kind --state --title [--url]
[--detail-file] [--repairs]`. It commits `event.json`, with no parent, pushes
  it to `refs/land-events/<sha>/<id>`, posts the notice, and prints
  `land: event  <ref> pushed; the feed has it`, or `...; the notice waits in
the outbox: <why>`. It needs the `feed` key and a GitHub origin. A bad
  `--state` or a missing flag exits 2.
- `feed-bug` is `land bug <sha> --title [--severity] [--source] [--location] [--detail-file] [--fixed-by] [--url]`
  and `land bugs [--open] [--since] [--path] [--severity] [--json]`. `land bug`
  pushes a `kind: "bug"` event (and an optional `repair` event when `--fixed-by`
  is set) via `refs/land-events/`; `land bugs` queries the feed's bug list.
- `feed-review` is `land auth token|status|logout`, `land show <sha|url>`,
  `land comments [<sha|url>] [--open] [--json]`, `land comments resolve <id> [--by <sha>]`,
  `land review check <file>`, and `land brief <sha> <file> [--base <sha>] [--no-check]`. `land brief`
  validates the review document against git and pushes a `kind: "review-doc"`
  event to `refs/land-events/`.

## How to get to it

### People

- `land` with a note that links a recording, in a repository whose
  `land.toml` names `feed` (`src/landing.ts`, `src/media.ts`, `src/feed.ts`).
- Any `land` while the outbox holds entries (`src/outbox.ts`).
- `land event` (`src/event.ts`). `land --help` lists it.
- `land bug` and `land bugs` (`src/bug.ts`).
- `land show`, `land comments`, `land review check`, `land brief` (`src/review.ts`), and `land auth` (`src/auth.ts`).

### Agents

- The same commands. `land guide`'s Note step says to record a visible change
  and link it in the note. `land guide review` says to post each routed finding with
  `land event --kind finding`, and `land guide sheriff` each landed repair with
  `land event --kind repair --repairs <culprit>`, when `land.toml` has `feed`.

### Triggers

- None. The outbox is sent only when someone runs `land`.

## Driving it

Preconditions:

- A fresh run, `r`. `up` prints the stub feed's address,
  `http://127.0.0.1:<port>`; the stub answers only during
  `drive.ts r feed <dir> '<command>'`, so a plain `do` drives the feed down.
- The stub is `test/stub-feed.ts`: it reads landing and event refs from the
  world's `origin.git` and holds uploads in memory for one command.

- **Join.** Make origin look like GitHub, and name the feed and a record
  command. Replace `r` in the path with the run's id:
  `drive.ts r do lander 'git config remote.origin.url git@github.com:SolenesInc/demo.git && git config url./tmp/land-drive/r/world/origin.git.insteadOf git@github.com:SolenesInc/demo.git && printf "feed = \"http://127.0.0.1:%s\"\nrecord = \"sh record.sh\"\n" "$(cat ../feed-port)" >> land.toml && echo "printf \"\$1\" > \"\$LAND_MEDIA/\$1\"" > record.sh && git add . && git commit -qm "Join the feed"'`.
  `drive.ts r doctor` still ends with `ok`.
- **Upload.** Run `drive.ts r do lander 'land record "banner flicker.mp4"'`
  (prints `![banner flicker](.land/media/banner%20flicker.mp4)`), then
  `drive.ts r do lander 'printf "The banner no longer flickers.\n\n![banner flicker](.land/media/banner%%20flicker.mp4)\n" > .land/note.md && echo two >> story.txt && git commit -qam "Second line"'`,
  then `drive.ts r feed lander land`. It prints
  `land: note   .land/note.md, 1 recording`, the push, `land: media  1 recording uploaded`
  and `land: feed   http://127.0.0.1:<port>/SolenesInc/demo/<head>`. The
  evidence lists three feed requests, POST, PUT, POST `.../uploaded`, none
  with a credential.
- **What landed.** Run
  `drive.ts r do origin.git 'h=$(git rev-parse main); git show refs/landings/$h:landing.json; git show refs/landings/$h:note.md'`.
  `recordings` holds one entry with `ext` `mp4`; the note links
  `http://127.0.0.1:<port>/m/SolenesInc/demo/<sha256>.mp4`. Then
  `drive.ts r do lander 'ls -A .land/media'` lists nothing.
- **Feed down.** Run
  `drive.ts r do lander 'land record demo.png && printf "![demo](.land/media/demo.png)\n" > .land/note.md && echo three >> story.txt && git commit -qam "Third line" && land; ls ~/.local/state/land/outbox'`.
  It pushes, prints
  `land: media  .land/media/demo.png waits in the outbox: the feed did not answer`,
  and the outbox holds `recording~SolenesInc~demo~<sha256>.bytes` and `.json`.
  `drive.ts r do lander land` prints `land: outbox 1 wait to send: the feed did not answer`.
- **Drain.** Run `drive.ts r feed lander land`. It prints
  `land: outbox 1 sent` and `land: nothing to land`. A further
  `drive.ts r do lander land` prints `land: nothing to land` alone.
- **Event.** Run
  `drive.ts r feed lander 'echo "It flickers." > ../finding.md && land event $(git rev-parse --short HEAD) --kind finding --state fail --title "banner flickers" --detail-file ../finding.md'`.
  It prints `land: event  refs/land-events/<head>/<id> pushed; the feed has it`.
  `drive.ts r do origin.git 'for r in $(git for-each-ref --format="%(refname)" refs/land-events/); do echo $r; git show $r:event.json; done'`
  shows the envelope. Run the same `land event` with `do` instead of `feed`:
  the notice waits in the outbox, and the next `drive.ts r feed lander land`
  prints `land: outbox 1 sent`.
- **Refusals.** Run
  `drive.ts r do lander 'printf "![gone](.land/media/gone.mp4)\n" > .land/note.md && echo four >> story.txt && git commit -qam "Fourth" && land'`:
  `land: the note .land/note.md links .land/media/gone.mp4, and there is no such file; nothing was pushed`,
  exit 1, no gate line. Then remove the `feed` line from `land.toml`, commit,
  link an existing `.land/media/shot.png`, and run `land`: it names the
  missing `feed` key and exits 1.
- **Bug & review.** Run
  `drive.ts r feed lander 'land bug $(git rev-parse --short HEAD) --title "null crash" --severity p0 --location story.txt:1 && land bugs --open'`
  (prints `land: bug    refs/land-events/<head>/<id> pushed; the feed has it` and lists the P0 bug).
  Run `drive.ts r feed lander 'printf -- "---\nland: review\nframe: walkthrough\n---\n\n# Update\n\nAdds line.\n\n## Step\n\n### story.txt:1-2\n\n- L2!: Look here.\n" > ../rev.md && land review check ../rev.md && land brief $(git rev-parse --short HEAD) ../rev.md && land show $(git rev-parse --short HEAD)'`
  (prints `land: review ok`, `land: brief  refs/land-events/<head>/<id> pushed; the feed has it`, and the markdown bundle).
- **Proof.** The saved output of each `land` and `land event`, the feed
  requests in the evidence, the landing ref's `landing.json` and `note.md`,
  the event ref's `event.json`, and the outbox listings.

## Contexts

- **The real feed.** A drive proves the contract against the stub. Only a
  real landing on a repository with the App installed proves that the feed
  takes the upload, which the C44 check of `s-qgxcj0` covers.
- **Two lands draining one outbox.** Both may send an entry; the feed answers
  the second with `present`, and removing an entry twice is harmless.

## Tests

- `test/land.test.ts`: "a note linking a local recording lists it in
  landing.json, uploads it after the push with no credential, and the pushed
  note holds the feed address", "a link to a missing file, a recording over
  200 MB and a local recording without a feed key each fail before the gate
  with nothing pushed", "with the feed unreachable, land pushes, the outbox
  holds the file, and the next land uploads it and empties the outbox", "a
  note may link a file the repository tracks and show a link in code: land
  uploads the file, keeps it, and leaves the code as written", "a feed that
  refuses the recording and the event, as one without the App does, drops
  them with why, and land still succeeds", "land event pushes refs/land-events/<sha>/<id> holding the event, notifies the
  feed, and keeps the notice in the outbox when the feed is down".

## Gotchas

- `land` reads owner and repository from `remote.origin.url` as configured,
  before `insteadOf`. The drive relies on that to point a GitHub URL at the
  world's `origin.git`.
- Two recordings with the same bytes are one file to the feed, under the
  first extension it saw. Give a record command's test files distinct
  contents.
- Working but wrong: a note pushed with a local `.land/media/...` link. Read
  `note.md` from the landing ref on `origin.git`, never the worktree.
- The outbox lives in `$HOME`, which the world owns, so a drive never touches
  the lander's real outbox.
