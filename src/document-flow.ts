import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";
import { type DocumentInfo, validateDocument } from "./document.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import { documentFailureMessage, messages } from "./messages.js";
import { createPendingStore, type PendingOverwrite, type PendingStore } from "./pending.js";
import { existsOnKindle, type SshTarget, UploadFailedError } from "./ssh.js";
import { downloadTelegramFile, type TelegramFileDeps } from "./telegram-file.js";
import { uploadToKindle } from "./uploader.js";

/** How long an overwrite question stays answerable (R5.8). Not config: nobody asked for it. */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

/** The slice of the config the document flow needs. */
export type DocumentConfig = Pick<
  ResolvedConfig,
  | "telegramToken"
  | "documentFolders"
  | "downloadTimeoutMs"
  | "uploadTimeoutMs"
  | "sshConnectTimeoutSec"
  | "kindlePort"
  | "sshKeyPath"
  | "kindleUser"
  | "kindleHost"
>;

/** Everything the flow touches outside itself, injectable so tests need no subprocess, disk or network. */
export type DocumentDeps = {
  exists: typeof existsOnKindle;
  /** `downloadTelegramFile`, bound to the token, the timeout and the bot's `getFile`. */
  download: (fileId: string, destPath: string) => Promise<void>;
  upload: typeof uploadToKindle;
  pending: PendingStore;
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  logger: Logger;
};

/** What the flow needs from the chat, so tests need no grammY context. */
export type ChatIO = {
  reply: (text: string) => Promise<unknown>;
  /** Replies with the "Replace" / "Cancel" buttons for pending confirmation `id`. */
  askOverwrite: (text: string, id: string) => Promise<unknown>;
};

/** A document as the flow receives it: grammY's `Document`, reduced to what is used. */
export type IncomingDocument = DocumentInfo & { file_id: string; file_unique_id?: string };

export type DocumentFlow = {
  /** Handles one document from the owner. Never throws. */
  onDocument(doc: IncomingDocument, io: ChatIO): Promise<void>;
  /** Handles a tap on "Replace" / "Cancel". Never throws. */
  onDecision(id: string, action: "replace" | "cancel", io: ChatIO): Promise<void>;
};

/**
 * Builds the production `download`: `downloadTelegramFile` with the config's token and
 * `downloadTimeoutMs`, and the bot's `getFile` (R6.1, R6.2). The token stays inside this closure.
 */
export function telegramDownloader(
  config: Pick<ResolvedConfig, "telegramToken" | "downloadTimeoutMs">,
  getFile: TelegramFileDeps["getFile"],
  fetchImpl: typeof fetch = fetch,
): DocumentDeps["download"] {
  return (fileId, destPath) =>
    downloadTelegramFile(
      fileId,
      destPath,
      { token: config.telegramToken, timeoutMs: config.downloadTimeoutMs },
      { getFile, fetch: fetchImpl },
    );
}

/**
 * The document flow (design.md): validate → ack → existence check over ssh → either deliver at
 * once, or store a pending confirmation, ask, and return (R5.4). A decision takes the pending entry
 * and either reports "cancelled" or delivers.
 *
 * Delivery = temp dir → download from Telegram under the sanitized name → `scp` to the format's
 * folder → delete the temp dir in a `finally` (R7.1–R7.5). Every failure is reported, never
 * enqueued (R7.3): this module has no access to the retry queue. A failed Telegram send is logged
 * and ignored. Logs never carry the token or the download URL (R6.5).
 */
