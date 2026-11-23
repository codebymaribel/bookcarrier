import type { Logger } from "../shared/index.js";
import type { QueueItem } from "./state.js";

/** setTimeout's largest delay (~24.8 days); longer waits are clamped and re-armed on wake-up. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** After a batch that threw, wait at least this long: a persistent failure must not spin the loop. */
export const BATCH_ERROR_DELAY_MS = 60_000;

export type Scheduler = {
  /** Cancels the current timer and arms one for the earliest item, or none if the queue is empty. */
  reschedule(): void;
  /** Cancels the timer for good (daemon shutdown). */
  stop(): void;
  /** Epoch ms the armed timer fires at; `undefined` when there is no timer. For tests and logs. */
  nextWakeAt(): number | undefined;
};

export type SchedulerOptions = {
  /** Current queue contents. */
  items: () => readonly QueueItem[];
  /** Processes the due items; the queue changes it makes call `reschedule` themselves. */
  process: (due: QueueItem[]) => Promise<void>;
  logger: Logger;
};

/**
 * The retry queue's only timer: one `setTimeout`, never a `setInterval` (R3.4, R3.5).
 *
 * `reschedule()` cancels the current timer and, if the queue has items, arms a new one for the
 * earliest `nextAttemptAt` (clamped to >= 0, so an item that came due while the daemon was down runs
 * at once, R2.3). When it fires, every due item is processed in one batch, then it reschedules.
 * While a batch runs, `reschedule()` only cancels: the batch re-arms when it ends, so two batches
 * never overlap. A batch that throws is logged and the next wake-up waits at least
 * {@link BATCH_ERROR_DELAY_MS}, so a persistent failure (e.g. a full disk) cannot busy-loop.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { items, process, logger } = options;
  let timer: NodeJS.Timeout | undefined;
  let wakeAt: number | undefined;
  let running = false;
  let stopped = false;
  let notBefore = 0;

  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    wakeAt = undefined;
  };

  const fire = async (): Promise<void> => {
    timer = undefined;
    wakeAt = undefined;
    running = true;
    try {
      const now = Date.now();
      const due = items().filter((item) => item.nextAttemptAt <= now);
      if (due.length > 0) await process(due);
    } catch (err) {
      logger.error("retry batch failed", { error: err });
      notBefore = Date.now() + BATCH_ERROR_DELAY_MS;
    } finally {
      running = false;
      reschedule();
    }
  };

  const reschedule = (): void => {
    cancel();
    if (stopped || running) return;
    const pending = items();
    if (pending.length === 0) return;
    const earliest = Math.max(Math.min(...pending.map((item) => item.nextAttemptAt)), notBefore);
    const delay = Math.min(Math.max(earliest - Date.now(), 0), MAX_DELAY_MS);
    wakeAt = Date.now() + delay;
    timer = setTimeout(() => void fire(), delay);
  };

  return {
    reschedule,
    stop() {
      stopped = true;
      cancel();
    },
    nextWakeAt: () => wakeAt,
  };
}
