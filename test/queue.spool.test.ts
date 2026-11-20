import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpool } from "../src/queue/spool.js";

let root: string;
let spoolDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bookcarrier-spool-"));
  spoolDir = join(root, "spool");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function putEpub(id: string, name = "1-Title.epub"): Promise<string> {
  await mkdir(join(spoolDir, id), { recursive: true });
  const path = join(spoolDir, id, name);
  await writeFile(path, "epub");
  return path;
}

describe("prepare", () => {
  it("creates an empty directory for the item inside the spool (R5.1)", async () => {
    const spool = createSpool(spoolDir);
    const dir = await spool.prepare("a");
    expect(dir).toBe(join(spoolDir, "a"));
    expect(await readdir(dir)).toEqual([]);
  });

  it("empties a leftover directory from an earlier attempt (FanFicFare needs exactly one EPUB)", async () => {
    await putEpub("a", "old.epub");
    const dir = await createSpool(spoolDir).prepare("a");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("discard (R5.2, R4.2)", () => {
  it("deletes the item's EPUB and its directory", async () => {
    await putEpub("a");
    await putEpub("b");
    await createSpool(spoolDir).discard("a");
    expect(await readdir(spoolDir)).toEqual(["b"]);
  });

  it("does not fail if it is already gone", async () => {
    await expect(createSpool(spoolDir).discard("never-existed")).resolves.toBeUndefined();
  });

  it("refuses an id that would escape the spool", async () => {
    await expect(createSpool(spoolDir).discard("../outside")).rejects.toThrow(/invalid spool id/);
    await expect(createSpool(spoolDir).prepare("")).rejects.toThrow(/invalid spool id/);
  });
});

describe("reconcile (R5.3)", () => {
  it("deletes orphan EPUBs and keeps the ones referenced by the restored queue", async () => {
    const kept = await putEpub("kept");
    await putEpub("orphan");
    await writeFile(join(spoolDir, "loose.epub"), "x");
    const removed = await createSpool(spoolDir).reconcile([{ id: "kept", epubPath: kept }]);
    expect(await readdir(spoolDir)).toEqual(["kept"]);
    expect(await readdir(join(spoolDir, "kept"))).toEqual(["1-Title.epub"]);
    expect(removed.sort()).toEqual(["loose.epub", "orphan"]);
  });

  it("a download-stage item (no EPUB yet) does not keep a leftover directory", async () => {
    await putEpub("dl");
    await createSpool(spoolDir).reconcile([{ id: "dl" }]);
    expect(await readdir(spoolDir)).toEqual([]);
  });

  it("a missing spool directory is not an error", async () => {
    await expect(createSpool(spoolDir).reconcile([])).resolves.toEqual([]);
  });
});
