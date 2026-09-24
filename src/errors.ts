// Names which path a read failure came from, so a caller can report the
// actual offending file instead of guessing from which call site threw.
export class ReadFailure extends Error {
  constructor(public readonly failedPath: string, cause: unknown) {
    super(`could not read ${failedPath}: ${(cause as Error).message}`);
  }
}
