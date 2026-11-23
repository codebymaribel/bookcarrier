import type { Bot } from "grammy";
import { checkRequiredBinaries } from "./app/index.js";
import type { Send } from "./fanfic/index.js";
import { createBot, notifyOwner } from "./telegram/index.js";
import { ConfigError, loadConfig, type ResolvedConfig } from "./shared/index.js";
import { createDaemon, pollUntilStopped } from "./app/index.js";
import { logger } from "./shared/index.js";

/**
 * Loads the config; if it is invalid the daemon does not start and the log says which field is
 * wrong (R6.4). Returns `undefined` after logging, so the caller just sets the exit code.
 */
async function loadConfigOrLog(): Promise<ResolvedConfig | undefined> {
  try {
    return await loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) logger.error(`not starting: ${err.message}`);
    else logger.error("not starting: unexpected error loading the config", { error: err });
    return undefined;
  }
}

/**
 * Daemon entrypoint: load config → restore the retry queue → build the bot → long polling until
 * SIGINT/SIGTERM. The retry timer is armed once polling has started, so the bot can notify.
 *
 * Exit codes matter to launchd (feature 2, `KeepAlive: { SuccessfulExit: false }`): a requested
 * shutdown exits 0 (not relaunched); a config error or a failed start (bad token, a second
 * instance polling the same bot) exits 1 (relaunched, with `ThrottleInterval`).
 */
async function main(): Promise<void> {
  const config = await loadConfigOrLog();
  if (config === undefined) {
    process.exitCode = 1;
    return;
  }

  // R7.7: a missing fanficfare/scp/ssh (typically a trimmed PATH under launchd) is logged here, at
  // startup, instead of surfacing later as a misleading download error. It only logs.
  await checkRequiredBinaries(logger);

  // Retries and startup notices go to the owner through the bot, which needs the pipeline first:
  // the notifier looks the bot up lazily, and nothing is sent before `daemon.start()`.
  let bot: Bot | undefined;
  const notify: Send = (text) =>
    bot === undefined ? Promise.resolve() : notifyOwner(bot, config.ownerId)(text);
  const daemon = await createDaemon(config, { logger, notify });
  bot = createBot(config, daemon.pipeline);

  // grammY's default would stop the bot on an error thrown by a handler. The request handler never
  // throws, so this is a safety net: log it and keep serving the owner.
  bot.catch((err) => {
    logger.error("unhandled error in an update handler", {
      error: err.error,
      updateId: err.ctx.update.update_id,
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      logger.info("shutting down", { signal });
      daemon.stop();
      void bot?.stop();
    });
  }

  await pollUntilStopped(bot, daemon, logger);
  logger.info("bot stopped");
}

main().catch((err: unknown) => {
  logger.error("fatal error", { error: err });
  process.exitCode = 1;
});
