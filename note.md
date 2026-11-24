Refuse blind gate re-runs on an unchanged diff unless the diff changes or the caller explicitly acknowledges a diagnosed, owned flake.

- Records non-signal gate failures under `<git-common-dir>/land-failures/` keyed by a rebase-invariant hash of `git diff-tree` (`git patch-id --verbatim` plus mode/file-creation/binary headers), refusing retries on the same unchanged diff until the diff changes or `--ack-flake <test> --owner <ref>` is supplied (recorded as optional `acknowledgedFlake` in `landing.json`).
- Replaces the "second run = flake" escape hatch in `land guide` and `land guide sheriff` with paired `HEAD` vs `origin/main` triage and root-cause ownership for every intermittent failure.
