import { Bot, type BotConfig, type Context, InlineKeyboard } from "grammy";
import { extractWorkLink } from "./ao3-link.js";
import type { ResolvedConfig } from "./config.js";
import {
  type ChatIO,
  createDocumentFlow,
  type DocumentConfig,
  type DocumentFlow,
  telegramDownloader,
} from "./document-flow.js";
import { DownloadFailedError, type DownloadResult, type downloadEpub } from "./downloader.js";
import { classifyFailure } from "./errors.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import { failureMessage, messages } from "./messages.js";
import type { Queue } from "./queue/queue.js";
import type { Spool } from "./queue/spool.js";
import type { QueueItem } from "./queue/state.js";
import { UploadFailedError, type UploadOptions, type uploadToKindle } from "./uploader.js";

/**
 * Global grammY middleware that only lets the owner through (R1.1).
 *
 * Any update whose `from.id` is not `ownerId` is dropped without calling `next()` and without
 * replying, so a stranger cannot even tell the bot exists and is active. Updates with no `from`
 * (e.g. channel posts) are dropped too: if we cannot tell who sent it, it is not the owner.
 *
 * It must be registered first (`bot.use(ownerOnly(id))`), before any handler.
 */
export function ownerOnly(
  ownerId: number,
): (ctx: Pick<Context, "from">, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return;
    await next();
  };
}

/** The slice of the config the pipeline needs (the tests do not build a full config). */
export type RequestConfig = Pick<
  ResolvedConfig,
  | "downloadTimeoutMs"
  | "uploadTimeoutMs"
  | "sshConnectTimeoutSec"
  | "kindlePort"
  | "remotePath"
  | "sshKeyPath"
  | "kindleUser"
  | "kindleHost"
  | "giveUpAfterMs"
  | "retryBackoffMinutes"
>;

/** Everything the pipeline touches outside itself, injectable so tests need no subprocess or disk. */
export type PipelineDeps = {
  download: typeof downloadEpub;
  upload: typeof uploadToKindle;
  spool: Pick<Spool, "prepare" | "discard">;
  queue: Pick<Queue, "enqueue" | "promoteToUpload" | "recordFailure" | "remove">;
  newId: () => string;
  logger: Logger;
};

/** Sends one text to the owner; failures are the caller's to swallow. */
export type Send = (text: string) => Promise<unknown>;

export type Pipeline = {
  /** Handles one message from the owner, end to end. Never throws. */
  handle(text: string, reply: Send): Promise<void>;
  /** Retries the due queue items, one after the other. Never throws for a single item's failure. */
  processDue(due: readonly QueueItem[], notify: Send): Promise<void>;
};

/** Tail of the subprocess's stderr, when the error carries one: for the logs, never for the owner. */
function stderrOf(err: unknown): string | undefined {
  return err instanceof DownloadFailedError || err instanceof UploadFailedError
    ? err.stderr
    : undefined;
}

/** The short error text kept in the queue and shown on give-up. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the delivery pipeline shared by new requests and retries.
 *
 * New request: validate the link → acknowledge → download into the spool → send → confirm. On a
 * failure the error is classified ({@link classifyFailure}): a transient one is enqueued at the
 * stage it failed in, keeping the EPUB if it was already downloaded, and the owner is told once
 * that it will be retried (R1.1, R1.3, R6.1); a permanent one is reported as in feature 1 and the
 * spool is cleaned (R1.2, R1.4).
 *
 * Retry: only the item's stage runs (R3.1). A download that succeeds is promoted to `upload` and
 * the upload follows at once (R3.2). Delivered → removed, spool cleaned, owner notified with the
 * title (R6.2, R5.2). Transient failure → `recordFailure` schedules the next step silently (R6.3),
 * or gives up past the window: spool cleaned and owner told the last error (R4, R6.4). A permanent
 * failure on a retry is removed and reported.
 *
 * All download/upload work, from requests and retries alike, runs one at a time through a single
 * promise chain: AO3 sees one request at a time and two scp never race for the Kindle.
 */
