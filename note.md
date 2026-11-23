`land` 0.10.0 prepares `land` for repositories with repo-managed hooks and generated-file conflicts (including `attn`) and refreshes all guides and docs:

- **`resolve` key in `land.toml`:** optional shell command run when rebasing onto `main` hits conflicts (receives `LAND_BASE`); exits `0` with no unmerged files left to continue the rebase, or non-zero to abort cleanly.
- **Smart `core.hooksPath` check:** inspects the configured hooks directory for `pre-push` (`LAND_LANDING`) and `prepare-commit-msg` (`Attn-Session:`) and warns only about missing hooks.
- **Undone-commit warning:** after pushing, checks the last 30 `main` commits touching the same files and warns when the landing completely undoes an earlier commit.
- **`land brief --base <sha>`:** validates multi-commit landings against their true base (also falls back to frontmatter `base:`).
- **Guides, `--help`, and `README.md`:** reorganized CLI help, tightened wording, and integrated the review, comment, brief, and bug-attribution commands across `land guide`, `land guide review`, `land guide sheriff`, and `README.md`.
