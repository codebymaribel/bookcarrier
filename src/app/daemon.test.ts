import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../shared/config.js";
import { createDaemon } from "./daemon.js";
import { messages } from "../telegram/messages.js";
import type { QueueItem } from "../retry-queue/state.js";

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
      expect(notify).toHaveBeenCalledWith(messages.queueFileCorrupt(join(root, backups[0]!))),
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
