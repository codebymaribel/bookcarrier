import { DownloadFailedError, DownloadLaunchError } from "./downloader.js";
import { UploadConfigError, UploadFailedError } from "./uploader.js";

/**
 * Every text the bot sends the owner, in one place. Plain text on purpose (no parse_mode), so a
 * title with `_`, `*` or `[` can never break the message. Never contains a stack trace.
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
  /** R3.3, R3.4 */
  downloadFailed: (detail: string) => `I couldn't download that fic: ${detail}`,
  /** R3.5 */
  fanficfareNotLaunchable: (detail: string) =>
    `I couldn't start FanFicFare, so nothing was downloaded: ${detail}`,
  /** R5.3, R5.7 */
  sendFailed: (title: string, detail: string) =>
    `I downloaded “${title}” but couldn't send it to your Kindle (${detail}). ` +
    "Is it awake and on the Wi-Fi? Share the link again when it is.",
  /** R5.2, R5.5 */
  uploadConfig: (detail: string) =>
    `I can't send to the Kindle because of a configuration problem: ${detail}`,
  unexpected: "Something unexpected went wrong. Check the logs.",
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
  /** Feature 2, R2.5 */
  queueFileCorrupt: (backupPath: string) =>
    "The retry queue file was unreadable, so I started with an empty queue. " +
    `The old file was kept as ${backupPath} so it can be inspected.`,
} as const;

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
