import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FicMeta } from "../fanfic/index.js";
import {
  createFollows,
  emptyFollowsState,
  parseFollowsState,
  type FollowsState,
} from "./follows.js";
import { createJsonFileStore, type JsonFileStore } from "../shared/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-follows-"));
  path = join(dir, "follows.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const realStore = (): JsonFileStore<FollowsState> =>
  createJsonFileStore(path, parseFollowsState, emptyFollowsState);

function meta(workId: string, overrides: Partial<FicMeta> = {}): FicMeta {
  return {
    workId,
    url: `https://archiveofourown.org/works/${workId}`,
    title: `Title ${workId}`,
    author: "Author",
    chapters: 3,
    status: "in-progress",
    ...overrides,
  };
}

/** A store that counts writes and can be made to fail. */
function fakeStore() {
  const writes: FollowsState[] = [];
  let failNext = false;
  const store: JsonFileStore<FollowsState> = {
    read: async () => ({ state: emptyFollowsState() }),
    write: async (state) => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      writes.push(structuredClone(state));
    },
  };
  return { store, writes, failOnce: () => (failNext = true) };
}

async function persisted(): Promise<FollowsState> {
  return JSON.parse(await readFile(path, "utf8")) as FollowsState;
}

describe("onDelivered — table rows", () => {
  it("no meta → none, nothing written (R2.3, R6.3)", async () => {
    const { store, writes } = fakeStore();
    const follows = createFollows(store, emptyFollowsState());
    expect(await follows.onDelivered(undefined)).toEqual({ kind: "none" });
    expect(writes).toEqual([]);
  });

  it("followed + completed → completed, follow removed (R6.4)", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    await follows.onDelivered(meta("1"));
    await follows.follow("1");
    expect(await follows.onDelivered(meta("1", { status: "completed", chapters: 5 }))).toEqual({
      kind: "completed",
    });
    expect((await persisted()).followed).toEqual([]);
    expect(await follows.unfollow("1")).toEqual({ kind: "not-followed" });
  });

  it.each(["in-progress", "unknown"] as const)(
    "followed + %s → updated with new chapters, status, title and updatedAt (R6.1)",
    async (status) => {
      let t = 1000;
      const follows = createFollows(realStore(), emptyFollowsState(), () => t);
      await follows.onDelivered(meta("1"));
      await follows.follow("1");
      t = 2000;
      const outcome = await follows.onDelivered(meta("1", { status, chapters: 7, title: "New title" }));
      expect(outcome).toEqual({ kind: "updated", chapters: 7 });
      const [fic] = (await persisted()).followed;
      expect(fic).toMatchObject({
        workId: "1",
        chapters: 7,
        status,
        title: "New title",
        followedAt: 1000,
        updatedAt: 2000,
      });
      expect((await persisted()).recent).toEqual([]);
    },
  );

  it("not followed + in-progress → offer, added to recent (R3.1)", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    expect(await follows.onDelivered(meta("1"))).toEqual({ kind: "offer" });
    expect(await persisted()).toEqual({ version: 1, followed: [], recent: [meta("1")] });
  });

  it.each(["completed", "unknown"] as const)(
    "not followed + %s → none, nothing written (R3.1a)",
    async (status) => {
      const { store, writes } = fakeStore();
      const follows = createFollows(store, emptyFollowsState());
      expect(await follows.onDelivered(meta("1", { status }))).toEqual({ kind: "none" });
      expect(writes).toEqual([]);
    },
  );
});

describe("recent list (R3.5)", () => {
  it("keeps the 10 most recent, newest first; the 11th drops the oldest", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    for (let i = 1; i <= 11; i++) await follows.onDelivered(meta(String(i)));
    expect((await persisted()).recent.map((m) => m.workId)).toEqual(
      ["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"],
    );
    expect(await follows.follow("1")).toEqual({ kind: "unknown" });
  });

  it("re-delivery moves the fic to the front without duplicating, with the new record", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    for (const id of ["1", "2", "3"]) await follows.onDelivered(meta(id));
    await follows.onDelivered(meta("1", { chapters: 9 }));
    const recent = (await persisted()).recent;
    expect(recent.map((m) => m.workId)).toEqual(["1", "3", "2"]);
    expect(recent[0]?.chapters).toBe(9);
  });

  it("followed fics are never dropped by the limit", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    await follows.onDelivered(meta("1"));
    await follows.follow("1");
    for (let i = 2; i <= 20; i++) await follows.onDelivered(meta(String(i)));
    const state = await persisted();
    expect(state.followed.map((f) => f.workId)).toEqual(["1"]);
    expect(state.recent).toHaveLength(10);
    expect(await follows.follow("1")).toMatchObject({ kind: "already" });
  });
});

