import { DownloadFailedError } from "./downloader.js";
import { UploadFailedError } from "../kindle/uploader.js";

/**
 * Is this failure worth retrying? The single question the whole retry queue depends on (design.md).
 * - `transient`: it may work later (AO3 down or rate-limiting, a sleeping Kindle) → enqueue.
 * - `permanent`: retrying cannot fix it (no such work, broken config, a bug) → report, never enqueue.
 */
export type FailureKind = "transient" | "permanent";

/** FanFicFare stderr that means the work does not exist: the link will never download (R1.2). */
const PERMANENT_DOWNLOAD_PATTERNS: readonly RegExp[] = [
  /StoryDoesNotExist/i,
  /story does not exist/i,
  /\(404\)/,
  /HTTP Error 404/i,
];

/**
 * Classifies a failure from the downloader or the uploader.
 *
 * Downloads: a timeout or a non-zero exit is transient unless FanFicFare's stderr says the work does
 * not exist. An unrecognized exit is retried on purpose: the give-up window bounds the cost of being
 * wrong, while discarding a recoverable request (AO3 403/429/5xx, a network blip) would lose it.
 * An exit 0 without a single usable EPUB is permanent: running it again produces the same result.
 *
 * Uploads: the border is the one feature 1 already drew. `UploadFailedError` means scp was launched
 * and failed (most likely the Kindle is unreachable) → transient. `UploadConfigError` covers the key
 * checks and spawn's `'error'` event (binary missing) → permanent (R1.4).
 *
 * Everything else, including `DownloadLaunchError` and unexpected errors, is permanent: it is
 * reported once and never retried.
 */
export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof DownloadFailedError) {
    if (err.reason === "timeout") return "transient";
    if (err.reason !== "exit-code") return "permanent";
    const text = `${err.stderr}\n${err.message}`;
    return PERMANENT_DOWNLOAD_PATTERNS.some((re) => re.test(text)) ? "permanent" : "transient";
  }
  if (err instanceof UploadFailedError) return "transient";
  return "permanent";
}

/**
 * AO3 rate-limiting FanFicFare: `429 Too Many Requests` in its stderr or message. Patterns are
 * anchored to HTTP wording, so a work id that merely contains "429" never matches.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /Too Many Requests/i,
  /HTTP Error 429/i,
  /\b429 Client Error/i,
  /\(429\)/,
];

/**
 * Is this a download that AO3 refused because of its rate limit? Only these failures are deferred
 * for hours once the short retry window runs out (rate-limit deferral, S2); uploads never are.
 */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof DownloadFailedError) || err.reason !== "exit-code") return false;
  const text = `${err.stderr}\n${err.message}`;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}