export function createPipeline(config: RequestConfig, deps: PipelineDeps): Pipeline {
  const { logger, spool, queue } = deps;
  const windowMinutes = Math.round(config.giveUpAfterMs / 60_000);

  const uploadOptions: UploadOptions = {
    sshKeyPath: config.sshKeyPath,
    kindleUser: config.kindleUser,
    kindleHost: config.kindleHost,
    port: config.kindlePort,
    remotePath: config.remotePath,
    connectTimeoutSec: config.sshConnectTimeoutSec,
    timeoutMs: config.uploadTimeoutMs,
  };

  let chain: Promise<unknown> = Promise.resolve();
  /** Runs `work` after every earlier piece of work has finished. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work, work);
    chain = result.catch(() => undefined);
    return result;
  };

  /** A failed Telegram send is logged and ignored: it must not abort a delivery. */
  const safely = async (send: Send, message: string): Promise<void> => {
    try {
      await send(message);
    } catch (err) {
      logger.warn("could not send a Telegram message", { error: err });
    }
  };

  const discard = async (id: string): Promise<void> => {
    await spool.discard(id).catch((err: unknown) => {
      logger.warn("could not clean the spool", { id, error: err });
    });
  };

  const download = async (id: string, url: string): Promise<DownloadResult> => {
    const dir = await spool.prepare(id);
    return deps.download(url, dir, { timeoutMs: config.downloadTimeoutMs });
  };

  const handle = async (text: string, reply: Send): Promise<void> => {
    const say = (message: string) => safely(reply, message);

    const link = extractWorkLink(text);
    if (!link.ok) {
      await say(link.reason === "no-ao3-link" ? messages.noLink : messages.unsupportedLink);
      return;
    }

    await say(messages.ack);
    const id = deps.newId();
    logger.info("request accepted", { workId: link.workId, id });

    await exclusive(async () => {
      let result: DownloadResult | undefined;
      try {
        result = await download(id, link.canonicalUrl);
        await deps.upload(result.filePath, uploadOptions);
        logger.info("delivered", { workId: link.workId, title: result.title });
        await say(messages.delivered(result.title));
        await discard(id);
        return;
      } catch (err) {
        logger.error("request failed", { workId: link.workId, error: err, stderr: stderrOf(err) });
        if (classifyFailure(err) === "transient") {
          try {
            await queue.enqueue({
              id,
              url: link.canonicalUrl,
              stage: result === undefined ? "download" : "upload",
              ...(result !== undefined && { epubPath: result.filePath, title: result.title }),
              error: errorText(err),
            });
            logger.info("enqueued", { workId: link.workId, id });
            await say(
              result === undefined
                ? messages.queuedDownload(errorText(err), windowMinutes)
                : messages.queuedUpload(result.title, errorText(err), windowMinutes),
            );
            return;
          } catch (enqueueErr) {
            logger.error("could not enqueue", { workId: link.workId, error: enqueueErr });
          }
        }
        await say(failureMessage(err, result?.title));
        await discard(id);
      }
    });
  };

  /** One retry of one item; every outcome ends with the item updated or removed. */
  const retry = async (item: QueueItem, notify: Send): Promise<void> => {
    let current = item;
    try {
      if (current.stage === "download") {
        const result = await download(current.id, current.url);
        current = await queue.promoteToUpload(current.id, result.filePath, result.title);
      }
      if (current.epubPath === undefined) throw new Error(`queue item ${current.id} has no EPUB`);
      await deps.upload(current.epubPath, uploadOptions);
      logger.info("delivered on retry", { id: current.id, title: current.title });
      await queue.remove(current.id);
      await discard(current.id);
      await safely(notify, messages.delivered(current.title ?? current.url));
    } catch (err) {
      logger.warn("retry failed", { id: current.id, error: err, stderr: stderrOf(err) });
      if (classifyFailure(err) === "permanent") {
        await queue.remove(current.id);
        await discard(current.id);
        await safely(notify, failureMessage(err, current.title));
        return;
      }
      const outcome = await queue.recordFailure(current.id, errorText(err));
      if (!outcome.giveUp) return;
      logger.warn("gave up", { id: current.id, lastError: outcome.item.lastError });
      await discard(current.id);
      await safely(
        notify,
        messages.gaveUp(current.title ?? current.url, outcome.item.lastError, windowMinutes),
      );
    }
  };

  const processDue = async (due: readonly QueueItem[], notify: Send): Promise<void> => {
    for (const item of due) {
      await exclusive(() => retry(item, notify)).catch((err: unknown) => {
        logger.error("could not process a queued item", { id: item.id, error: err });
      });
    }
  };

  return { handle, processDue };
}

