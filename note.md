Release 0.13.0 adds first-class verification media flags, pre-gate evidence guards, and post-landing evidence uploads so visual proof stops getting dropped at land time:

- `land --media <file>` (repeatable) attaches any local image, GIF, or video (`png`, `jpg`, `jpeg`, `gif`, `webp`, `mp4`, `webm`) to the landing note without requiring `land record`.
- Pre-gate guards refuse (unless `land --no-media "<reason>"` is passed, recorded in `landing.json` as `noMediaReason`) when `.land/media/` holds unlinked recordings, an `Attn-Seed:` trailer has fresh unlinked media artifacts newer than its last landing, or changed files match `visual_paths` in `land.toml` (supports `!pattern` negation).
- `land.toml` also supports `require_note = true` and a custom `evidence_check` shell hook.
- `land evidence <sha> <file>... [-m <text> | --detail-file <file>] [--title <title>]` and `land event --media <file>` upload post-landing verification media via `refs/land-events/<sha>/<id>` and `?event=<id>` with outbox fallback.
