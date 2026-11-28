import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "../telegram/index.js";
import { createPipeline, type PipelineDeps, type RequestConfig } from "./pipeline.js";
import type { Logger, ResolvedConfig } from "../shared/index.js";
import type { FicMeta } from "./fic-meta.js";
import type { DeliveryOutcome } from "../follows/index.js";
import {
  DownloadFailedError,
  DownloadLaunchError,
  type DownloadResult,
} from "./downloader.js";
import { messages } from "./messages.js";
import { createQueue, type Queue, type QueueItem, type QueueState } from "../retry-queue/index.js";
import { UploadConfigError, UploadFailedError } from "../kindle/index.js";

const MIN = 60_000;

const config: RequestConfig = {
  downloadTimeoutMs: 123_000,
  uploadTimeoutMs: 45_000,
  sshConnectTimeoutSec: 7,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/AO3/",
  sshKeyPath: "/keys/kindle",
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  giveUpAfterMs: 30 * MIN,
  retryBackoffMinutes: [1, 2, 4, 8, 15],
  deferredRetryMs: 7_200_000,
  deferredGiveUpAfterMs: 86_400_000,
};

const LINK = "https://archiveofourown.org/works/65164981";
const SPOOL = "/spool";
const ITEM_DIR = `${SPOOL}/req-1`;
const RESULT: DownloadResult = { filePath: `${ITEM_DIR}/65164981-Title.epub`, title: "Title" };

const TRANSIENT_DOWNLOAD = new DownloadFailedError(
  "exit-code",
  "fanficfare exited with code 1: HTTP Error 429: Too Many Requests",
  "HTTP Error 429: Too Many Requests",
);
const UNAVAILABLE_DOWNLOAD = new DownloadFailedError(
  "exit-code",
  "fanficfare exited with code 1: HTTP Error 503: Service Unavailable",
  "Traceback (most recent call last):\nHTTP Error 503: Service Unavailable",
);
const PERMANENT_DOWNLOAD = new DownloadFailedError(
  "exit-code",
  "fanficfare exited with code 1: Story does not exist",
  "StoryDoesNotExist: Story does not exist",
);
const TIMEOUT_DOWNLOAD = new DownloadFailedError("timeout", "fanficfare timed out after 600s");
const HOUR = 60 * MIN;
const UNREACHABLE = new UploadFailedError("exit-code", "scp exited with code 255: Host is down");
const BROKEN_KEY = new UploadConfigError("key-missing", "SSH key not found: /keys/kindle");

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Fake deps that record the order of everything that happens in one shared `events` list. The queue
 * is the real one, over an in-memory store, so tests assert on what would be persisted.
 */
function setup(overrides: Partial<PipelineDeps> = {}, opts: { initial?: QueueItem[]; now?: () => number } = {}) {
  const events: string[] = [];
  const replies: string[] = [];
  const notices: string[] = [];
  const writes: QueueState[] = [];
  const logger = silentLogger();
  let ids = 0;
  const queue: Queue = createQueue({
    store: {
      read: async () => ({ state: { version: 1, items: [] } }),
      write: async (state) => {
        writes.push(structuredClone(state));
      },
    },
    initial: opts.initial ?? [],
    backoffMs: config.retryBackoffMinutes.map((m) => m * MIN),
    giveUpAfterMs: config.giveUpAfterMs,
    deferredRetryMs: config.deferredRetryMs,
    deferredGiveUpAfterMs: config.deferredGiveUpAfterMs,
    now: opts.now ?? (() => 0),
  });
  const deps: PipelineDeps = {
    download: vi.fn(async (url: string, outDir: string) => {
      events.push(`download ${url} -> ${outDir}`);
      return RESULT;
    }),
    upload: vi.fn(async (path: string) => {
      events.push(`upload ${path}`);
    }),
    spool: {
      prepare: vi.fn(async (id: string) => {
        events.push(`prepare ${id}`);
        return `${SPOOL}/${id}`;
      }),
      discard: vi.fn(async (id: string) => {
        events.push(`discard ${id}`);
      }),
    },
    queue,
    newId: () => `req-${++ids}`,
    logger,
    now: opts.now ?? (() => 0),
    follows: { onDelivered: async () => ({ kind: "none" }) },
    ...overrides,
  };
  const pipeline = createPipeline(config, deps);
  const reply = async (text: string) => {
    replies.push(text);
    events.push(`reply ${text}`);
  };
  const notify = async (text: string) => {
    notices.push(text);
    events.push(`notify ${text}`);
  };
  const handle = (text: string) => pipeline.handle(text, reply);
  return { deps, pipeline, handle, reply, notify, events, replies, notices, writes, logger, queue };
}

const queued = (overrides: Partial<QueueItem>): QueueItem => ({
  id: "q-1",
  url: LINK,
  stage: "upload",
  epubPath: `${SPOOL}/q-1/65164981-Title.epub`,
  title: "Title",
  attempts: 0,
  firstQueuedAt: 0,
  nextAttemptAt: 1 * MIN,
  lastError: "Host is down",
  ...overrides,
});

describe("request flow — success (R2.1, R5.4 of feature 1)", () => {
  it("acknowledges, downloads INTO THE SPOOL, uploads, confirms with the title, then cleans the spool", async () => {
    const { handle, events, writes } = setup();
    await handle(LINK);
    expect(events).toEqual([
      `reply ${messages.ack}`,
      "prepare req-1",
      `download ${LINK} -> ${ITEM_DIR}`,
      `upload ${RESULT.filePath}`,
      `reply ${messages.delivered("Title")}`,
      "discard req-1",
    ]);
    expect(writes).toEqual([]);
  });

  it("works with the real Android share text (title line + URL)", async () => {
    const { handle, deps } = setup();
    await handle(
      "Rio, Rio - carsynmerrill (onthepitch) - Agatha All Along (TV) [Archive of Our Own]\n" +
        "https://archiveofourown.org/works/61265059",
    );
    expect(deps.download).toHaveBeenCalledWith(
      "https://archiveofourown.org/works/61265059",
      expect.any(String),
      expect.anything(),
    );
  });
});

