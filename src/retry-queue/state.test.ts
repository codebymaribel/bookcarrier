import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStateStore, emptyState, type QueueItem, type QueueState } from "./state.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-state-"));
  path = join(dir, "queue.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const item = (id: string): QueueItem => ({
  id,
  url: `https://archiveofourown.org/works/${id}`,
  stage: "upload",
  epubPath: `/spool/${id}/x.epub`,
  title: "Title",
  attempts: 1,
  firstQueuedAt: 1_000,
  nextAttemptAt: 2_000,
  lastError: "Host is down",
});

const stateWith = (...ids: string[]): QueueState => ({ version: 1, items: ids.map(item) });

describe("readState", () => {
  it("a missing file → empty state, no error, no corrupt backup (R2.4)", async () => {
    const result = await createStateStore(path).read();
    expect(result).toEqual({ state: emptyState() });
    expect(await readdir(dir)).toEqual([]);
  });

  it("a valid file → parsed as written", async () => {
    await writeFile(path, JSON.stringify(stateWith("1", "2")));
    expect(await createStateStore(path).read()).toEqual({ state: stateWith("1", "2") });
  });

  it("an item without the optional fields is accepted (stage download)", async () => {
    const { epubPath: _e, title: _t, ...rest } = item("1");
    const state = { version: 1, items: [{ ...rest, stage: "download" }] };
    await writeFile(path, JSON.stringify(state));
    expect((await createStateStore(path).read()).state).toEqual(state);
  });

  it("a deferred item round-trips; deferred must be a boolean when present (S7)", async () => {
    const deferred = { ...item("1"), deferred: true };
    await writeFile(path, JSON.stringify({ version: 1, items: [deferred] }));
    expect((await createStateStore(path).read()).state.items).toEqual([deferred]);
    await writeFile(path, JSON.stringify({ version: 1, items: [{ ...item("1"), deferred: "yes" }] }));
    expect((await createStateStore(path, () => 7).read()).corruptBackup).toBe(join(dir, "queue.json.corrupt-7"));
  });

  it("corrupt JSON → renamed to .corrupt-<ts>, empty state, and signalled (R2.5)", async () => {
    await writeFile(path, "{ not json");
    const result = await createStateStore(path, () => 1_700_000_000_000).read();
    expect(result.state).toEqual(emptyState());
    expect(result.corruptBackup).toBe(join(dir, "queue.json.corrupt-1700000000000"));
    expect(await readdir(dir)).toEqual(["queue.json.corrupt-1700000000000"]);
    expect(await readFile(join(dir, "queue.json.corrupt-1700000000000"), "utf8")).toBe("{ not json");
  });

  it("valid JSON with the wrong shape (unknown version, bad item) → treated as corrupt (R2.5)", async () => {
    for (const bad of [{ version: 2, items: [] }, { version: 1, items: [{ id: 1 }] }, []]) {
      await writeFile(path, JSON.stringify(bad));
      const result = await createStateStore(path, () => 5).read();
      expect(result.state).toEqual(emptyState());
      expect(result.corruptBackup).toBe(join(dir, "queue.json.corrupt-5"));
      await rm(join(dir, "queue.json.corrupt-5"));
    }
  });
});

describe("writeState (R2.1, R2.2)", () => {
  it("writes the full state, readable back", async () => {
    const store = createStateStore(path);
    await store.write(stateWith("1"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stateWith("1"));
  });

  it("two concurrent writes → the file is valid JSON with the LAST write", async () => {
    const store = createStateStore(path);
    await Promise.all([store.write(stateWith("1")), store.write(stateWith("1", "2"))]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stateWith("1", "2"));
  });

  it("leaves no temporary file in the directory", async () => {
    const store = createStateStore(path);
    await store.write(stateWith("1"));
    await store.write(stateWith("2"));
    expect(await readdir(dir)).toEqual(["queue.json"]);
  });

  it("creates the parent directory if it is missing", async () => {
    const nested = join(dir, "a", "b", "queue.json");
    await createStateStore(nested).write(stateWith("1"));
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual(stateWith("1"));
  });

  it("a failed write rejects, and later writes still run", async () => {
    const store = createStateStore(join(dir, "missing-file-as-dir", "queue.json"));
    await writeFile(join(dir, "missing-file-as-dir"), "a file, not a dir");
    await expect(store.write(stateWith("1"))).rejects.toThrow();
    await rm(join(dir, "missing-file-as-dir"));
    await store.write(stateWith("2"));
    expect(JSON.parse(await readFile(join(dir, "missing-file-as-dir", "queue.json"), "utf8"))).toEqual(
      stateWith("2"),
    );
  });
});
