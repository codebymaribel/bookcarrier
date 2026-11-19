import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, type BotConfig, type Context } from "grammy";
import { extractWorkLink } from "./ao3-link.js";
import type { ResolvedConfig } from "./config.js";
import { DownloadFailedError, downloadEpub } from "./downloader.js";
import { type Logger, logger as defaultLogger } from "./logger.js";
import { failureMessage, messages } from "./messages.js";
import { UploadFailedError, type UploadOptions, uploadToKindle } from "./uploader.js";

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

/** The slice of the config the request flow needs (the tests do not build a full config). */
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
>;

/** Everything the flow touches outside itself, injectable so tests need no subprocess or disk. */
export type RequestDeps = {
  download: typeof downloadEpub;
  upload: typeof uploadToKindle;
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  logger: Logger;
};

const defaultDeps: RequestDeps = {
  download: downloadEpub,
  upload: uploadToKindle,
  makeTempDir: () => mkdtemp(join(tmpdir(), "bookcarrier-")),
  removeDir: (dir) => rm(dir, { recursive: true, force: true }),
  logger: defaultLogger,
};

/** Tail of the subprocess's stderr, when the error carries one: for the logs, never for the owner. */
function stderrOf(err: unknown): string | undefined {
  return err instanceof DownloadFailedError || err instanceof UploadFailedError
    ? err.stderr
    : undefined;
}

/**
 * Builds the function that handles one message from the owner, end to end:
 * validate the link → acknowledge → download → send → confirm (or explain the failure).
 *
 * The returned function never throws: every failure ends in one message to the owner
 * ({@link failureMessage}) and one log line. It is meant to be `await`ed by the grammY handler, so
 * updates are processed one at a time (grammY's long polling is sequential) and nothing blocks
 * the event loop, since all I/O is async.
 *
 * `bot.ts` owns the request's temporary directory: it is created before the download and removed
 * in a `finally`, whether the request succeeded or failed (feature 2 replaces it with the spool).
 */
export function createRequestHandler(
  config: RequestConfig,
  overrides: Partial<RequestDeps> = {},
): (text: string, reply: (text: string) => Promise<unknown>) => Promise<void> {
  const deps: RequestDeps = { ...defaultDeps, ...overrides };
  const { logger } = deps;

  const uploadOptions: UploadOptions = {
    sshKeyPath: config.sshKeyPath,
    kindleUser: config.kindleUser,
    kindleHost: config.kindleHost,
    port: config.kindlePort,
    remotePath: config.remotePath,
    connectTimeoutSec: config.sshConnectTimeoutSec,
    timeoutMs: config.uploadTimeoutMs,
  };

  return async (text, reply) => {
    /** A failed Telegram send is logged and ignored: it must not abort the fic's delivery. */
    const say = async (message: string): Promise<void> => {
      try {
        await reply(message);
      } catch (err) {
        logger.warn("could not send a Telegram message", { error: err });
      }
    };

    const link = extractWorkLink(text);
    if (!link.ok) {
      await say(link.reason === "no-ao3-link" ? messages.noLink : messages.unsupportedLink);
      return;
    }

    await say(messages.ack);
    logger.info("request accepted", { workId: link.workId });

    let dir: string | undefined;
    let title: string | undefined;
    try {
      dir = await deps.makeTempDir();
      const result = await deps.download(link.canonicalUrl, dir, {
        timeoutMs: config.downloadTimeoutMs,
      });
      title = result.title;
      await deps.upload(result.filePath, uploadOptions);
      logger.info("delivered", { workId: link.workId, title });
      await say(messages.delivered(result.title));
    } catch (err) {
      logger.error("request failed", { workId: link.workId, error: err, stderr: stderrOf(err) });
      await say(failureMessage(err, title));
    } finally {
      if (dir !== undefined) {
        await deps.removeDir(dir).catch((err: unknown) => {
          logger.warn("could not remove the temporary directory", { dir, error: err });
        });
      }
    }
  };
}

/**
 * Creates the grammY bot: owner filter first (R1.1), then the single text handler. `grammy` is
 * only for tests (e.g. a preset `botInfo` so no `getMe` call is made).
 */
export function createBot(
  config: ResolvedConfig,
  overrides: Partial<RequestDeps> = {},
  grammy?: BotConfig<Context>,
): Bot {
  const bot = new Bot(config.telegramToken, grammy);
  const handle = createRequestHandler(config, overrides);
  bot.use(ownerOnly(config.ownerId));
  bot.on("message:text", (ctx) => handle(ctx.message.text, (text) => ctx.reply(text)));
  return bot;
}