describe("request flow — what each step receives", () => {
  it("the downloader gets the CANONICAL url and the item's spool directory", async () => {
    const { handle, deps } = setup();
    await handle(`look: https://www.archiveofourown.org/works/65164981/chapters/9?view_adult=true#top`);
    expect(deps.download).toHaveBeenCalledWith(LINK, ITEM_DIR, {
      timeoutMs: 123_000,
      workId: "65164981",
    });
  });

  it("the uploader gets the downloaded file and the options mapped from config", async () => {
    const { handle, deps } = setup();
    await handle(LINK);
    expect(deps.upload).toHaveBeenCalledWith(RESULT.filePath, {
      sshKeyPath: "/keys/kindle",
      kindleUser: "root",
      kindleHost: "192.168.1.50",
      port: 2222,
      remotePath: "/mnt/us/documents/books/AO3/",
      connectTimeoutSec: 7,
      timeoutMs: 45_000,
    });
  });
});

describe("request flow — chapter metadata (feature 5, R2.3, R2.5)", () => {
  const META: FicMeta = {
    workId: "65164981",
    url: LINK,
    title: "Title",
    author: "A",
    chapters: 4,
    status: "in-progress",
  };

  it("a download whose upload failed transiently is enqueued with its meta", async () => {
    const { handle, queue } = setup({
      download: vi.fn(async () => ({ ...RESULT, meta: META })),
      upload: vi.fn().mockRejectedValue(UNREACHABLE),
    });
    await handle(LINK);
    expect(queue.items()[0]?.meta).toEqual(META);
  });

  const { epubPath: _e, title: _t, ...rest } = queued({ stage: "download" });
  const downloadStageItem: QueueItem = rest;

  it("a retried download is promoted with the download's meta and the work id is derived from the item URL", async () => {
    const download = vi.fn(async () => ({ ...RESULT, meta: META }));
    const { pipeline, notify, queue } = setup(
      { download, upload: vi.fn().mockRejectedValue(UNREACHABLE) },
      { initial: [downloadStageItem] },
    );
    await pipeline.processDue(queue.items(), notify);
    expect(queue.items()[0]).toMatchObject({ stage: "upload", meta: META });
    expect(download).toHaveBeenCalledWith(
      downloadStageItem.url,
      expect.any(String),
      expect.objectContaining({ workId: "65164981" }),
    );
  });

  it("a deferred item promoted on a retry carries its meta and keeps deferred (#7)", async () => {
    const { pipeline, notify, queue } = setup(
      { download: vi.fn(async () => ({ ...RESULT, meta: META })), upload: vi.fn().mockRejectedValue(UNREACHABLE) },
      { initial: [{ ...downloadStageItem, deferred: true }] },
    );
    await pipeline.processDue(queue.items(), notify);
    expect(queue.items()[0]).toMatchObject({ stage: "upload", meta: META, deferred: true });
  });

  it("a link deferred straight away (cooldown) is enqueued without meta and not downloaded", async () => {
    const { handle, queue, deps } = setup(
      {},
      { initial: [{ ...downloadStageItem, id: "q-0", deferred: true, nextAttemptAt: 2 * HOUR }] },
    );
    await handle(LINK);
    expect(deps.download).not.toHaveBeenCalled();
    const added = queue.items().find((i) => i.id === "req-1");
    expect(added).toMatchObject({ deferred: true, stage: "download" });
    expect(added?.meta).toBeUndefined();
  });

  it("a metaWarning from the downloader is logged with the work id and the delivery still happens", async () => {
    const { handle, logger, replies } = setup({
      download: vi.fn(async () => ({ ...RESULT, metaWarning: "no chapter metadata for work 65164981: x" })),
    });
    await handle(LINK);
    expect(logger.warn).toHaveBeenCalledWith(
      "no chapter metadata for work 65164981: x",
      expect.objectContaining({ workId: "65164981" }),
    );
    expect(replies.at(-1)).toBe(messages.delivered("Title"));
  });
});

