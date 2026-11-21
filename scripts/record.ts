// land record's command for this repository: run a command, and write a video of its output, as a
// terminal shows it, to $LAND_MEDIA/<name>.mp4. Usage: land record <name> <command>...
// Each frame is the terminal at one moment the command wrote; headless Chrome draws it, ffmpeg
// joins the frames at the times they happened.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [name, ...command] = process.argv.slice(2)
const media = process.env.LAND_MEDIA
if (name === undefined || command.length === 0 || media === undefined) {
  console.error("usage: land record <name> <command>...")
  process.exit(2)
}

let chrome: string | undefined
for (const path of [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  Bun.which("google-chrome"),
  Bun.which("chromium"),
]) {
  if (chrome === undefined && path && (await Bun.file(path).exists())) chrome = path
}
if (chrome === undefined || Bun.which("ffmpeg") === null) {
  console.error("record needs Chrome (or $CHROME) and ffmpeg")
  process.exit(1)
}

// The command's output, stdout and stderr together, as it arrived.
const started = performance.now()
const shown = `$ ${command.join(" ")}\n`
const moments: { at: number; text: string }[] = [{ at: 0, text: shown }]
const child = Bun.spawn(["sh", "-c", `exec "$@" 2>&1`, "record", ...command], { stdout: "pipe", stdin: "ignore" })
let text = shown
const decoder = new TextDecoder()
for await (const chunk of child.stdout) {
  text += decoder.decode(chunk, { stream: true })
  console.error(decoder.decode(chunk))
  moments.push({ at: (performance.now() - started) / 1000, text })
}
const status = await child.exited
moments.push({ at: (performance.now() - started) / 1000, text: `${text}\n[exit ${status}]\n` })

const escape = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
const page = (s: string) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#16181d;color:#d7dae0}
body{display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
pre{margin:0;padding:24px;font:16px/1.4 Menlo,"DejaVu Sans Mono",monospace;white-space:pre-wrap}
</style><pre>${escape(s)}</pre>`

const work = await mkdtemp(join(tmpdir(), "land-record-"))
try {
  const list: string[] = []
  for (const [i, moment] of moments.entries()) {
    const html = join(work, `${i}.html`)
    const png = join(work, `${i}.png`)
    await writeFile(html, page(moment.text))
    const shot = Bun.spawnSync(
      [chrome, "--headless", "--hide-scrollbars", `--screenshot=${png}`, "--window-size=1280,720", `file://${html}`],
      { stdout: "ignore", stderr: "ignore" },
    )
    if (shot.exitCode !== 0) throw new Error(`Chrome could not draw frame ${i}`)
    // The last frame stays two seconds, so the end can be read.
    const until = moments[i + 1]?.at ?? moment.at + 2
    list.push(`file '${png}'`, `duration ${Math.max(until - moment.at, 0.04).toFixed(3)}`)
  }
  list.push(`file '${join(work, `${moments.length - 1}.png`)}'`)
  await writeFile(join(work, "frames.txt"), `${list.join("\n")}\n`)
  const out = join(media, `${name}.mp4`)
  const encoded = Bun.spawnSync(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt")].concat([
      "-vf",
      "fps=25,format=yuv420p",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      out,
    ]),
    { stdout: "inherit", stderr: "inherit" },
  )
  if (encoded.exitCode !== 0) throw new Error("ffmpeg could not write the video")
} finally {
  await rm(work, { recursive: true, force: true })
}
process.exit(status)
