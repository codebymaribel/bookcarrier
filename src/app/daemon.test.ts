import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../shared/index.js";
import { createDaemon } from "./daemon.js";
import { type FicMeta, messages } from "../fanfic/index.js";
import { followsMessages } from "../follows/index.js";
import { messages as queueMessages, type QueueItem } from "../retry-queue/index.js";

const MIN = 60_000;
let root: string;
let config: ResolvedConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bookcarrier-daemon-"));
  config = {
    telegramToken: "1:x",
    ownerId: 42,
    kindleUser: "root",
    kindleHost: "192.168.1.50",
    sshKeyPath: "/keys/k",
    downloadTimeoutMs: 1_000,
    uploadTimeoutMs: 1_000,
    sshConnectTimeoutSec: 1,
    kindlePort: 2222,
    remotePath: "/mnt/us/documents/",
    queuePath: join(root, "queue.json"),
    followsPath: join(root, "follows.json"),
    spoolDir: join(root, "spool"),
    giveUpAfterMs: 30 * MIN,
    retryBackoffMinutes: [1, 2, 4, 8, 15],
    deferredRetryMs: 7_200_000,
    deferredGiveUpAfterMs: 86_400_000,
    documentFolders: new Map([
      ["epub", "/mnt/us/documents/books/"],
      ["mobi", "/mnt/us/documents/books/"],
      ["pdf", "/mnt/us/documents/books/"],
    ]),
  };
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function persistedItem(overrides: Partial<QueueItem> = {}): Promise<QueueItem> {
  const epubPath = join(config.spoolDir, "kept", "1-Title.epub");
  await mkdir(join(config.spoolDir, "kept"), { recursive: true });
  await writeFile(epubPath, "epub");
  const item: QueueItem = {
    id: "kept",
    url: "https://archiveofourown.org/works/1",
    stage: "upload",
    epubPath,
    title: "Title",
    attempts: 1,
    firstQueuedAt: Date.now() - 2 * MIN,
    nextAttemptAt: Date.now() + 5 * MIN,
    lastError: "Host is down",
    ...overrides,
  };
  await writeFile(config.queuePath, JSON.stringify({ version: 1, items: [item] }));
  return item;
}

describe("startup restoration (R2.3, R5.3, acceptance 4)", () => {
  it("restores the queue, reconciles the spool and reschedules the timer at the item's time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 10 * MIN });
    const item = await persistedItem();
    const orphan = join(config.spoolDir, "44444444-4444-4444-8444-444444444444");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "x.epub"), "x");

    const upload = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger: silent(), notify, upload, download: vi.fn() });
    expect(daemon.queue.items()).toEqual([item]);
    expect(await readdir(config.spoolDir)).toEqual(["kept"]);

    daemon.start();
    expect(daemon.scheduler.nextWakeAt()).toBe(item.nextAttemptAt);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    // the retry does real disk I/O (state file, spool), so wait for it to settle
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(messages.delivered("Title")));
    expect(upload).toHaveBeenCalledWith(item.epubPath, expect.anything());
    expect(daemon.queue.items()).toEqual([]);
    expect(await readdir(config.spoolDir)).toEqual([]);
    expect(JSON.parse(await readFile(config.queuePath, "utf8"))).toEqual({ version: 1, items: [] });
    expect(daemon.scheduler.nextWakeAt()).toBeUndefined();
    daemon.stop();
  });

  it("an item that came due while the daemon was down is retried right away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 10 * MIN });
    await persistedItem({ nextAttemptAt: 9 * MIN });
    const upload = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger: silent(), notify, upload });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(messages.delivered("Title")));
    expect(upload).toHaveBeenCalledTimes(1);
    daemon.stop();
  });

  it("no state file → empty queue, no timer, no notice (R2.4, R3.5)", async () => {
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger: silent(), notify });
    daemon.start();
    expect(daemon.queue.items()).toEqual([]);
    expect(daemon.scheduler.nextWakeAt()).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    daemon.stop();
  });

  it("a corrupt state file → empty queue, file kept aside, the owner is notified (R2.5)", async () => {
    await writeFile(config.queuePath, "{ broken");
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger: silent(), notify });
    daemon.start();
    expect(daemon.queue.items()).toEqual([]);
    const backups = (await readdir(root)).filter((n) => n.startsWith("queue.json.corrupt-"));
    expect(backups).toHaveLength(1);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(queueMessages.queueFileCorrupt(join(root, backups[0]!))),
    );
    daemon.stop();
  });

  it("a new enqueue arms the timer (the queue's onChange is wired to the scheduler)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
    const daemon = await createDaemon(config, { logger: silent(), notify: vi.fn(async () => {}) });
    daemon.start();
    await daemon.queue.enqueue({ url: "u", stage: "download", error: "429" });
    expect(daemon.scheduler.nextWakeAt()).toBe(1 * MIN);
    daemon.stop();
  });
});