export function createDocumentFlow(
  config: DocumentConfig,
  overrides: Partial<DocumentDeps> & Pick<DocumentDeps, "download">,
): DocumentFlow {
  const deps: DocumentDeps = {
    exists: existsOnKindle,
    upload: uploadToKindle,
    pending: createPendingStore({ ttlMs: CONFIRMATION_TTL_MS }),
    makeTempDir: () => mkdtemp(join(tmpdir(), "bookcarrier-doc-")),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    logger: defaultLogger,
    ...overrides,
  };
  const { logger } = deps;
  const formats = [...config.documentFolders.keys()];

  const target: SshTarget = {
    sshKeyPath: config.sshKeyPath,
    kindleUser: config.kindleUser,
    kindleHost: config.kindleHost,
    port: config.kindlePort,
    connectTimeoutSec: config.sshConnectTimeoutSec,
    timeoutMs: config.uploadTimeoutMs,
  };

  /** A failed Telegram send is logged and ignored: it must not abort a delivery. */
  const say = async (io: ChatIO, message: string): Promise<void> => {
    try {
      await io.reply(message);
    } catch (err) {
      logger.warn("could not send a Telegram message", { error: err });
    }
  };

  const stderrOf = (err: unknown): string | undefined =>
    err instanceof UploadFailedError ? err.stderr : undefined;

  /** The single path to the Kindle, used by the direct case and by "Replace". */
  const deliver = async (entry: PendingOverwrite, io: ChatIO): Promise<void> => {
    const { safeName, folder } = entry;
    let dir: string | undefined;
    try {
      dir = await deps.makeTempDir();
      const localPath = join(dir, safeName);
      await deps.download(entry.fileId, localPath);
      await deps.upload(localPath, { ...target, remotePath: folder });
      logger.info("document delivered", { safeName, folder });
      await say(io, messages.docDelivered(safeName));
    } catch (err) {
      logger.error("document delivery failed", { safeName, folder, error: err, stderr: stderrOf(err) });
      await say(io, documentFailureMessage(err, safeName));
    } finally {
      if (dir !== undefined) {
        const tempDir = dir;
        try {
          await deps.removeDir(tempDir);
        } catch (err) {
          logger.warn("could not remove the document's temp dir", { dir: tempDir, error: err });
        }
      }
    }
  };

  const onDocument = async (doc: IncomingDocument, io: ChatIO): Promise<void> => {
    try {
      const check = validateDocument(doc, config.documentFolders);
      if (!check.ok) {
        logger.info("document rejected", {
          fileUniqueId: doc.file_unique_id,
          reason: check.reason,
          size: doc.file_size,
        });
        await say(
          io,
          check.reason === "too-big" ? messages.tooBig(check.sizeBytes) : messages.unsupportedFormat(formats),
        );
        return;
      }

      const { safeName, extension, folder } = check;
      logger.info("document accepted", {
        fileUniqueId: doc.file_unique_id,
        safeName,
        extension,
        folder,
        size: doc.file_size,
      });
      await say(io, messages.docAck);

      let exists: boolean;
      try {
        exists = await deps.exists(folder + safeName, target);
      } catch (err) {
        logger.error("document existence check failed", { safeName, folder, error: err, stderr: stderrOf(err) });
        await say(io, documentFailureMessage(err, safeName));
        return;
      }

      const entry: PendingOverwrite = { fileId: doc.file_id, safeName, folder };
      if (!exists) {
        await deliver(entry, io);
        return;
      }

      // R5.2–R5.4: keep only what is needed to continue, ask, and return without waiting.
      const id = deps.pending.add(entry);
      logger.info("document already on the Kindle; asking", { safeName, folder, id });
      try {
        await io.askOverwrite(messages.alreadyExists(safeName), id);
      } catch (err) {
        // Without the question the owner has no buttons to tap: drop the entry and say so.
        logger.warn("could not send the overwrite question", { id, error: err });
        deps.pending.take(id);
        await say(io, messages.unexpected);
      }
    } catch (err) {
      logger.error("unexpected error handling a document", { error: err });
      await say(io, messages.unexpected);
    }
  };

  const onDecision = async (id: string, action: "replace" | "cancel", io: ChatIO): Promise<void> => {
    try {
      const entry = deps.pending.take(id);
      if (entry === undefined) {
        logger.info("overwrite decision for a request no longer pending", { id, action });
        await say(io, messages.confirmationExpired);
        return;
      }
      logger.info("overwrite decision", { id, action, safeName: entry.safeName });
      if (action === "cancel") {
        await say(io, messages.overwriteCancelled(entry.safeName));
        return;
      }
      await deliver(entry, io);
    } catch (err) {
      logger.error("unexpected error handling an overwrite decision", { id, error: err });
      await say(io, messages.unexpected);
    }
  };

  return { onDocument, onDecision };
}
