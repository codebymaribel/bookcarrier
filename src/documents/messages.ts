import { messages as kindle, UploadConfigError, UploadFailedError } from "../kindle/index.js";
import { messages as shared } from "../shared/index.js";
import { TelegramDownloadError, TelegramFileTooBigError } from "./telegram-file.js";

/**
 * Every text the bot sends the owner about documents sent as files, in one place. Plain text on purpose (no
 * parse_mode), so a title with `_`, `*` or `[` can never break the message. Never contains a stack trace.
 *
 * `uploadConfig` and `unexpected` are owned by the kindle and shared contexts and only re-exposed
 * here, so every message this context sends is reachable from one object: change their wording there.
 */
export const messages = {
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
  uploadConfig: kindle.uploadConfig,
  unexpected: shared.unexpected,
} as const;

/** `26529382` → `"25.3 MB"`, `26214400` → `"25 MB"` (binary MB, as Telegram's limit). */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
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
