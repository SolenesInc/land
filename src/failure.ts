import { Data } from "effect"

// A landing that stops. land prints the message after "land: " and exits with the status.
export class LandFailed extends Data.TaggedError("LandFailed")<{
  readonly message: string
  readonly status?: number
}> {}
