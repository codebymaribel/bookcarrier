import { messages as kindle, UploadConfigError, UploadFailedError } from "../kindle/index.js";
import { messages as shared } from "../shared/index.js";
import { DownloadFailedError, DownloadLaunchError } from "./downloader.js";

/**
 * Every text the bot sends the owner about fics (AO3 links), in one place. Plain text on purpose (no
 * parse_mode), so a title with `_`, `*` or `[` can never break the message. Never contains a stack trace.
 *
 * `uploadConfig` and `unexpected` are owned by the kindle and shared contexts and only re-exposed
 * here, so every message this context sends is reachable from one object: change their wording there.
 */
export const messages = {
  /** R2.1 */
  ack: "Got it, downloading…",
  /** R2.2 */
  noLink:
    "I don't recognize a valid AO3 link in that message. Share a link to a work (archiveofourown.org/works/…).",
  /** R2.3 */
  unsupportedLink: "That type of AO3 link isn't supported yet. Send me a link to a single work.",
  /** R5.4 */
  delivered: (title: string) => `Delivered “${title}” to your Kindle.`,
  /** Feature 5, R6.2: a followed fic delivered again; its stored chapter count was updated. */
  deliveredFollowUpdated: (title: string, chapters: number) =>
    `Delivered “${title}” to your Kindle. I updated your follow: now ${chapterCount(chapters)}.`,
  /** Feature 5, R6.4: a followed fic delivered again that is complete now. */
  deliveredCompletedUnfollowed: (title: string) =>
    `Delivered “${title}” to your Kindle. It's complete now, so I'm no longer following it.`,
  /** R3.3, R3.4 */
  downloadFailed: (detail: string) => `I couldn't download that fic: ${detail}`,
  /** R3.5 */
  fanficfareNotLaunchable: (detail: string) =>
    `I couldn't start FanFicFare, so nothing was downloaded: ${detail}`,
  /** R5.3, R5.7 */
  sendFailed: (title: string, detail: string) =>
    `I downloaded “${title}” but couldn't send it to your Kindle (${detail}). ` +
    "Is it awake and on the Wi-Fi? Share the link again when it is.",
  uploadConfig: kindle.uploadConfig,
  unexpected: shared.unexpected,
  /** Feature 2, R1.1 + R6.1: a download that failed transiently and was enqueued. */
  queuedDownload: (detail: string, windowMinutes: number) =>
    `I couldn't download that fic right now (${detail}). ` +
    `I'll keep retrying for up to ${windowMinutes} minutes and tell you how it goes.`,
  /** Feature 2, R1.3 + R6.1: a downloaded fic whose upload failed transiently and was enqueued. */
  queuedUpload: (title: string, detail: string, windowMinutes: number) =>
    `I downloaded “${title}” but couldn't send it to your Kindle (${detail}). ` +
    `I'll keep retrying for up to ${windowMinutes} minutes; it will get there once the Kindle is awake and on the Wi-Fi.`,
  /** Feature 2, R4.1 + R6.4 */
  gaveUp: (name: string, lastError: string, windowMinutes: number) =>
    `I gave up on “${name}” after ${windowMinutes} minutes of retries. Last error: ${lastError}. ` +
    "Share the link again to try once more.",
  /** Rate-limit deferral, S1 + S5: the 30-minute window ran out while AO3 still answers 429. */
  deferred: (name: string, retryInMs: number, limitHours: number) =>
    `${RATE_LIMIT_TROUBLE}so I saved “${name}” and will try again in about ${formatWait(retryInMs)}. ` +
    `I'll keep trying for up to ${limitHours} hours from your first request and tell you how it goes.`,
  /** Rate-limit deferral, S6: a new link during the cooldown, saved without touching AO3. */
  deferredNew: (retryInMs: number, limitHours: number) =>
    `${RATE_LIMIT_TROUBLE}so I saved your request without downloading it and will try again in about ${formatWait(retryInMs)}. ` +
    `I'll keep trying for up to ${limitHours} hours and tell you how it goes.`,
  /** Rate-limit deferral, S4: a deferred request abandoned at the limit. */
  gaveUpDeferred: (name: string, lastError: string, limitHours: number) =>
    `I gave up on “${name}”: AO3 kept rate-limiting FanFicFare for ${limitHours} hours. Last error: ${lastError}. ` +
    "Share the link again to try once more.",
  /** Rate-limit deferral, S6: the `lastError` stored for a link deferred during the cooldown. */
  rateLimitedReason: "not tried: AO3 was rate-limiting FanFicFare (429 Too Many Requests)",
} as const;

const RATE_LIMIT_TROUBLE =
  "FanFicFare is having trouble with AO3 right now (it keeps getting “429 Too Many Requests”), ";

/** `1` → `"1 chapter"`, `12` → `"12 chapters"`. */
function chapterCount(chapters: number): string {
  return `${chapters} ${chapters === 1 ? "chapter" : "chapters"}`;
}

/** A wait for the owner: whole minutes up to 90 (at least 1), whole hours past that. */
function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes <= 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

/**
 * The single place where a failure becomes a message for the owner. Maps each error class to its
 * text; anything else (a bug, an I/O error) becomes the generic message, and the caller logs the
 * real error. `title` is only known once the download has succeeded.
 */
export function failureMessage(err: unknown, title: string | undefined): string {
  if (err instanceof DownloadLaunchError) return messages.fanficfareNotLaunchable(err.message);
  if (err instanceof DownloadFailedError) return messages.downloadFailed(err.message);
  if (err instanceof UploadConfigError) return messages.uploadConfig(err.message);
  if (err instanceof UploadFailedError) return messages.sendFailed(title ?? "the fic", err.message);
  return messages.unexpected;
}
