import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingStore, type PendingOverwrite } from "./pending.js";

const TEN_MIN = 10 * 60 * 1000;

const entry = (n: number): PendingOverwrite => ({
  fileId: `file-${n}`,
  safeName: `book-${n}.pdf`,
  folder: "/mnt/us/documents/books/",
});

/** A store with a controllable clock and sequential ids. */
function setup() {
  let now = 1_000_000;
  let counter = 0;
  const store = createPendingStore({
    ttlMs: TEN_MIN,
    now: () => now,
    newId: () => `id${String(++counter).padStart(6, "0")}`,
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pending store — add / take (R5.7, R5.9)", () => {
  it("add then take → the entry; a second take → undefined", () => {
    const { store } = setup();
    const id = store.add(entry(1));
    expect(id).toBe("id000001");
    expect(store.take(id)).toEqual(entry(1));
    expect(store.take(id)).toBeUndefined();
  });

  it("take of an unknown id → undefined", () => {
    const { store } = setup();
    store.add(entry(1));
    expect(store.take("nope")).toBeUndefined();
  });

  it("each entry is independent (R5.11)", () => {
    const { store } = setup();
    const a = store.add(entry(1));
    const b = store.add(entry(2));
    expect(store.take(b)).toEqual(entry(2));
    expect(store.take(a)).toEqual(entry(1));
  });
});

describe("pending store — expiry (R5.8)", () => {
  it("take at 9:59 → the entry", () => {
    const { store, advance } = setup();
    const id = store.add(entry(1));
    advance(9 * 60 * 1000 + 59 * 1000);
    expect(store.take(id)).toEqual(entry(1));
  });

  it("take at 10:01 → undefined", () => {
    const { store, advance } = setup();
    const id = store.add(entry(1));
    advance(10 * 60 * 1000 + 1000);
    expect(store.take(id)).toBeUndefined();
  });

  it("add drops expired entries, with no timer created", () => {
    vi.useFakeTimers();
    const { store, advance } = setup();
    const old1 = store.add(entry(1));
    store.add(entry(2));
    expect(store.size()).toBe(2);
    advance(TEN_MIN + 1000);
    const fresh = store.add(entry(3));
    expect(store.size()).toBe(1);
    expect(store.take(old1)).toBeUndefined();
    expect(store.take(fresh)).toEqual(entry(3));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("pending store — default id (R5.3)", () => {
  it("8 characters of [A-Za-z0-9_-], and ow:<id>:y fits in 64 bytes", () => {
    const store = createPendingStore({ ttlMs: TEN_MIN });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = store.add(entry(i));
      expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/);
      expect(Buffer.byteLength(`ow:${id}:y`, "utf8")).toBeLessThanOrEqual(64);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});
