/** How much of a subprocess's stderr is kept, for the logs (`error.stderr`). */
const STDERR_TAIL_CHARS = 2000;

/** Longest summary line put in an error message. */
const SUMMARY_MAX_CHARS = 300;

/** Appends a stderr chunk to `tail`, keeping only the last {@link STDERR_TAIL_CHARS} characters. */
export function appendTail(tail: string, chunk: Buffer | string): string {
  return (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
}

/**
 * Short summary of a stderr tail: its last `maxLines` non-empty lines joined with " | ", capped.
 * For a Python traceback one line is enough (the exception line is the last); `scp` needs two,
 * because OpenSSH prints the cause (`ssh: connect to host … Host is down`) and then scp adds a
 * generic `scp: Connection closed`. The owner never sees a stack trace.
 */
export function summarizeStderr(stderr: string, maxLines = 1): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const summary = lines.slice(-maxLines).join(" | ");
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary;
}
