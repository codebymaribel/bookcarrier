import { describe, expect, it, vi } from "vitest";
import {
  backoffFor,
  createQueue,
  DEFAULT_BACKOFF_MS,
  DEFAULT_GIVE_UP_AFTER_MS,
  shouldGiveUp,
} from "../src/queue/queue.js";
import type { QueueItem, QueueState, StateStore } from "../src/queue/state.js";

const MIN = 60_000;

function memoryStore(initial: QueueItem[] = []) {
  const writes: QueueState[] = [];
  const store: StateStore = {
    read: async () => ({ state: { version: 1, items: initial } }),
    write: vi.fn(async (state: QueueState) => {
      writes.push(structuredClone(state));
    }),
  };
  return { store, writes };
}

function setup(opts: { now?: number; initial?: QueueItem[] } = {}) {
  let now = opts.now ?? 1_000_000;
  const { store, writes } = memoryStore();
  const onChange = vi.fn();
  const queue = createQueue({
    store,
    initial: opts.initial ?? [],
    now: () => now,
    onChange,
    newId: () => "id-1",
  });
  return { queue, writes, onChange, setNow: (n: number) => (now = n), store };
}

describe("backoffFor (R3.3)", () => {
  it("returns 1, 2, 4, 8, 15 minutes for attempts 0..4", () => {
    expect([0, 1, 2, 3, 4].map((a) => backoffFor(a))).toEqual([1, 2, 4, 8, 15].map((m) => m * MIN));
  });

  it("returns undefined past the last step: there is no ceiling to repeat", () => {
    expect(backoffFor(5)).toBeUndefined();
  });

  it("the default ladder adds up exactly to the default 30-minute window", () => {
    expect(DEFAULT_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(DEFAULT_GIVE_UP_AFTER_MS);
  });

  it("uses a configured ladder", () => {
    expect(backoffFor(1, [10, 20])).toBe(20);
    expect(backoffFor(2, [10, 20])).toBeUndefined();
  });
});

describe("shouldGiveUp (R4.1)", () => {
  const item = { firstQueuedAt: 0 } as QueueItem;
  it("false at 29 min, true at 31 min", () => {
    expect(shouldGiveUp(item, 29 * MIN)).toBe(false);
    expect(shouldGiveUp(item, 31 * MIN)).toBe(true);
  });
  it("uses a configured window", () => {
    expect(shouldGiveUp(item, 11, 10)).toBe(true);
    expect(shouldGiveUp(item, 10, 10)).toBe(false);
  });
});

describe("enqueue", () => {
  it("persists the item with consistent firstQueuedAt and nextAttemptAt (R2.1)", async () => {
    const { queue, writes, onChange } = setup({ now: 5_000 });
    const item = await queue.enqueue({
      url: "https://archiveofourown.org/works/1",
      stage: "download",
      error: "HTTP Error 429",
    });
    expect(item).toEqual({
      id: "id-1",
      url: "https://archiveofourown.org/works/1",
      stage: "download",
      attempts: 0,
      firstQueuedAt: 5_000,
      nextAttemptAt: 5_000 + 1 * MIN,
      lastError: "HTTP Error 429",
    });
    expect(writes).toEqual([{ version: 1, items: [item] }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit id, the EPUB and the title for an upload-stage item (R1.3)", async () => {
    const { queue } = setup();
    const item = await queue.enqueue({
      id: "abc",
      url: "u",
      stage: "upload",
      epubPath: "/spool/abc/x.epub",
      title: "T",
      error: "Host is down",
    });
    expect(item).toMatchObject({ id: "abc", stage: "upload", epubPath: "/spool/abc/x.epub", title: "T" });
    expect(queue.items()).toEqual([item]);
  });

  it("onChange runs only AFTER the state was persisted (R2.1)", async () => {
    const { queue, store, onChange } = setup();
    vi.mocked(store.write).mockImplementationOnce(async () => {
      expect(onChange).not.toHaveBeenCalled();
    });
    await queue.enqueue({ url: "u", stage: "download", error: "e" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("promoteToUpload (R3.2)", () => {
  it("moves to stage upload with the EPUB and title, keeping firstQueuedAt (the window does not reset)", async () => {
    const { queue, setNow, writes } = setup({ now: 0 });
    await queue.enqueue({ url: "u", stage: "download", error: "429" });
    setNow(3 * MIN);
    const promoted = await queue.promoteToUpload("id-1", "/spool/id-1/x.epub", "Title");
    expect(promoted).toMatchObject({
      stage: "upload",
      epubPath: "/spool/id-1/x.epub",
      title: "Title",
      firstQueuedAt: 0,
    });
    expect(writes.at(-1)?.items).toEqual([promoted]);
  });
});

describe("recordFailure (R3.3, R4.1)", () => {
  it("increments attempts, stores the error and schedules the next step of the ladder", async () => {
    const { queue, setNow } = setup({ now: 0 });
    await queue.enqueue({ url: "u", stage: "upload", error: "first" });
    setNow(1 * MIN);
    const outcome = await queue.recordFailure("id-1", "second");
    expect(outcome).toEqual({
      giveUp: false,
      item: expect.objectContaining({ attempts: 1, lastError: "second", nextAttemptAt: 3 * MIN }),
    });
  });

  it("walks the full ladder: retries at 1, 3, 7, 15, 30 min, then gives up", async () => {
    const { queue, setNow } = setup({ now: 0 });
    await queue.enqueue({ url: "u", stage: "upload", error: "e" });
    const times: number[] = [queue.items()[0]!.nextAttemptAt];
    for (;;) {
      setNow(times.at(-1)!);
      const outcome = await queue.recordFailure("id-1", "e");
      if (outcome.giveUp) break;
      times.push(outcome.item.nextAttemptAt);
    }
    expect(times).toEqual([1, 3, 7, 15, 30].map((m) => m * MIN));
    expect(queue.items()).toEqual([]);
  });

  it("gives up when the window passed (e.g. the daemon was down), removing and persisting", async () => {
    const { queue, setNow, writes } = setup({ now: 0 });
    await queue.enqueue({ url: "u", stage: "upload", error: "e" });
    setNow(31 * MIN);
    const outcome = await queue.recordFailure("id-1", "last error");
    expect(outcome).toEqual({ giveUp: true, item: expect.objectContaining({ lastError: "last error" }) });
    expect(queue.items()).toEqual([]);
    expect(writes.at(-1)).toEqual({ version: 1, items: [] });
  });
});

describe("remove and lookups", () => {
  it("remove deletes the item and persists; an unknown id is a no-op", async () => {
    const { queue, writes } = setup();
    await queue.enqueue({ url: "u", stage: "download", error: "e" });
    await queue.remove("nope");
    expect(queue.items()).toHaveLength(1);
    await queue.remove("id-1");
    expect(queue.items()).toEqual([]);
    expect(writes.at(-1)).toEqual({ version: 1, items: [] });
  });

  it("starts from the restored items (R2.3)", () => {
    const restored: QueueItem = {
      id: "r",
      url: "u",
      stage: "download",
      attempts: 2,
      firstQueuedAt: 0,
      nextAttemptAt: 5,
      lastError: "e",
    };
    const { queue } = setup({ initial: [restored] });
    expect(queue.items()).toEqual([restored]);
  });

  it("operations on an unknown id throw", async () => {
    const { queue } = setup();
    await expect(queue.promoteToUpload("x", "p", "t")).rejects.toThrow(/unknown queue item/);
    await expect(queue.recordFailure("x", "e")).rejects.toThrow(/unknown queue item/);
  });
});
