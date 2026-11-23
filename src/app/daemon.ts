import { randomUUID } from "node:crypto";
import {
  createPipeline,
  downloadEpub,
  type Pipeline,
  type PipelineDeps,
  type Send,
} from "../fanfic/index.js";
import type { Logger, ResolvedConfig } from "../shared/index.js";
import {
  createQueue,
  createScheduler,
  createSpool,
  createStateStore,
  messages,
  type Queue,
  type Scheduler,
} from "../retry-queue/index.js";
import { uploadToKindle } from "../kindle/index.js";

export type Daemon = {
  queue: Queue;
  pipeline: Pipeline;
  scheduler: Scheduler;
  /** Arms the retry timer and sends the startup notices. Call it once the bot can send messages. */
  start(): void;
  /** Cancels the retry timer (shutdown). */
  stop(): void;
};

export type DaemonOptions = {
  logger: Logger;
  /** How retries and startup notices reach the owner. */
  notify: Send;
  download?: PipelineDeps["download"];
  upload?: PipelineDeps["upload"];
};

/**
 * Wires the retry queue at startup (T9):
 * 1. reads the persisted state: missing → empty (R2.4); corrupt → empty, moved aside, owner told
 *    once `start()` runs (R2.5);
 * 2. reconciles the spool, deleting EPUBs no restored item references (R5.3);
 * 3. builds the queue, the pipeline and the scheduler, with every queue change re-arming the timer.
 *
 * Nothing runs until `start()`: it arms the timer from the restored items, so an item that came due
 * while the daemon was down is retried at once (R2.3).
 */
export async function createDaemon(config: ResolvedConfig, options: DaemonOptions): Promise<Daemon> {
  const { logger, notify } = options;
  const store = createStateStore(config.queuePath);
  const { state, corruptBackup } = await store.read();
  if (corruptBackup !== undefined) {
    logger.error("the queue file was unreadable; starting with an empty queue", { corruptBackup });
  }

  const spool = createSpool(config.spoolDir);
  const removed = await spool.reconcile(state.items);
  if (removed.length > 0) logger.info("removed orphan entries from the spool", { removed });

  let scheduler: Scheduler | undefined;
  const queue = createQueue({
    store,
    initial: state.items,
    backoffMs: config.retryBackoffMinutes.map((m) => m * 60_000),
    giveUpAfterMs: config.giveUpAfterMs,
    deferredRetryMs: config.deferredRetryMs,
    deferredGiveUpAfterMs: config.deferredGiveUpAfterMs,
    onChange: () => scheduler?.reschedule(),
  });

  const pipeline = createPipeline(config, {
    download: options.download ?? downloadEpub,
    upload: options.upload ?? uploadToKindle,
    spool,
    queue,
    newId: randomUUID,
    logger,
  });

  scheduler = createScheduler({
    items: () => queue.items(),
    process: (due) => pipeline.processDue(due, notify),
    logger,
  });
  const timer = scheduler;

  return {
    queue,
    pipeline,
    scheduler: timer,
    start() {
      logger.info("retry queue restored", { items: state.items.length });
      if (corruptBackup !== undefined) {
        notify(messages.queueFileCorrupt(corruptBackup)).catch((err: unknown) => {
          logger.warn("could not send a Telegram message", { error: err });
        });
      }
      timer.reschedule();
    },
    stop: () => timer.stop(),
  };
}

/** The part of grammY's `Bot` that polling needs (injectable for tests). */
export type Poller = {
  start(options?: { onStart?: (info: { username: string }) => void }): Promise<void>;
};

/**
 * Long-polls until the bot stops, arming the retry timer once polling has started (so the bot can
 * notify) and ALWAYS cancelling it afterwards. Without the `finally`, a polling failure (a 401, or a
 * 409 when another instance polls the same bot) would leave the retry timer holding the event loop:
 * the process would never exit with code 1 and launchd would never relaunch it (R7.1).
 */
export async function pollUntilStopped(
  bot: Poller,
  daemon: Pick<Daemon, "start" | "stop">,
  logger: Logger,
): Promise<void> {
  try {
    await bot.start({
      onStart: (info) => {
        logger.info("bot started, long polling", { username: info.username });
        daemon.start();
      },
    });
  } finally {
    daemon.stop();
  }
}
