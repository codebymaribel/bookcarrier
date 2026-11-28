import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonFileStore } from "./json-file.js";

/** A tiny state type, to test the store independently of the queue and the follows. */
type Box = { version: 1; values: number[] };

const empty = (): Box => ({ version: 1, values: [] });

function parse(raw: unknown): Box | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["version"] !== 1 || !Array.isArray(r["values"])) return undefined;
  if (!r["values"].every((v) => typeof v === "number")) return undefined;
  return { version: 1, values: r["values"] as number[] };
}

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-json-file-"));
  path = join(dir, "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = (p = path) => createJsonFileStore<Box>(p, parse, empty, () => 42);

describe("createJsonFileStore — read", () => {
  it("a missing file → empty state, no backup", async () => {
    expect(await store().read()).toEqual({ state: empty() });
  });

  it("write then read → the same state", async () => {
    await store().write({ version: 1, values: [1, 2] });
    expect(await store().read()).toEqual({ state: { version: 1, values: [1, 2] } });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["wrong version", JSON.stringify({ version: 2, values: [] })],
    ["parse rejects the shape", JSON.stringify({ version: 1, values: ["x"] })],
  ])("%s → moved to <path>.corrupt-<now>, empty state, backup returned", async (_case, text) => {
    await writeFile(path, text);
    expect(await store().read()).toEqual({ state: empty(), corruptBackup: `${path}.corrupt-42` });
    expect(await readFile(`${path}.corrupt-42`, "utf8")).toBe(text);
    expect(await readdir(dir)).toEqual(["state.json.corrupt-42"]);
  });

  it("a read error other than a missing file is thrown, and the file is left in place", async () => {
    await expect(store(dir).read()).rejects.toThrow();
  });
});

describe("createJsonFileStore — write", () => {
  it("writes pretty JSON with a trailing newline and leaves no temporary file", async () => {
    await store().write({ version: 1, values: [3] });
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify({ version: 1, values: [3] }, null, 2)}\n`);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("two concurrent writes run in order: the last one wins", async () => {
    const s = store();
    await Promise.all([s.write({ version: 1, values: [1] }), s.write({ version: 1, values: [2] })]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, values: [2] });
  });

  it("a failed write rejects, leaves the previous file intact, and later writes still run", async () => {
    const blocked = join(dir, "blocked");
    const nested = join(blocked, "state.json");
    const s = store(nested);
    await writeFile(blocked, "a file, not a dir");
    await expect(s.write({ version: 1, values: [1] })).rejects.toThrow();
    expect(await readFile(blocked, "utf8")).toBe("a file, not a dir");
    await rm(blocked);
    await s.write({ version: 1, values: [2] });
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual({ version: 1, values: [2] });
  });
});