/** A {@link Send} that writes to the owner's private chat: retries have no message to reply to. */
export function notifyOwner(bot: Bot, ownerId: number): Send {
  return (text) => bot.api.sendMessage(ownerId, text);
}

/**
 * `callback_data` of the overwrite buttons: `ow:<8-char id>:y` (Replace) or `:n` (Cancel). Only the
 * pending id and the action, never the file name; 13 bytes, far under Telegram's 64 (R5.3). The
 * `ow:` prefix namespaces it from future buttons.
 */
export const OVERWRITE_DATA = /^ow:([A-Za-z0-9_-]{8}):(y|n)$/;

/** The "Replace" / "Cancel" keyboard for pending confirmation `id` (R5.1). */
export function overwriteKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text("Replace", `ow:${id}:y`).text("Cancel", `ow:${id}:n`);
}

/** The {@link ChatIO} for one update: plain-text replies in the update's chat (R9.1). */
function chatIO(ctx: Context): ChatIO {
  return {
    reply: (text) => ctx.reply(text),
    askOverwrite: (text, id) => ctx.reply(text, { reply_markup: overwriteKeyboard(id) }),
  };
}

/**
 * Creates the grammY bot: owner filter first (R1.1, it also drops strangers' documents and button
 * taps), then the text handler (AO3 links → pipeline) and the document flow (feature 3): documents
 * and overwrite button taps. A text never reaches the document flow and a document never reaches
 * the link extraction (R2.1).
 *
 * `documents` defaults to the real flow, whose download uses this bot's `getFile`. `grammy` and
 * `documents` are only for tests (e.g. a preset `botInfo` so no `getMe` call is made).
 */
export function createBot(
  config: Pick<ResolvedConfig, "telegramToken" | "ownerId"> & DocumentConfig,
  pipeline: Pick<Pipeline, "handle">,
  grammy?: BotConfig<Context>,
  documents?: DocumentFlow,
): Bot {
  const bot = new Bot(config.telegramToken, grammy);
  const docs =
    documents ??
    createDocumentFlow(config, { download: telegramDownloader(config, (fileId) => bot.api.getFile(fileId)) });
  const logWarn = (what: string) => (err: unknown) => {
    defaultLogger.warn(`could not ${what}`, { error: err });
  };

  bot.use(ownerOnly(config.ownerId));
  bot.on("message:text", (ctx) => pipeline.handle(ctx.message.text, (text) => ctx.reply(text)));
  bot.on("message:document", (ctx) => docs.onDocument(ctx.message.document, chatIO(ctx)));
  bot.callbackQuery(OVERWRITE_DATA, async (ctx) => {
    // R5.7: stop the spinner and remove the buttons whatever happens next; failures only logged.
    await ctx.answerCallbackQuery().catch(logWarn("answer a callback query"));
    await ctx.editMessageReplyMarkup().catch(logWarn("remove the overwrite buttons"));
    const [, id = "", action] = ctx.match;
    await docs.onDecision(id, action === "y" ? "replace" : "cancel", chatIO(ctx));
  });
  // Any other button tap: stop the spinner and ignore it.
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery().catch(logWarn("answer a callback query")));
  return bot;
}