describe("request flow — links that are not accepted", () => {
  it.each(["hello", "https://example.com/works/1", ""])(
    "%j → 'not recognized', no acknowledgement, nothing is run",
    async (text) => {
      const { handle, replies, deps } = setup();
      await handle(text);
      expect(replies).toEqual([messages.noLink]);
      expect(deps.spool.prepare).not.toHaveBeenCalled();
      expect(deps.download).not.toHaveBeenCalled();
    },
  );

  it("an AO3 link that is not a work → 'not supported yet', nothing is run", async () => {
    const { handle, replies, deps } = setup();
    await handle("https://archiveofourown.org/series/456");
    expect(replies).toEqual([messages.unsupportedLink]);
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe("enqueueing (R1, R6.1)", () => {
  it("transient download failure → enqueued at stage download and notified ONCE (R1.1, R6.1, acceptance 5)", async () => {
    const { handle, replies, queue, writes, deps } = setup({
      download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD),
    });
    await handle(LINK);
    expect(queue.items()).toEqual([
      {
        id: "req-1",
        url: LINK,
        stage: "download",
        attempts: 0,
        firstQueuedAt: 0,
        nextAttemptAt: 1 * MIN,
        lastError: TRANSIENT_DOWNLOAD.message,
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(replies).toEqual([messages.ack, messages.queuedDownload(TRANSIENT_DOWNLOAD.message, 30)]);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("permanent download failure → NOT enqueued, the error is reported as in feature 1 (R1.2)", async () => {
    const { handle, replies, queue, writes, events } = setup({
      download: vi.fn().mockRejectedValue(PERMANENT_DOWNLOAD),
    });
    await handle(LINK);
    expect(queue.items()).toEqual([]);
    expect(writes).toEqual([]);
    expect(replies.at(-1)).toBe(messages.downloadFailed(PERMANENT_DOWNLOAD.message));
    expect(events.at(-1)).toBe("discard req-1");
  });

  it("FanFicFare cannot be launched → its own message, not enqueued", async () => {
    const { handle, replies, queue } = setup({
      download: vi
        .fn()
        .mockRejectedValue(new DownloadLaunchError("fanficfare", new Error("spawn fanficfare ENOENT"))),
    });
    await handle(LINK);
    expect(replies.at(-1)).toContain("couldn't start FanFicFare");
    expect(queue.items()).toEqual([]);
  });

  it("transient upload failure → enqueued at stage upload KEEPING the EPUB (R1.3, acceptance 1)", async () => {
    const { handle, replies, queue, deps } = setup({ upload: vi.fn().mockRejectedValue(UNREACHABLE) });
    await handle(LINK);
    expect(queue.items()).toEqual([
      expect.objectContaining({
        id: "req-1",
        stage: "upload",
        epubPath: RESULT.filePath,
        title: "Title",
        lastError: UNREACHABLE.message,
      }),
    ]);
    expect(deps.spool.discard).not.toHaveBeenCalled();
    expect(replies).toEqual([messages.ack, messages.queuedUpload("Title", UNREACHABLE.message, 30)]);
  });

  it("permanent upload failure (broken config) → NOT enqueued, configuration message (R1.4, acceptance 6)", async () => {
    const { handle, replies, queue, deps } = setup({ upload: vi.fn().mockRejectedValue(BROKEN_KEY) });
    await handle(LINK);
    expect(queue.items()).toEqual([]);
    expect(replies.at(-1)).toBe(messages.uploadConfig(BROKEN_KEY.message));
    expect(deps.spool.discard).toHaveBeenCalledWith("req-1");
  });

  it("if persisting the enqueue fails, the owner gets the plain failure message and the spool is cleaned", async () => {
    const { handle, replies, logger, deps } = setup({
      upload: vi.fn().mockRejectedValue(UNREACHABLE),
      queue: {
        enqueue: vi.fn().mockRejectedValue(new Error("ENOSPC")),
        promoteToUpload: vi.fn(),
        recordFailure: vi.fn(),
        remove: vi.fn(),
        cooldownUntil: vi.fn(() => undefined),
      },
    });
    await handle(LINK);
    expect(replies.at(-1)).toBe(messages.sendFailed("Title", UNREACHABLE.message));
    expect(logger.error).toHaveBeenCalledWith("could not enqueue", expect.anything());
    expect(deps.spool.discard).toHaveBeenCalledWith("req-1");
  });

  it("an unexpected error → generic message with no details, logged, not enqueued", async () => {
    const boom = new TypeError("secret internal detail at /Users/x/y.ts:12");
    const { handle, replies, logger, queue } = setup({ download: vi.fn().mockRejectedValue(boom) });
    await handle(LINK);
    expect(replies.at(-1)).toBe(messages.unexpected);
    expect(replies.join("\n")).not.toContain("secret");
    expect(logger.error).toHaveBeenCalledWith("request failed", expect.objectContaining({ error: boom }));
    expect(queue.items()).toEqual([]);
  });

  it("a failing spool directory → generic message, nothing downloaded", async () => {
    const { handle, replies, deps } = setup({
      spool: { prepare: vi.fn().mockRejectedValue(new Error("EACCES")), discard: vi.fn(async () => {}) },
    });
    await handle(LINK);
    expect(replies.at(-1)).toBe(messages.unexpected);
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("the subprocess's stderr goes to the log, never to the owner", async () => {
    const { handle, replies, logger } = setup({ download: vi.fn().mockRejectedValue(UNAVAILABLE_DOWNLOAD) });
    await handle(LINK);
    expect(replies.join("\n")).not.toContain(UNAVAILABLE_DOWNLOAD.stderr);
    expect(logger.error).toHaveBeenCalledWith(
      "request failed",
      expect.objectContaining({ error: UNAVAILABLE_DOWNLOAD, stderr: UNAVAILABLE_DOWNLOAD.stderr }),
    );
  });

  it("a 429 is logged as one WARN line: download failed -> 429 Client Error: Too Many Requests", async () => {
    const { handle, logger } = setup({ download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) });
    await handle(LINK);
    expect(logger.warn).toHaveBeenCalledWith("download failed -> 429 Client Error: Too Many Requests", {
      workId: "65164981",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a retried 429 is logged as one WARN line: download failed -> 429 Client Error: Too Many Requests", async () => {
    const item = queued({ stage: "download", lastError: TRANSIENT_DOWNLOAD.message });
    delete item.title;
    delete item.epubPath;
    const { pipeline, notify, logger } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [item], now: () => 1 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(logger.warn).toHaveBeenCalledWith("download failed -> 429 Client Error: Too Many Requests", {
      workId: "65164981",
    });
    expect(logger.warn).not.toHaveBeenCalledWith("retry failed", expect.anything());
  });

  it("a failure cleaning the spool is logged and does not change the outcome", async () => {
    const { handle, replies, logger } = setup({
      spool: {
        prepare: vi.fn(async () => ITEM_DIR),
        discard: vi.fn().mockRejectedValue(new Error("EBUSY")),
      },
    });
    await expect(handle(LINK)).resolves.toBeUndefined();
    expect(replies.at(-1)).toBe(messages.delivered("Title"));
    expect(logger.warn).toHaveBeenCalledWith("could not clean the spool", expect.anything());
  });

  it("if sending a message fails, it is logged and the fic is still delivered", async () => {
    const { pipeline, deps, logger } = setup();
    const failingReply = vi.fn().mockRejectedValue(new Error("Telegram is down"));
    await expect(pipeline.handle(LINK, failingReply)).resolves.toBeUndefined();
    expect(deps.upload).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("retries (R3, R4, R5.2, R6)", () => {
  it("successful retry of stage upload → only the upload runs, notifies with the title, cleans the spool (R3.1, R6.2, R5.2, acceptance 2)", async () => {
    const item = queued({});
    const { pipeline, notify, events, queue, deps } = setup({}, { initial: [item], now: () => 1 * MIN });
    await pipeline.processDue([item], notify);
    expect(deps.download).not.toHaveBeenCalled();
    expect(events).toEqual([
      `upload ${item.epubPath}`,
      "discard q-1",
      `notify ${messages.delivered("Title")}`,
    ]);
    expect(queue.items()).toEqual([]);
  });

  it("failed intermediate retry → no notification, attempts and next time updated (R6.3, R3.3)", async () => {
    const item = queued({});
    const { pipeline, notify, notices, queue, deps } = setup(
      { upload: vi.fn().mockRejectedValue(UNREACHABLE) },
      { initial: [item], now: () => 1 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([]);
    expect(queue.items()).toEqual([
      expect.objectContaining({ attempts: 1, nextAttemptAt: 3 * MIN, lastError: UNREACHABLE.message }),
    ]);
    expect(deps.spool.discard).not.toHaveBeenCalled();
  });

  it("give-up → notifies with the last error, removes the item and cleans the spool (R4, R6.4, acceptance 3)", async () => {
    const item = queued({ attempts: 4, nextAttemptAt: 30 * MIN });
    const { pipeline, notify, notices, queue, deps } = setup(
      { upload: vi.fn().mockRejectedValue(UNREACHABLE) },
      { initial: [item], now: () => 30 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(queue.items()).toEqual([]);
    expect(deps.spool.discard).toHaveBeenCalledWith("q-1");
    expect(notices).toEqual([messages.gaveUp("Title", UNREACHABLE.message, 30)]);
  });

  it("a download-stage item that gives up is named by its URL (no title yet)", async () => {
    const item = queued({ stage: "download", attempts: 4 });
    delete item.title;
    delete item.epubPath;
    const { pipeline, notify, notices } = setup(
      { download: vi.fn().mockRejectedValue(TIMEOUT_DOWNLOAD) },
      { initial: [item], now: () => 30 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([messages.gaveUp(LINK, TIMEOUT_DOWNLOAD.message, 30)]);
  });

  it("successful retry of stage download → promotes to upload and continues (R3.2, acceptance 5)", async () => {
    const item = queued({ stage: "download" });
    delete item.title;
    delete item.epubPath;
    const { pipeline, notify, events, writes, queue } = setup({}, { initial: [item], now: () => 1 * MIN });
    await pipeline.processDue([item], notify);
    expect(events).toEqual([
      "prepare q-1",
      `download ${LINK} -> ${SPOOL}/q-1`,
      `upload ${RESULT.filePath}`,
      "discard q-1",
      `notify ${messages.delivered("Title")}`,
    ]);
    // the promotion was persisted before the upload, keeping the window's start
    expect(writes[0]?.items).toEqual([
      expect.objectContaining({ stage: "upload", epubPath: RESULT.filePath, title: "Title", firstQueuedAt: 0 }),
    ]);
    expect(queue.items()).toEqual([]);
  });

  it("download retry OK but upload fails → stays queued at stage upload, silently", async () => {
    const item = queued({ stage: "download" });
    delete item.title;
    delete item.epubPath;
    const { pipeline, notify, notices, queue } = setup(
      { upload: vi.fn().mockRejectedValue(UNREACHABLE) },
      { initial: [item], now: () => 1 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([]);
    expect(queue.items()).toEqual([
      expect.objectContaining({ stage: "upload", epubPath: RESULT.filePath, attempts: 1 }),
    ]);
  });

  it("a retry that hits a permanent error → removed, spool cleaned, owner told why", async () => {
    const item = queued({});
    const { pipeline, notify, notices, queue, deps } = setup(
      { upload: vi.fn().mockRejectedValue(BROKEN_KEY) },
      { initial: [item], now: () => 1 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(queue.items()).toEqual([]);
    expect(deps.spool.discard).toHaveBeenCalledWith("q-1");
    expect(notices).toEqual([messages.uploadConfig(BROKEN_KEY.message)]);
  });

  it("processes every due item of the batch, one after the other", async () => {
    const a = queued({ id: "a", epubPath: "/spool/a/x.epub" });
    const b = queued({ id: "b", epubPath: "/spool/b/y.epub" });
    const { pipeline, notify, events } = setup({}, { initial: [a, b], now: () => 1 * MIN });
    await pipeline.processDue([a, b], notify);
    expect(events.filter((e) => e.startsWith("upload"))).toEqual([
      "upload /spool/a/x.epub",
      "upload /spool/b/y.epub",
    ]);
  });

  it("a failed notification does not stop the batch", async () => {
    const a = queued({ id: "a" });
    const b = queued({ id: "b" });
    const { pipeline, queue, logger } = setup({}, { initial: [a, b], now: () => 1 * MIN });
    await pipeline.processDue([a, b], vi.fn().mockRejectedValue(new Error("Telegram down")));
    expect(queue.items()).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a retry never overlaps a request in progress: work runs one at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const item = queued({});
    const { pipeline, notify } = setup(
      {
        download: vi.fn(async () => {
          order.push("download:start");
          await gate;
          order.push("download:end");
          return RESULT;
        }),
        upload: vi.fn(async (path: string) => {
          order.push(`upload ${path}`);
        }),
      },
      { initial: [item], now: () => 1 * MIN },
    );
    const request = pipeline.handle(LINK, async () => {});
    await vi.waitFor(() => expect(order).toContain("download:start"));
    const retry = pipeline.processDue([item], notify);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["download:start"]);
    release();
    await Promise.all([request, retry]);
    expect(order).toEqual([
      "download:start",
      "download:end",
      `upload ${RESULT.filePath}`,
      `upload ${item.epubPath}`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The whole bot, fed with fake updates. No network: every Telegram API call is intercepted.
// ---------------------------------------------------------------------------------------------

const OWNER = 42;
const botConfig: ResolvedConfig = {
  telegramToken: "123:fake",
  ownerId: OWNER,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  sshKeyPath: "/keys/kindle",
  downloadTimeoutMs: 600_000,
  uploadTimeoutMs: 120_000,
  sshConnectTimeoutSec: 10,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/",
  queuePath: "/q/queue.json",
  followsPath: "/q/follows.json",
  spoolDir: SPOOL,
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

const botInfo = {
  id: 1,
  is_bot: true as const,
  first_name: "Bookcarrier",
  username: "bookcarrier_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function textUpdate(updateId: number, fromId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
    },
  };
}

/** Result of every fake API call; `never` is justified: the real type depends on the method and is never read. */
const ok = () => ({ ok: true as const, result: true as never });

describe("rate-limit deferral (S1–S6)", () => {
  const downloadItem = (overrides: Partial<QueueItem>): QueueItem => {
    const item = queued({ stage: "download", lastError: TRANSIENT_DOWNLOAD.message, ...overrides });
    delete item.title;
    delete item.epubPath;
    return item;
  };

  it("a 429 at the end of the window → kept as deferred, spool kept, owner told ONCE it will be retried in 2 h (S1, S3, S5)", async () => {
    const item = downloadItem({ attempts: 4, nextAttemptAt: 30 * MIN });
    const { pipeline, notify, notices, queue, deps } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [item], now: () => 30 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(queue.items()).toEqual([
      expect.objectContaining({ id: "q-1", deferred: true, nextAttemptAt: 30 * MIN + 2 * HOUR }),
    ]);
    expect(deps.spool.discard).not.toHaveBeenCalled();
    expect(notices).toEqual([messages.deferred(LINK, 2 * HOUR, 24)]);
  });

  it("a failed deferred retry → silent, rescheduled 2 h later (S4, S5)", async () => {
    const item = downloadItem({ attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    const { pipeline, notify, notices, queue } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [item], now: () => 150 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([]);
    expect(queue.items()).toEqual([
      expect.objectContaining({ deferred: true, attempts: 6, nextAttemptAt: 150 * MIN + 2 * HOUR }),
    ]);
  });

  it("a deferred item past the 24 h limit → abandoned, spool cleaned, owner told the last error (S4)", async () => {
    const item = downloadItem({ attempts: 15, nextAttemptAt: 22 * HOUR + 30 * MIN, deferred: true });
    const { pipeline, notify, notices, queue, deps } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [item], now: () => 22 * HOUR + 30 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(queue.items()).toEqual([]);
    expect(deps.spool.discard).toHaveBeenCalledWith("q-1");
    expect(notices).toEqual([messages.gaveUpDeferred(LINK, TRANSIENT_DOWNLOAD.message, 24)]);
  });

  it("a deferred item that downloads → delivered and the owner gets the title (S5)", async () => {
    const item = downloadItem({ attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    const { pipeline, notify, notices, queue } = setup({}, { initial: [item], now: () => 150 * MIN });
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([messages.delivered("Title")]);
    expect(queue.items()).toEqual([]);
  });

  it("a non-429 failure at the end of the window still gives up as before (S2)", async () => {
    const item = downloadItem({ attempts: 4, nextAttemptAt: 30 * MIN });
    const { pipeline, notify, notices, queue } = setup(
      { download: vi.fn().mockRejectedValue(TIMEOUT_DOWNLOAD) },
      { initial: [item], now: () => 30 * MIN },
    );
    await pipeline.processDue([item], notify);
    expect(queue.items()).toEqual([]);
    expect(notices).toEqual([messages.gaveUp(LINK, TIMEOUT_DOWNLOAD.message, 30)]);
  });

  it("a new link during the cooldown → NOT downloaded, enqueued as deferred with the cooldown, owner told when (S6)", async () => {
    const waiting = downloadItem({ attempts: 5, nextAttemptAt: 2 * HOUR, deferred: true });
    const { handle, replies, queue, deps, writes } = setup({}, { initial: [waiting], now: () => 30 * MIN });
    await handle(LINK);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.spool.prepare).not.toHaveBeenCalled();
    expect(replies).toEqual([messages.deferredNew(90 * MIN, 24)]);
    expect(queue.items()).toEqual([
      waiting,
      {
        id: "req-1",
        url: LINK,
        stage: "download",
        attempts: 0,
        firstQueuedAt: 30 * MIN,
        nextAttemptAt: 2 * HOUR,
        lastError: messages.rateLimitedReason,
        deferred: true,
      },
    ]);
    expect(writes.at(-1)?.items).toHaveLength(2);
  });

  it("if deferring during the cooldown cannot be persisted, the link is tried at once as usual", async () => {
    const { handle, replies, logger, deps } = setup({
      queue: {
        enqueue: vi.fn().mockRejectedValue(new Error("ENOSPC")),
        promoteToUpload: vi.fn(),
        recordFailure: vi.fn(),
        remove: vi.fn(),
        cooldownUntil: vi.fn(() => 2 * HOUR),
      },
    });
    await handle(LINK);
    expect(logger.error).toHaveBeenCalledWith("could not defer during the cooldown; trying now", expect.anything());
    expect(deps.download).toHaveBeenCalledOnce();
    expect(replies).toEqual([messages.ack, messages.delivered("Title")]);
  });

  it("a batch of due deferred items stops hitting AO3 once one gets another 429: the rest wait 2 h, silently", async () => {
    const first = downloadItem({ id: "q-1", attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    const second = downloadItem({ id: "q-2", attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    const { pipeline, notify, notices, queue, deps } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [first, second], now: () => 150 * MIN },
    );
    await pipeline.processDue([first, second], notify);
    expect(deps.download).toHaveBeenCalledOnce();
    expect(notices).toEqual([]);
    expect(queue.items()).toEqual([
      expect.objectContaining({ id: "q-1", deferred: true, attempts: 6, nextAttemptAt: 150 * MIN + 2 * HOUR }),
      expect.objectContaining({
        id: "q-2",
        deferred: true,
        attempts: 6,
        nextAttemptAt: 150 * MIN + 2 * HOUR,
        lastError: TRANSIENT_DOWNLOAD.message,
      }),
    ]);
  });

  it("a link deferred while a deferred retry is in flight is not downloaded if that retry gets another 429", async () => {
    let now = 150 * MIN;
    const inFlight = downloadItem({ attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    let release: () => void = () => {};
    const download = vi.fn(
      () =>
        new Promise<DownloadResult>((_, reject) => {
          release = () => reject(TRANSIENT_DOWNLOAD);
        }),
    );
    const { pipeline, handle, notify, queue } = setup({ download }, { initial: [inFlight], now: () => now });
    const batch = pipeline.processDue([inFlight], notify);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await handle(LINK); // AO3 cooling down: deferred to the in-flight item's (past) time
    release();
    await batch;
    now = 151 * MIN;
    const newLink = queue.items().find((i) => i.id === "req-1")!;
    await pipeline.processDue([newLink], notify);
    expect(download).toHaveBeenCalledOnce();
    expect(queue.items().find((i) => i.id === "req-1")).toMatchObject({
      deferred: true,
      nextAttemptAt: 151 * MIN + 2 * HOUR,
    });
  });

  it("after a 429, a deferred item that becomes due LATER is tried again (the 429 is older than its turn)", async () => {
    let now = 150 * MIN;
    const first = downloadItem({ id: "q-1", attempts: 5, nextAttemptAt: 150 * MIN, deferred: true });
    const later = downloadItem({ id: "q-2", attempts: 5, nextAttemptAt: 200 * MIN, deferred: true });
    const { pipeline, notify, deps } = setup(
      { download: vi.fn().mockRejectedValue(TRANSIENT_DOWNLOAD) },
      { initial: [first, later], now: () => now },
    );
    await pipeline.processDue([first], notify);
    now = 200 * MIN;
    await pipeline.processDue([later], notify);
    expect(deps.download).toHaveBeenCalledTimes(2);
  });

  it("without deferred items, a new link is downloaded as usual even if others are queued", async () => {
    const waiting = downloadItem({ attempts: 1, nextAttemptAt: 3 * MIN });
    const { handle, replies, deps } = setup({}, { initial: [waiting], now: () => 2 * MIN });
    await handle(LINK);
    expect(deps.download).toHaveBeenCalledOnce();
    expect(replies).toEqual([messages.ack, messages.delivered("Title")]);
  });
});

describe("deferral messages (S5, S6)", () => {
  it("say FanFicFare is having trouble, when it will be retried and for how long", () => {
    expect(messages.deferred("Title", 2 * HOUR, 24)).toBe(
      "FanFicFare is having trouble with AO3 right now (it keeps getting “429 Too Many Requests”), " +
        "so I saved “Title” and will try again in about 2 hours. " +
        "I'll keep trying for up to 24 hours from your first request and tell you how it goes.",
    );
    expect(messages.deferredNew(90 * MIN, 24)).toBe(
      "FanFicFare is having trouble with AO3 right now (it keeps getting “429 Too Many Requests”), " +
        "so I saved your request without downloading it and will try again in about 90 minutes. " +
        "I'll keep trying for up to 24 hours and tell you how it goes.",
    );
    expect(messages.gaveUpDeferred("Title", "HTTP Error 429", 24)).toBe(
      "I gave up on “Title”: AO3 kept rate-limiting FanFicFare for 24 hours. Last error: HTTP Error 429. " +
        "Share the link again to try once more.",
    );
  });

  it("round the wait: minutes up to 90, hours past that, never 0", () => {
    expect(messages.deferredNew(30_000, 24)).toContain("in about 1 minute.");
    expect(messages.deferredNew(45 * MIN, 24)).toContain("in about 45 minutes.");
    expect(messages.deferredNew(119 * MIN, 24)).toContain("in about 2 hours.");
    expect(messages.deferredNew(5 * HOUR, 24)).toContain("in about 5 hours.");
  });
});

describe("createBot — wiring", () => {
  function botWith(overrides: Partial<PipelineDeps>) {
    const ctx = setup(overrides);
    const bot = createBot(botConfig, ctx.pipeline, { botInfo });
    const sent: { chatId: unknown; text: string }[] = [];
    bot.api.config.use((_prev, method, payload) => {
      if (method === "sendMessage" && "text" in payload)
        sent.push({ chatId: "chat_id" in payload ? payload.chat_id : undefined, text: String(payload.text) });
      return Promise.resolve(ok());
    });
    return { bot, sent, ...ctx };
  }

  it("a message from someone else gets no reply and runs nothing", async () => {
    const { bot, sent, deps } = botWith({});
    await bot.handleUpdate(textUpdate(1, 99, LINK));
    expect(sent).toEqual([]);
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("a link from the owner is acknowledged and delivered", async () => {
    const { bot, sent } = botWith({});
    await bot.handleUpdate(textUpdate(1, OWNER, LINK));
    expect(sent.map((s) => s.text)).toEqual([messages.ack, messages.delivered("Title")]);
  });

  it("an unreachable Kindle is reported as enqueued (acceptance 1)", async () => {
    const { bot, sent, queue } = botWith({ upload: vi.fn().mockRejectedValue(UNREACHABLE) });
    await bot.handleUpdate(textUpdate(1, OWNER, LINK));
    expect(sent.at(-1)?.text).toBe(messages.queuedUpload("Title", UNREACHABLE.message, 30));
    expect(queue.items()).toHaveLength(1);
  });

  it("notifyOwner sends to the owner's chat (used by retries and startup notices)", async () => {
    const { bot, sent } = botWith({});
    const { notifyOwner } = await import("../telegram/index.js");
    await notifyOwner(bot, OWNER)("hello");
    expect(sent).toEqual([{ chatId: OWNER, text: "hello" }]);
  });
});

describe("createBot — sequential processing (grammY long polling)", () => {
  it("a second message waits until the first one has finished", async () => {
    const events: string[] = [];
    let releaseFirst: (result: DownloadResult) => void = () => {};
    const firstGate = new Promise<DownloadResult>((resolve) => {
      releaseFirst = resolve;
    });
    const download = vi.fn(async (url: string) => {
      const id = url.split("/").at(-1);
      events.push(`download:start ${id}`);
      const result = id === "111" ? await firstGate : RESULT;
      events.push(`download:end ${id}`);
      return result;
    });
    const upload = vi.fn(async (path: string) => {
      events.push(`upload ${path === RESULT.filePath ? "done" : "first"}`);
    });

    const { pipeline } = setup({ download, upload });
    const bot = createBot(botConfig, pipeline, { botInfo });

    // Both messages arrive in the SAME getUpdates batch, exactly as when you share two links quickly.
    let delivered = false;
    bot.api.config.use(async (_prev, method) => {
      if (method === "getUpdates") {
        if (!delivered) {
          delivered = true;
          return {
            ok: true as const,
            result: [
              textUpdate(1, OWNER, "https://archiveofourown.org/works/111"),
              textUpdate(2, OWNER, "https://archiveofourown.org/works/222"),
            ] as never,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true as const, result: [] as never };
      }
      return ok();
    });

    const polling = bot.start();
    await vi.waitFor(() => expect(events).toContain("download:start 111"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["download:start 111"]);

    releaseFirst({ filePath: "/spool/req-1/111-First.epub", title: "First" });
    await vi.waitFor(() => expect(events).toContain("upload done"));
    await bot.stop();
    await polling;

    expect(events).toEqual([
      "download:start 111",
      "download:end 111",
      "upload first",
      "download:start 222",
      "download:end 222",
      "upload done",
    ]);
  });
});

describe("delivery action per follow outcome (feature 5; acceptance 1, 3, 5, 6, 7, 12, 13)", () => {
  const FMETA: FicMeta = {
    workId: "65164981",
    url: LINK,
    title: "Title",
    author: "Someone",
    chapters: 12,
    status: "in-progress",
  };
  type Sent = { text: string; action: unknown };

  function followSetup(
    opts: { outcome?: DeliveryOutcome | Error; meta?: FicMeta; initial?: QueueItem[]; upload?: PipelineDeps["upload"] } = {},
  ) {
    const onDelivered = vi.fn(async (_meta: FicMeta | undefined): Promise<DeliveryOutcome> => {
      if (opts.outcome instanceof Error) throw opts.outcome;
      return opts.outcome ?? { kind: "none" };
    });
    const download = vi.fn(async () => ({ ...RESULT, ...(opts.meta !== undefined && { meta: opts.meta }) }));
    const ctx = setup(
      {
        follows: { onDelivered },
        download: download as unknown as PipelineDeps["download"],
        ...(opts.upload !== undefined && { upload: opts.upload }),
      },
      { initial: opts.initial ?? [] },
    );
    const replies: Sent[] = [];
    const notices: Sent[] = [];
    const reply = async (text: string, action?: unknown) => void replies.push({ text, action });
    const notify = async (text: string, action?: unknown) => void notices.push({ text, action });
    return { ...ctx, onDelivered, download, replies, notices, reply, notify };
  }

  const retryItem = (overrides: Partial<QueueItem> = {}) => queued({ meta: FMETA, ...overrides });

  it("offer → delivered + action follow (criterion 1); onDelivered gets the download's meta", async () => {
    const { pipeline, reply, replies, onDelivered } = followSetup({ outcome: { kind: "offer" }, meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(FMETA);
    expect(replies).toEqual([
      { text: messages.ack, action: undefined },
      { text: messages.delivered("Title"), action: { action: "follow", workId: "65164981" } },
    ]);
  });

  it("none → delivered with no action (criterion 3)", async () => {
    const { pipeline, reply, replies } = followSetup({ outcome: { kind: "none" }, meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(replies.at(-1)).toEqual({ text: messages.delivered("Title"), action: undefined });
  });

  it("no meta → onDelivered(undefined), no action (criterion 6)", async () => {
    const { pipeline, reply, replies, onDelivered } = followSetup();
    await pipeline.handle(LINK, reply);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(replies.at(-1)).toEqual({ text: messages.delivered("Title"), action: undefined });
  });

  it("updated → deliveredFollowUpdated + action unfollow (criterion 5)", async () => {
    const { pipeline, reply, replies } = followSetup({ outcome: { kind: "updated", chapters: 14 }, meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(replies.at(-1)).toEqual({
      text: messages.deliveredFollowUpdated("Title", 14),
      action: { action: "unfollow", workId: "65164981" },
    });
  });

  it("completed → deliveredCompletedUnfollowed, no action (criterion 13)", async () => {
    const { pipeline, reply, replies } = followSetup({ outcome: { kind: "completed" }, meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(replies.at(-1)).toEqual({ text: messages.deliveredCompletedUnfollowed("Title"), action: undefined });
  });

  it("onDelivered rejecting → plain delivered message without action, error logged", async () => {
    const boom = new Error("disk full");
    const { pipeline, reply, replies, logger } = followSetup({ outcome: boom, meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(replies.at(-1)).toEqual({ text: messages.delivered("Title"), action: undefined });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: boom }));
  });

  it("a failed upload never calls onDelivered", async () => {
    const { pipeline, reply, onDelivered } = followSetup({ upload: vi.fn().mockRejectedValue(UNREACHABLE), meta: FMETA });
    await pipeline.handle(LINK, reply);
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("downloads exactly once per delivery, whatever the outcome (criterion 12)", async () => {
    for (const outcome of [{ kind: "offer" }, { kind: "updated", chapters: 14 }] as const) {
      const { pipeline, reply, download } = followSetup({ outcome, meta: FMETA });
      await pipeline.handle(LINK, reply);
      expect(download).toHaveBeenCalledTimes(1);
    }
  });

  it("retry: an upload-stage item with meta → onDelivered(meta), delivered + action follow (criterion 7)", async () => {
    const item = retryItem();
    const { pipeline, notify, notices, onDelivered } = followSetup({ outcome: { kind: "offer" }, initial: [item] });
    await pipeline.processDue([item], notify);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(FMETA);
    expect(notices).toEqual([{ text: messages.delivered("Title"), action: { action: "follow", workId: "65164981" } }]);
  });

  it("retry: a download-stage item uses the meta of the retry's download, which runs once", async () => {
    const { epubPath: _e, title: _t, ...rest } = retryItem();
    const item: QueueItem = { ...rest, stage: "download" };
    const { pipeline, notify, notices, onDelivered, download } = followSetup({
      outcome: { kind: "offer" },
      meta: FMETA,
      initial: [item],
    });
    await pipeline.processDue([item], notify);
    expect(download).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(FMETA);
    expect(notices.at(-1)?.action).toEqual({ action: "follow", workId: "65164981" });
  });

  it("retry: a deferred item whose download succeeds on a retry delivers with its meta and offers Follow (#7, R2.5)", async () => {
    const { epubPath: _e, title: _t, ...rest } = retryItem();
    const item: QueueItem = { ...rest, stage: "download", deferred: true, attempts: 6, nextAttemptAt: 2 * HOUR };
    const { pipeline, notify, notices, onDelivered, download, queue } = followSetup({
      outcome: { kind: "offer" },
      meta: FMETA,
      initial: [item],
    });
    await pipeline.processDue([item], notify);
    expect(download).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(FMETA);
    expect(notices).toEqual([{ text: messages.delivered("Title"), action: { action: "follow", workId: "65164981" } }]);
    expect(queue.items()).toEqual([]);
  });

  it("retry: an item without meta (pre-feature queue) → onDelivered(undefined), no action", async () => {
    const item = queued({});
    const { pipeline, notify, notices, onDelivered } = followSetup({ initial: [item] });
    await pipeline.processDue([item], notify);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(notices).toEqual([{ text: messages.delivered("Title"), action: undefined }]);
  });

  it("retry: updated and completed outcomes pick their message too", async () => {
    const item = retryItem();
    const a = followSetup({ outcome: { kind: "updated", chapters: 14 }, initial: [item] });
    await a.pipeline.processDue([item], a.notify);
    expect(a.notices).toEqual([
      { text: messages.deliveredFollowUpdated("Title", 14), action: { action: "unfollow", workId: "65164981" } },
    ]);
    const b = followSetup({ outcome: { kind: "completed" }, initial: [item] });
    await b.pipeline.processDue([item], b.notify);
    expect(b.notices).toEqual([{ text: messages.deliveredCompletedUnfollowed("Title"), action: undefined }]);
  });

  it("retry: onDelivered rejecting → plain delivered notice, error logged", async () => {
    const boom = new Error("disk full");
    const item = retryItem();
    const { pipeline, notify, notices, logger } = followSetup({ outcome: boom, initial: [item] });
    await pipeline.processDue([item], notify);
    expect(notices).toEqual([{ text: messages.delivered("Title"), action: undefined }]);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: boom }));
  });

  it("retry: a failed upload never calls onDelivered", async () => {
    const item = retryItem();
    const { pipeline, notify, onDelivered } = followSetup({ upload: vi.fn().mockRejectedValue(UNREACHABLE), initial: [item] });
    await pipeline.processDue([item], notify);
    expect(onDelivered).not.toHaveBeenCalled();
  });
});
