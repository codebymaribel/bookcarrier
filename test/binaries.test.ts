import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRequiredBinaries, findMissingBinaries } from "../src/binaries.js";
import type { Logger } from "../src/logger.js";

type Entry = { level: "info" | "warn" | "error"; message: string; meta?: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  const push =
    (level: Entry["level"]) =>
    (message: string, meta?: Record<string, unknown>): void => {
      entries.push(meta === undefined ? { level, message } : { level, message, meta });
    };
  return { logger: { info: push("info"), warn: push("warn"), error: push("error") }, entries };
}

async function fakeBinary(dir: string, name: string, executable: boolean): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, executable ? 0o755 : 0o644);
}

describe("binary check at startup (R7.7)", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "bookcarrier-bin-a-"));
    dirB = await mkdtemp(join(tmpdir(), "bookcarrier-bin-b-"));
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("fanficfare missing → one error naming it (and the PATH)", async () => {
    await fakeBinary(dirA, "scp", true);
    const path = [dirA, dirB].join(delimiter);
    const { logger, entries } = recordingLogger();

    await checkRequiredBinaries(logger, path);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.level).toBe("error");
    expect(entry?.message).toContain("fanficfare");
    expect(entry?.message).not.toContain("scp");
    expect(entry?.meta).toEqual({ missing: ["fanficfare"], path });
  });

  it("both present (in different PATH entries) → logs nothing", async () => {
    await fakeBinary(dirA, "scp", true);
    await fakeBinary(dirB, "fanficfare", true);
    const { logger, entries } = recordingLogger();

    await checkRequiredBinaries(logger, [dirA, dirB].join(delimiter));

    expect(entries).toEqual([]);
  });

  it("a non-executable file does not count as present", async () => {
    await fakeBinary(dirA, "scp", true);
    await fakeBinary(dirA, "fanficfare", false);

    expect(await findMissingBinaries(["fanficfare", "scp"], dirA)).toEqual(["fanficfare"]);
  });

  it("empty PATH → every binary is missing", async () => {
    expect(await findMissingBinaries(["fanficfare", "scp"], "")).toEqual(["fanficfare", "scp"]);
  });
});