describe("pollUntilStopped (R7.1: a crash must end the process so launchd relaunches it)", () => {
  it("polling dying after start (e.g. a 409) stops the retry timer and rethrows", async () => {
    const { pollUntilStopped } = await import("./daemon.js");
    const daemon = { start: vi.fn(), stop: vi.fn() };
    const conflict = new Error("409: Conflict: terminated by other getUpdates request");
    const bot = {
      start: vi.fn(async (opts?: { onStart?: (info: { username: string }) => void }) => {
        opts?.onStart?.({ username: "b" });
        throw conflict;
      }),
    };
    await expect(pollUntilStopped(bot, daemon, silent())).rejects.toBe(conflict);
    expect(daemon.start).toHaveBeenCalledTimes(1);
    expect(daemon.stop).toHaveBeenCalledTimes(1);
  });

  it("a clean stop also stops the retry timer and resolves", async () => {
    const { pollUntilStopped } = await import("./daemon.js");
    const daemon = { start: vi.fn(), stop: vi.fn() };
    const bot = { start: vi.fn(async () => {}) };
    await expect(pollUntilStopped(bot, daemon, silent())).resolves.toBeUndefined();
    expect(daemon.stop).toHaveBeenCalledTimes(1);
  });
});

describe("follows file at startup (R5.2, R5.3; acceptance 8, 9, 15)", () => {
  const META: FicMeta = {
    workId: "1",
    url: "https://archiveofourown.org/works/1",
    title: "Title",
    author: "Someone",
    chapters: 12,
    status: "in-progress",
  };

  it("no follows file → starts with nothing followed, no error logged", async () => {
    const logger = silent();
    const daemon = await createDaemon(config, { logger, notify: vi.fn(async () => {}) });
    expect(await daemon.follows.follow("1")).toEqual({ kind: "unknown" });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a corrupt follows file → the daemon starts empty, the file is kept aside, the error log names the backup, the owner is told", async () => {
    await writeFile(config.followsPath, "{ broken");
    const logger = silent();
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger, notify });
    daemon.start();
    const backups = (await readdir(root)).filter((n) => n.startsWith("follows.json.corrupt-"));
    expect(backups).toHaveLength(1);
    const backup = join(root, backups[0]!);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("follows"), { corruptBackup: backup });
    expect(await daemon.follows.follow("1")).toEqual({ kind: "unknown" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(followsMessages.followsFileCorrupt(backup)));
    daemon.stop();
  });

  it("a valid follows file → the first tap after startup sees the followed and recent fics", async () => {
    const followed = { ...META, workId: "7", title: "Kept", followedAt: 1, updatedAt: 2 };
    await writeFile(config.followsPath, JSON.stringify({ version: 1, followed: [followed], recent: [META] }));
    const logger = silent();
    const daemon = await createDaemon(config, { logger, notify: vi.fn(async () => {}) });
    expect(logger.error).not.toHaveBeenCalled();
    expect(await daemon.follows.follow("7")).toEqual({ kind: "already", fic: followed });
    expect((await daemon.follows.follow("1")).kind).toBe("followed");
    expect(await daemon.follows.unfollow("7")).toEqual({ kind: "unfollowed", title: "Kept" });
    const saved = JSON.parse(await readFile(config.followsPath, "utf8"));
    expect(saved.followed.map((f: { workId: string }) => f.workId)).toEqual(["1"]);
  });

  it("the pipeline uses the same follows: a retry delivery offers Follow, and the tap then follows it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 10 * MIN });
    await persistedItem({ nextAttemptAt: 9 * MIN, meta: META });
    const notify = vi.fn(async () => {});
    const daemon = await createDaemon(config, { logger: silent(), notify, upload: vi.fn(async () => {}) });
    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(messages.delivered("Title"), { action: "follow", workId: "1" }),
    );
    expect((await daemon.follows.follow("1")).kind).toBe("followed");
    expect(JSON.parse(await readFile(config.followsPath, "utf8")).followed).toHaveLength(1);
    daemon.stop();
  });
});
