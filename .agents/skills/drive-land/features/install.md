# Install

One command puts `land` on a machine: it downloads the binary for the
platform from the latest GitHub release. The machine needs no Bun. A landing
that changes the version in `package.json` publishes the next release.

## Sub-features

- `install-binary` installs the released binary with the README's command, on
  macOS arm64 and Linux x64, with no Bun on the `PATH`.
- `release-publish` publishes the binaries that CI built and tested as the
  release `v<version>`, when no release has that version yet.

## How to get to it

### People

- Run the command under "Install" in `README.md`.

### Agents

- The same command.

### Triggers

- CI on `main` runs the `release` job after every landing
  (`.github/workflows/ci.yml`).

## Driving it

Preconditions:

- A fresh run, `r`, and network access to github.com. This drive downloads the
  latest release. It proves the released `land`, not this checkout's.

- **Install without Bun.** Run
  `drive.ts r do home 'env PATH=/usr/bin:/bin sh -c "mkdir -p ~/.local/bin && curl -fsSL https://github.com/SolenesInc/land/releases/latest/download/land-$(uname -s)-$(uname -m) -o ~/.local/bin/land && chmod +x ~/.local/bin/land && ~/.local/bin/land --version"'`.
  `~` is the world's home. It prints `land <version>`, the latest release's
  version, and exits 0. The command is the README's, with the version check
  added: when you change one, change the other.
- **Proof.** The saved output, with the platform it ran on from `uname -sm`.

## Contexts

- **Platform.** Prove both platforms when you change the build or the
  workflow: run the step on a Mac and on a Linux x64 machine.
- **This checkout's build or the released binary.** Every other feature file
  drives this checkout's build.

## Tests

- None. CI's `check` job builds the binary and runs `test/land.test.ts`
  against it on Ubuntu and macOS, and the `release` job ships those binaries.

## Gotchas

- `release-publish` cannot be driven in a world. After a landing that changes
  the version, read it from GitHub: `gh run list --repo SolenesInc/land --limit 1`,
  then `gh release view v<version> --repo SolenesInc/land`.
- A landing that does not change the version publishes nothing, so `main` can
  be ahead of the latest release. Landers get a fix only after a version bump.
- The binary is about 90 MB.
