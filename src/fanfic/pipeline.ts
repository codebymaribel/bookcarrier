import type { Logger, ResolvedConfig } from "../shared/index.js";
import { failureMessage, messages } from "./messages.js";
import type { Queue, QueueItem, Spool } from "../retry-queue/index.js";
import { UploadFailedError, type UploadOptions, type uploadToKindle } from "../kindle/index.js";
import { extractWorkLink } from "./ao3-link.js";
import { DownloadFailedError, type DownloadResult, type downloadEpub } from "./downloader.js";
import { classifyFailure, isRateLimited } from "./failure.js";

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
  | "deferredRetryMs"
  | "deferredGiveUpAfterMs"
>;

/** Everything the pipeline touches outside itself, injectable so tests need no subprocess or disk. */
export type PipelineDeps = {
  download: typeof downloadEpub;
  upload: typeof uploadToKindle;
  spool: Pick<Spool, "prepare" | "discard">;
  queue: Pick<Queue, "enqueue" | "promoteToUpload" | "recordFailure" | "remove" | "cooldownUntil">;
  newId: () => string;
  logger: Logger;
  /** Clock for the cooldown message; defaults to `Date.now`. */
  now?: () => number;
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

/**
 * The whole log line for a download AO3 refused with a 429. Its traceback is long and always the
 * same, so it is left out; any other failure still logs its error and stderr.
 */
const RATE_LIMITED_LOG = "download failed -> 429 Client Error: Too Many Requests";

/** The AO3 work id of a queued request (its `url` is canonical), or the url itself if it has none. */
function workIdOf(url: string): string {
  const link = extractWorkLink(url);
  return link.ok ? link.workId : url;
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
 * Rate-limit deferral: when the window runs out while AO3 still answers 429, the item is kept as
 * deferred (spool and all), the owner is told once, and it is retried every `deferredRetryMs`
 * until `deferredGiveUpAfterMs` after its first enqueue. While any item is deferred, a new link is
 * deferred straight away (to the earliest deferred attempt) instead of hitting AO3 again.
 *
 * All download/upload work, from requests and retries alike, runs one at a time through a single
 * promise chain: AO3 sees one request at a time and two fic scp never race for the Kindle. Documents
 * sent as files (documents/flow.ts) do not join this chain; by default they go to a different folder.
 */
export function createPipeline(config: RequestConfig, deps: PipelineDeps): Pipeline {
  const { logger, spool, queue } = deps;
  const windowMinutes = Math.round(config.giveUpAfterMs / 60_000);
  const deferredLimitHours = Math.round(config.deferredGiveUpAfterMs / 3_600_000);
  const now = deps.now ?? Date.now;

  const uploadOptions: UploadOptions = {
    sshKeyPath: config.sshKeyPath,
    kindleUser: config.kindleUser,
    kindleHost: config.kindleHost,
    port: config.kindlePort,
    remotePath: config.remotePath,
    connectTimeoutSec: config.sshConnectTimeoutSec,
    timeoutMs: config.uploadTimeoutMs,
  };

  /**
   * The last AO3 rate limit seen on a retry (in memory only). A deferred download that became due
   * at or before it is not sent to AO3: the limit is still on, so it waits another deferral (S6).
   */
  let lastRateLimit: { at: number; error: string } | undefined;

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

    const id = deps.newId();

    // S6: AO3 is cooling down (some request is deferred by its rate limit): do not hit it again.
    const cooldownUntil = queue.cooldownUntil();
    if (cooldownUntil !== undefined) {
      try {
        await queue.enqueue({
          id,
          url: link.canonicalUrl,
          stage: "download",
          error: messages.rateLimitedReason,
          deferredUntil: cooldownUntil,
        });
        logger.info("deferred during the AO3 cooldown", { workId: link.workId, id, cooldownUntil });
        await say(messages.deferredNew(cooldownUntil - now(), deferredLimitHours));
        return;
      } catch (err) {
        logger.error("could not defer during the cooldown; trying now", { workId: link.workId, error: err });
      }
    }

    await say(messages.ack);
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
        if (isRateLimited(err)) logger.warn(RATE_LIMITED_LOG, { workId: link.workId });
        else logger.error("request failed", { workId: link.workId, error: err, stderr: stderrOf(err) });
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
    const cooling =
      lastRateLimit !== undefined &&
      current.deferred === true &&
      current.stage === "download" &&
      current.nextAttemptAt <= lastRateLimit.at;
    try {
      if (cooling && lastRateLimit !== undefined) {
        logger.info("AO3 still rate-limiting; not retrying this deferred download now", { id: current.id });
        throw new RateLimitStillOn(lastRateLimit.error);
      }
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
      if (isRateLimited(err)) logger.warn(RATE_LIMITED_LOG, { workId: workIdOf(current.url) });
      else logger.warn("retry failed", { id: current.id, error: err, stderr: stderrOf(err) });
      if (!(err instanceof RateLimitStillOn) && classifyFailure(err) === "permanent") {
        await queue.remove(current.id);
        await discard(current.id);
        await safely(notify, failureMessage(err, current.title));
        return;
      }
      const name = current.title ?? current.url;
      const rateLimited = err instanceof RateLimitStillOn || isRateLimited(err);
      if (rateLimited && !(err instanceof RateLimitStillOn)) {
        lastRateLimit = { at: now(), error: errorText(err) };
      }
      const outcome = await queue.recordFailure(current.id, errorText(err), { rateLimited });
      if (outcome.deferred) {
        // S1, S5: the window ran out under AO3's rate limit; kept (with its spool) for later.
        logger.warn("deferred by the AO3 rate limit", {
          id: current.id,
          nextAttemptAt: outcome.item.nextAttemptAt,
        });
        await safely(
          notify,
          messages.deferred(name, outcome.item.nextAttemptAt - now(), deferredLimitHours),
        );
        return;
      }
      if (!outcome.giveUp) return;
      logger.warn("gave up", { id: current.id, lastError: outcome.item.lastError });
      await discard(current.id);
      await safely(
        notify,
        outcome.item.deferred === true
          ? messages.gaveUpDeferred(name, outcome.item.lastError, deferredLimitHours)
          : messages.gaveUp(name, outcome.item.lastError, windowMinutes),
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

/** A deferred download skipped because AO3 answered 429 since it became due; carries that error. */
class RateLimitStillOn extends Error {}
