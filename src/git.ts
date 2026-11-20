import { Effect } from "effect"
import { LandFailed } from "./failure.ts"

type Ran = { readonly status: number; readonly out: string; readonly err: string }

export const run = (argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  Effect.promise(async (): Promise<Ran> => {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: env === undefined ? process.env : { ...process.env, ...env },
    })
    const [out, err, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { status, out: out.trim(), err: err.trim() }
  })

export const git = (...args: ReadonlyArray<string>) => run(["git", ...args])

export const gitOk = (...args: ReadonlyArray<string>) =>
  git(...args).pipe(
    Effect.flatMap(({ status, out, err }) =>
      status === 0 ? Effect.succeed(out) : Effect.fail(new LandFailed({ message: `git ${args.join(" ")}: ${err}` })),
    ),
  )

export const succeeds = (...args: ReadonlyArray<string>) => git(...args).pipe(Effect.map(({ status }) => status === 0))
