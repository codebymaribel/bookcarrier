import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** What the download needs from the outside world; injected so tests need no network. */
export type TelegramFileDeps = {
  /** `bot.api.getFile` in production. */
  getFile: (fileId: string) => Promise<{ file_path?: string }>;
  fetch: typeof fetch;
};

/** `getFile` refused the file because it is bigger than the Bot API lets bots download (R6.4). */
export class TelegramFileTooBigError extends Error {
  constructor(message = "the file is bigger than Telegram lets bots download (20 MB)") {
    super(message);
    this.name = "TelegramFileTooBigError";
  }
}

export type TelegramDownloadReason = "get-file" | "no-path" | "http" | "timeout" | "network" | "empty";

/**
 * A failed download (R6.3). Its message names only the `file_path` and, for network failures, the
 * error's name/code: never the URL or the token (R6.5). No `cause` is attached on purpose, because
 * a `fetch` error's cause can carry the URL.
 */
export class TelegramDownloadError extends Error {
  readonly reason: TelegramDownloadReason;
  constructor(reason: TelegramDownloadReason, message: string) {
    super(message);
    this.name = "TelegramDownloadError";
    this.reason = reason;
  }
}

/**
 * Does this `getFile` rejection mean "the file is too big"? The exact Bot API text was not recorded
 * (odd L5), so this matches loosely on the description/message and stays the one place to adjust.
 */
export function isTooBigError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { description, message } = err as { description?: unknown; message?: unknown };
  const text = `${typeof description === "string" ? description : ""} ${typeof message === "string" ? message : ""}`;
  return /too big|too large/i.test(text);
}

/** `ECONNRESET`, `AbortError`…: the only parts of a foreign error that may reach our message. */
function errorLabel(err: unknown): string {
  const parts: string[] = [];
  const pick = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const { name, code } = value as { name?: unknown; code?: unknown };
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code) && !parts.includes(code)) parts.push(code);
    if (typeof name === "string" && /^[A-Za-z]+$/.test(name) && !parts.includes(name)) parts.push(name);
  };
  pick(err);
  pick((err as { cause?: unknown } | null)?.cause);
  return parts.length > 0 ? parts.join(", ") : "unknown error";
}

/** Rejects as soon as `signal` aborts, even if `promise` never settles (e.g. a fake ignoring it). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Downloads a Telegram file to `destPath` (R6.1). One `AbortSignal` bounds the whole call, `getFile`
 * included (R6.2). The file is created with `"wx"`: an existing file is never overwritten. Never puts
 * the token or the URL in an error (R6.5).
 */
export async function downloadTelegramFile(
  fileId: string,
  destPath: string,
  opts: { token: string; timeoutMs: number },
  deps: TelegramFileDeps,
): Promise<void> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const seconds = Math.round(opts.timeoutMs / 1000);
  const timedOut = (what: string): TelegramDownloadError =>
    new TelegramDownloadError("timeout", `${what} timed out after ${seconds}s`);

  let filePath: string | undefined;
  try {
    ({ file_path: filePath } = await raceAbort(deps.getFile(fileId), signal));
  } catch (err) {
    if (signal.aborted) throw timedOut("asking Telegram for the file");
    if (isTooBigError(err)) throw new TelegramFileTooBigError();
    const code = (err as { error_code?: unknown } | null)?.error_code;
    const detail = typeof code === "number" ? `${errorLabel(err)} ${code}` : errorLabel(err);
    throw new TelegramDownloadError("get-file", `Telegram's getFile failed (${detail})`);
  }
  if (filePath === undefined || filePath === "") {
    throw new TelegramDownloadError("no-path", "Telegram's getFile returned no file path");
  }

  const url = `https://api.telegram.org/file/bot${opts.token}/${filePath}`;
  let res: Response;
  try {
    res = await raceAbort(deps.fetch(url, { signal }), signal);
  } catch (err) {
    if (signal.aborted) throw timedOut(`downloading ${filePath}`);
    throw new TelegramDownloadError("network", `network error downloading ${filePath} (${errorLabel(err)})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new TelegramDownloadError("http", `HTTP ${res.status} downloading ${filePath}`);
  }
  if (res.body === null) {
    throw new TelegramDownloadError("empty", `Telegram sent an empty file for ${filePath}`);
  }

  try {
    await pipeline(
      Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>),
      createWriteStream(destPath, { flags: "wx" }),
      { signal },
    );
  } catch (err) {
    if (signal.aborted) throw timedOut(`downloading ${filePath}`);
    // A local write problem (e.g. EEXIST from "wx") is a bug, not a download failure: rethrow it.
    if ((err as { syscall?: unknown } | null)?.syscall !== undefined) throw err;
    throw new TelegramDownloadError("network", `network error downloading ${filePath} (${errorLabel(err)})`);
  }

  if ((await stat(destPath)).size === 0) {
    throw new TelegramDownloadError("empty", `Telegram sent an empty file for ${filePath}`);
  }
}
