import { DownloadFailedError, DownloadLaunchError } from "./downloader.js";
import { TelegramDownloadError, TelegramFileTooBigError } from "./telegram-file.js";
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
  /** Feature 3, R9.2: an accepted document, before the existence check. */
  docAck: "Got it, checking your Kindle…",
  /** Feature 3, R2.3: `formats` are the keys of `documentFolders`. */
  unsupportedFormat: (formats: readonly string[]) =>
    `I can't send that kind of file. Send me one of: ${formats.map((f) => f.toUpperCase()).join(", ")}.`,
  /** Feature 3, R2.5 (size known) and R6.4 (size unknown: getFile refused it). */
  tooBig: (sizeBytes?: number) =>
    `That file is ${sizeBytes === undefined ? "too big" : formatMb(sizeBytes)}; ` +
    "I can only fetch files up to 20 MB from Telegram.",
  /** Feature 3, R5.1 */
  alreadyExists: (name: string) => `“${name}” is already on your Kindle. Replace it?`,
  /** Feature 3, R5.6 */
  overwriteCancelled: (name: string) => `OK, I left “${name}” as it was. Nothing was sent.`,
  /** Feature 3, R5.9 */
  confirmationExpired: "That request is no longer pending. Send me the file again.",
  /** Feature 3, R7.2 */
  docDelivered: (name: string) => `Delivered “${name}” to your Kindle.`,
  /** Feature 3, R6.3 */
  docDownloadFailed: (detail: string) => `I couldn't get that file from Telegram: ${detail}`,
  /** Feature 3, R4.7, R7.3: reported, never enqueued. */
  docSendFailed: (name: string, detail: string) =>
    `I couldn't send “${name}” to your Kindle (${detail}). ` +
    "Is it awake and on the Wi-Fi? Send me the file again when it is.",
} as const;

/** `26529382` → `"25.3 MB"`, `26214400` → `"25 MB"` (binary MB, as Telegram's limit). */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
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

/**
 * Feature 3: the documents' equivalent of `failureMessage`, the single place where a document
 * failure becomes text. Separate because the fics' texts talk about links and titles. Anything
 * unrecognized becomes the generic message, and the caller logs the real error.
 */
export function documentFailureMessage(err: unknown, name: string): string {
  if (err instanceof TelegramFileTooBigError) return messages.tooBig();
  if (err instanceof TelegramDownloadError) return messages.docDownloadFailed(err.message);
  if (err instanceof UploadConfigError) return messages.uploadConfig(err.message);
  if (err instanceof UploadFailedError) return messages.docSendFailed(name, err.message);
  return messages.unexpected;
}
