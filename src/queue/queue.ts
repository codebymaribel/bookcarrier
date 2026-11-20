import { randomUUID } from "node:crypto";
import type { QueueItem, Stage, StateStore } from "./state.js";

const MINUTE = 60_000;

/** Default backoff ladder: 1, 2, 4, 8, 15 minutes (cumulative 1, 3, 7, 15, 30). */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1, 2, 4, 8, 15].map((m) => m * MINUTE);

/** Default give-up window, measured from the first enqueue: 30 minutes. */
export const DEFAULT_GIVE_UP_AFTER_MS = 30 * MINUTE;

/**
 * Delay before the next attempt after `attempts` failed retries: step `attempts` of the ladder.
 * `undefined` past the last step, which means "give up": the ladder ends exactly at the edge of the
 * window, so there is no ceiling to repeat.
 */
export function backoffFor(
  attempts: number,
  ladder: readonly number[] = DEFAULT_BACKOFF_MS,
): number | undefined {
  return ladder[attempts];
}

/** True once more than the window has passed since the item was first enqueued (R4.1). */
export function shouldGiveUp(
  item: Pick<QueueItem, "firstQueuedAt">,
  now: number,
  giveUpAfterMs: number = DEFAULT_GIVE_UP_AFTER_MS,
): boolean {
  return now - item.firstQueuedAt > giveUpAfterMs;
}

export type EnqueueInput = {
  /** Reuse the request's id (its spool directory already has that name); generated otherwise. */
  id?: string;
  url: string;
  stage: Stage;
  epubPath?: string;
  title?: string;
  /** The failure that caused the enqueue. */
  error: string;
};

export type FailureOutcome = { giveUp: boolean; item: QueueItem };

export type Queue = {
  /** Snapshot of the pending items. */
  items(): readonly QueueItem[];
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  promoteToUpload(id: string, epubPath: string, title: string): Promise<QueueItem>;
  recordFailure(id: string, error: string): Promise<FailureOutcome>;
  remove(id: string): Promise<void>;
};

export type QueueOptions = {
  store: StateStore;
  /** Items restored from disk at startup (R2.3). */
  initial: readonly QueueItem[];
  backoffMs?: readonly number[];
  giveUpAfterMs?: number;
  /** Called after every change, once it is persisted: the scheduler re-arms its timer here. */
  onChange?: () => void;
  now?: () => number;
  newId?: () => string;
};

/**
 * The in-memory queue, persisted on every change.
 *
 * Every mutation updates memory, then writes the whole state through the store (atomic and
 * serialized) and only then resolves and calls `onChange` (R2.1). If the write fails the mutation
 * rejects; memory keeps the change, so the next successful write persists it.
 */
export function createQueue(options: QueueOptions): Queue {
  const {
    store,
    backoffMs = DEFAULT_BACKOFF_MS,
    giveUpAfterMs = DEFAULT_GIVE_UP_AFTER_MS,
    onChange = () => {},
    now = Date.now,
    newId = randomUUID,
  } = options;
  let items: QueueItem[] = options.initial.map((item) => ({ ...item }));

  const commit = async (): Promise<void> => {
    await store.write({ version: 1, items: items.map((item) => ({ ...item })) });
    onChange();
  };

  const find = (id: string): QueueItem => {
    const item = items.find((i) => i.id === id);
    if (item === undefined) throw new Error(`unknown queue item: ${id}`);
    return item;
  };

  const replace = (next: QueueItem): void => {
    items = items.map((i) => (i.id === next.id ? next : i));
  };

  return {
    items: () => items.map((item) => ({ ...item })),

    async enqueue(input) {
      const at = now();
      const item: QueueItem = {
        id: input.id ?? newId(),
        url: input.url,
        stage: input.stage,
        ...(input.epubPath !== undefined && { epubPath: input.epubPath }),
        ...(input.title !== undefined && { title: input.title }),
        attempts: 0,
        firstQueuedAt: at,
        nextAttemptAt: at + (backoffFor(0, backoffMs) ?? 0),
        lastError: input.error,
      };
      items = [...items, item];
      await commit();
      return { ...item };
    },

    async promoteToUpload(id, epubPath, title) {
      const next: QueueItem = { ...find(id), stage: "upload", epubPath, title };
      replace(next);
      await commit();
      return { ...next };
    },

    async recordFailure(id, error) {
      const at = now();
      const current = find(id);
      const attempts = current.attempts + 1;
      const delay = backoffFor(attempts, backoffMs);
      const giveUp = delay === undefined || shouldGiveUp(current, at, giveUpAfterMs);
      const next: QueueItem = {
        ...current,
        attempts,
        lastError: error,
        nextAttemptAt: at + (delay ?? 0),
      };
      if (giveUp) items = items.filter((i) => i.id !== id);
      else replace(next);
      await commit();
      return { giveUp, item: { ...next } };
    },

    async remove(id) {
      if (!items.some((i) => i.id === id)) return;
      items = items.filter((i) => i.id !== id);
      await commit();
    },
  };
}
