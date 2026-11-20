export type LogLevel = "info" | "warn" | "error";

export type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

export type LoggerOptions = {
  /** Destination for each formatted line. Default: stdout for info, stderr for warn/error. */
  write?: (level: LogLevel, line: string) => void;
  /** Injectable clock for tests. */
  now?: () => Date;
};

/**
 * Writes to the stream without waiting for the flush: `process.stdout.write` is async
 * when the destination is a pipe or a file (the launchd case), so it does not
 * block the main loop.
 */
function defaultWrite(level: LogLevel, line: string): void {
  const stream = level === "info" ? process.stdout : process.stderr;
  stream.write(`${line}\n`);
}

/**
 * Formats a log line: `<ISO timestamp> <LEVEL> <message> [meta JSON]`.
 * An `Error` inside meta is serialized as `{ name, message }` (no stack),
 * because `JSON.stringify` of an Error returns `{}`.
 */
export function formatLine(
  date: Date,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): string {
  const base = `${date.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (meta === undefined || Object.keys(meta).length === 0) return base;
  const json = JSON.stringify(meta, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
  return `${base} ${json}`;
}

/** Creates a logger with info/warn/error levels and a timestamp on every line. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const log =
    (level: LogLevel) =>
    (message: string, meta?: Record<string, unknown>): void => {
      write(level, formatLine(now(), level, message, meta));
    };
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

/** Default logger of the daemon. */
export const logger: Logger = createLogger();