describe("follow / unfollow", () => {
  it("follow → followed, moved from recent (R3.3)", async () => {
    let t = 500;
    const follows = createFollows(realStore(), emptyFollowsState(), () => t);
    await follows.onDelivered(meta("1", { chapters: 12 }));
    const result = await follows.follow("1");
    expect(result).toMatchObject({ kind: "followed", fic: { workId: "1", chapters: 12, followedAt: 500 } });
    const state = await persisted();
    expect(state.recent).toEqual([]);
    expect(state.followed).toHaveLength(1);
  });

  it("follow twice → already, no second entry (R3.4)", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    await follows.onDelivered(meta("1"));
    await follows.follow("1");
    expect(await follows.follow("1")).toMatchObject({ kind: "already", fic: { workId: "1" } });
    expect((await persisted()).followed).toHaveLength(1);
  });

  it("follow an unknown work id → unknown, nothing written (R3.6)", async () => {
    const { store, writes } = fakeStore();
    const follows = createFollows(store, emptyFollowsState());
    expect(await follows.follow("99")).toEqual({ kind: "unknown" });
    expect(writes).toEqual([]);
  });

  it("unfollow → unfollowed with the title (R4.1)", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    await follows.onDelivered(meta("1", { title: "My fic" }));
    await follows.follow("1");
    expect(await follows.unfollow("1")).toEqual({ kind: "unfollowed", title: "My fic" });
    expect((await persisted()).followed).toEqual([]);
  });

  it("unfollow a fic that is not followed → not-followed, nothing written (R4.2)", async () => {
    const { store, writes } = fakeStore();
    const follows = createFollows(store, emptyFollowsState());
    expect(await follows.unfollow("1")).toEqual({ kind: "not-followed" });
    expect(writes).toEqual([]);
  });
});

describe("persistence (R5.3)", () => {
  it("a new createFollows over the same file sees followed and recent", async () => {
    const first = createFollows(realStore(), emptyFollowsState());
    await first.onDelivered(meta("1"));
    await first.follow("1");
    await first.onDelivered(meta("2"));

    const store = realStore();
    const { state, corruptBackup } = await store.read();
    expect(corruptBackup).toBeUndefined();
    const second = createFollows(store, state);
    expect(await second.follow("1")).toMatchObject({ kind: "already" });
    expect(await second.follow("2")).toMatchObject({ kind: "followed", fic: { workId: "2" } });
  });
});

describe("failures and ordering", () => {
  it("a failed write rejects the call and leaves memory unchanged", async () => {
    const { store, failOnce } = fakeStore();
    const follows = createFollows(store, emptyFollowsState());
    failOnce();
    await expect(follows.onDelivered(meta("1"))).rejects.toThrow("disk full");
    expect(await follows.follow("1")).toEqual({ kind: "unknown" });

    await follows.onDelivered(meta("1"));
    failOnce();
    await expect(follows.follow("1")).rejects.toThrow("disk full");
    expect(await follows.unfollow("1")).toEqual({ kind: "not-followed" });
    expect(await follows.follow("1")).toMatchObject({ kind: "followed" });

    failOnce();
    await expect(follows.unfollow("1")).rejects.toThrow("disk full");
    expect(await follows.follow("1")).toMatchObject({ kind: "already" });
  });

  it("two un-awaited calls are applied in order and both effects reach the file", async () => {
    const follows = createFollows(realStore(), emptyFollowsState());
    const delivered = follows.onDelivered(meta("1"));
    const followed = follows.follow("1");
    expect(await delivered).toEqual({ kind: "offer" });
    expect(await followed).toMatchObject({ kind: "followed" });
    const state = await persisted();
    expect(state.followed.map((f) => f.workId)).toEqual(["1"]);
    expect(state.recent).toEqual([]);
  });
});

describe("parseFollowsState", () => {
  const followed = { ...meta("1"), followedAt: 1, updatedAt: 2 };

  it("accepts a valid state and the empty state", () => {
    const state = { version: 1, followed: [followed], recent: [meta("2")] };
    expect(parseFollowsState(state)).toEqual(state);
    expect(parseFollowsState(emptyFollowsState())).toEqual({ version: 1, followed: [], recent: [] });
  });

  it("rejects a wrong version", () => {
    expect(parseFollowsState({ version: 2, followed: [], recent: [] })).toBeUndefined();
  });

  it.each([
    ["non-object", 5],
    ["chapters zero", { version: 1, followed: [], recent: [meta("2", { chapters: 0 })] }],
    ["chapters fractional", { version: 1, followed: [], recent: [meta("2", { chapters: 1.5 })] }],
    ["bad status", { version: 1, followed: [], recent: [{ ...meta("2"), status: "done" }] }],
    ["non-string title", { version: 1, followed: [], recent: [{ ...meta("2"), title: 4 }] }],
    ["followed without dates", { version: 1, followed: [meta("1")], recent: [] }],
    ["followed not an array", { version: 1, followed: {}, recent: [] }],
  ])("rejects a malformed entry: %s", (_name, raw) => {
    expect(parseFollowsState(raw)).toBeUndefined();
  });
});
