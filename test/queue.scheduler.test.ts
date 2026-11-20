import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_ERROR_DELAY_MS, createScheduler } from "../src/queue/scheduler.js";
import type { QueueItem } from "../src/queue/state.js";

const item = (id: string, nextAttemptAt: number): QueueItem => ({
  id,
  url: `u-${id}`,
  stage: "upload",
  attempts: 0,
  firstQueuedAt: 0,
  nextAttemptAt,
  lastError: "e",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(initial: QueueItem[]) {
  let items = initial;
  const batches: string[][] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduler = createScheduler({
    items: () => items,
    process: async (due) => {
      batches.push(due.map((i) => i.id));
      // processing removes the items, like a delivery would
      items = items.filter((i) => !due.some((d) => d.id === i.id));
    },
    logger,
  });
  return { scheduler, batches, logger, setItems: (next: QueueItem[]) => (items = next) };
}

describe("scheduler — the single timer", () => {
  it("with an empty queue there is no active timer (R3.5)", () => {
    const { scheduler } = setup([]);
    scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.nextWakeAt()).toBeUndefined();
  });

  it("with two items a single timer is scheduled, at the earliest nextAttemptAt (R3.4)", async () => {
    const { scheduler, batches } = setup([item("late", 5_000), item("early", 2_000)]);
    scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.nextWakeAt()).toBe(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([["early"]]);
  });

  it("when it fires, it processes ALL due items, not just the first", async () => {
    const { scheduler, batches } = setup([item("a", 1_000), item("b", 1_000), item("c", 9_000)]);
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches).toEqual([["a", "b"]]);
  });

  it("after a batch it re-arms for the next item, and goes idle once the queue is empty", async () => {
    const { scheduler, batches } = setup([item("a", 1_000), item("b", 4_000)]);
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.nextWakeAt()).toBe(4_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(batches).toEqual([["a"], ["b"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an item whose time passed while the daemon was down is processed immediately (R2.3)", async () => {
    vi.setSystemTime(100_000);
    const { scheduler, batches } = setup([item("overdue", 10_000)]);
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([["overdue"]]);
  });

  it("each reschedule cancels the previous timer: timers do not pile up", () => {
    const { scheduler, setItems } = setup([item("a", 5_000)]);
    scheduler.reschedule();
    setItems([item("a", 5_000), item("b", 1_000)]);
    scheduler.reschedule();
    scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.nextWakeAt()).toBe(1_000);
  });

  it("a reschedule during a batch does not start a second, overlapping batch", async () => {
    let release!: () => void;
    let items = [item("a", 1_000), item("b", 1_000)];
    const calls: string[][] = [];
    const scheduler = createScheduler({
      items: () => items,
      process: async (due) => {
        calls.push(due.map((i) => i.id));
        scheduler.reschedule(); // what a queue change inside the batch does
        await new Promise<void>((r) => (release = r));
        items = [];
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual([["a", "b"]]);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([["a", "b"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an error in a batch is logged and the timer is re-armed no sooner than a minute later", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = createScheduler({
      items: () => [item("a", 1_000)],
      process: async () => {
        throw new Error("boom");
      },
      logger,
    });
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logger.error).toHaveBeenCalledWith("retry batch failed", { error: expect.any(Error) });
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.nextWakeAt()).toBe(1_000 + BATCH_ERROR_DELAY_MS);
    scheduler.stop();
  });

  it("stop() cancels the timer and later reschedules do nothing", () => {
    const { scheduler } = setup([item("a", 1_000)]);
    scheduler.reschedule();
    scheduler.stop();
    scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a far-away item is clamped to setTimeout's maximum delay and re-armed later", () => {
    const { scheduler } = setup([item("far", 40 * 24 * 3_600_000)]);
    scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.nextWakeAt()).toBe(2 ** 31 - 1);
  });
});
