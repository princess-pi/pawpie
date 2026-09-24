// Names which path a read failure came from, so a caller can report the
// actual offending file instead of guessing from which call site threw.
export class ReadFailure extends Error {
  constructor(public readonly failedPath: string, cause: unknown) {
    super(`could not read ${failedPath}: ${(cause as Error).message}`, { cause });
  }
}

export function errorCode(err: unknown): string | undefined {
  const cause = err instanceof ReadFailure ? err.cause : err;
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}
