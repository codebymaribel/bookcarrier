import { createBot } from "./bot.js";
import { ConfigError, loadConfig, type ResolvedConfig } from "./config.js";
import { logger } from "./logger.js";

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
 * Daemon entrypoint: load config → build the bot → long polling until SIGINT/SIGTERM.
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

  const bot = createBot(config);

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
      void bot.stop();
    });
  }

  await bot.start({
    onStart: (info) => logger.info("bot started, long polling", { username: info.username }),
  });
  logger.info("bot stopped");
}

main().catch((err: unknown) => {
  logger.error("fatal error", { error: err });
  process.exitCode = 1;
});
