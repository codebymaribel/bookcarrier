import { describe, expect, it, vi } from "vitest";
import type { ChatIO, DocumentConfig, DocumentDeps } from "../src/document-flow.js";
import { createDocumentFlow } from "../src/document-flow.js";
import { formatLine, type Logger } from "../src/logger.js";
import { messages } from "../src/messages.js";
import { createPendingStore } from "../src/pending.js";
import { TelegramDownloadError, TelegramFileTooBigError } from "../src/telegram-file.js";
import { UploadConfigError, UploadFailedError } from "../src/uploader.js";

const TOKEN = "123456:SECRET-token_value";
const BOOKS = "/mnt/us/documents/books/";
const PDFS = "/mnt/us/documents/pdfs/";
const TMP = "/tmp/doc-1";
const MIN = 60_000;

const config: DocumentConfig = {
  telegramToken: TOKEN,
  documentFolders: new Map([
    ["epub", BOOKS],
    ["mobi", BOOKS],
    ["pdf", PDFS],
  ]),
  downloadTimeoutMs: 123_000,
  uploadTimeoutMs: 45_000,
  sshConnectTimeoutSec: 7,
  kindlePort: 2222,
  sshKeyPath: "/keys/kindle",
  kindleUser: "root",
  kindleHost: "192.168.1.50",
};

const TARGET = {
  sshKeyPath: "/keys/kindle",
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  port: 2222,
  connectTimeoutSec: 7,
  timeoutMs: 45_000,
};

const UNREACHABLE = new UploadFailedError("exit-code", "ssh exited with code 255: Host is down");
const BROKEN_KEY = new UploadConfigError("key-missing", "SSH key not found: /keys/kindle");

const doc = (file_name: string | undefined, extra: { file_size?: number; file_id?: string } = {}) => ({
  file_id: extra.file_id ?? "FILE-1",
  file_unique_id: "U1",
  ...(file_name !== undefined && { file_name }),
  ...(extra.file_size !== undefined && { file_size: extra.file_size }),
});

/** Every fake pushes into one shared `events` list, so tests assert the exact order (bot.flow.test.ts style). */
function setup(overrides: Partial<DocumentDeps> = {}, opts: { existing?: string[]; now?: () => number } = {}) {
  const events: string[] = [];
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const existing = new Set(opts.existing ?? []);
  let ids = 0;
  let dirs = 0;
  const deps: DocumentDeps = {
    exists: vi.fn(async (path: string) => {
      events.push(`exists ${path}`);
      return existing.has(path);
    }),
    download: vi.fn(async (fileId: string, dest: string) => {
      events.push(`download ${fileId} -> ${dest}`);
    }),
    upload: vi.fn(async (path: string, o: { remotePath: string }) => {
      events.push(`upload ${path} -> ${o.remotePath}`);
    }),
    pending: createPendingStore({ ttlMs: 10 * MIN, now: opts.now ?? (() => 0), newId: () => `id${++ids}` }),
    makeTempDir: vi.fn(async () => {
      const dir = dirs++ === 0 ? TMP : `${TMP}-${dirs}`;
      events.push(`mkdtemp ${dir}`);
      return dir;
    }),
    removeDir: vi.fn(async (dir: string) => {
      events.push(`rmdir ${dir}`);
    }),
    logger,
    ...overrides,
  };
  const flow = createDocumentFlow(config, deps);
  const io: ChatIO = {
    reply: async (text) => {
      events.push(`reply ${text}`);
    },
    askOverwrite: async (text, id) => {
      events.push(`ask ${id} ${text}`);
    },
  };
  return { flow, deps, io, events, logger };
}

describe("document flow — not on the Kindle (acceptance 1)", () => {
  it("acks, checks, downloads into the temp dir under the safe name, uploads to the format's folder, confirms, cleans", async () => {
    const { flow, io, events } = setup();
    await flow.onDocument(doc("Libro.epub"), io);
    expect(events).toEqual([
      `reply ${messages.docAck}`,
      `exists ${BOOKS}Libro.epub`,
      `mkdtemp ${TMP}`,
      `download FILE-1 -> ${TMP}/Libro.epub`,
      `upload ${TMP}/Libro.epub -> ${BOOKS}`,
      `reply ${messages.docDelivered("Libro.epub")}`,
      `rmdir ${TMP}`,
    ]);
  });

  it("checks and uploads with the SSH target built from the config", async () => {
    const { flow, io, deps } = setup();
    await flow.onDocument(doc("Report.PDF"), io);
    expect(deps.exists).toHaveBeenCalledWith(`${PDFS}Report.PDF`, TARGET);
    expect(deps.upload).toHaveBeenCalledWith(`${TMP}/Report.PDF`, { ...TARGET, remotePath: PDFS });
  });

  it("uses the sanitized name everywhere (acceptance 5)", async () => {
    const { flow, io, events } = setup();
    await flow.onDocument(doc("../Dune: Messiah.epub"), io);
    expect(events).toContain(`exists ${BOOKS}Dune_ Messiah.epub`);
    expect(events).toContain(`download FILE-1 -> ${TMP}/Dune_ Messiah.epub`);
    expect(events).toContain(`reply ${messages.docDelivered("Dune_ Messiah.epub")}`);
  });
});

describe("document flow — rejected before anything runs (R2.3, R2.5)", () => {
  it.each([["book.azw3"], ["photo.jpg"], ["x.mp4"], [undefined], [".pdf"]])(
    "%s → unsupported format naming the configured formats, nothing else",
    async (name) => {
      const { flow, io, events } = setup();
      await flow.onDocument(doc(name), io);
      expect(events).toEqual([`reply ${messages.unsupportedFormat(["epub", "mobi", "pdf"])}`]);
    },
  );

  it("too big → only the too-big reply with the size, no check, no download", async () => {
    const { flow, io, events } = setup();
    const size = 25 * 1024 * 1024;
    await flow.onDocument(doc("big.pdf", { file_size: size }), io);
    expect(events).toEqual([`reply ${messages.tooBig(size)}`]);
  });
});

describe("document flow — already on the Kindle (R5)", () => {
  it("asks with the name, does NOT download, and onDocument resolves (R5.1, R5.2, R5.4)", async () => {
    const { flow, io, events } = setup({}, { existing: [`${BOOKS}Libro.epub`] });
    await flow.onDocument(doc("Libro.epub"), io);
    expect(events).toEqual([
      `reply ${messages.docAck}`,
      `exists ${BOOKS}Libro.epub`,
      `ask id1 ${messages.alreadyExists("Libro.epub")}`,
    ]);
  });

  it("replace → download + upload to the same folder + delivered (R5.5)", async () => {
    const { flow, io, events } = setup({}, { existing: [`${PDFS}a.pdf`] });
    await flow.onDocument(doc("a.pdf"), io);
    events.length = 0;
    await flow.onDecision("id1", "replace", io);
    expect(events).toEqual([
      `mkdtemp ${TMP}`,
      `download FILE-1 -> ${TMP}/a.pdf`,
      `upload ${TMP}/a.pdf -> ${PDFS}`,
      `reply ${messages.docDelivered("a.pdf")}`,
      `rmdir ${TMP}`,
    ]);
  });

  it("cancel → overwriteCancelled, nothing downloaded (R5.6)", async () => {
    const { flow, io, events } = setup({}, { existing: [`${PDFS}a.pdf`] });
    await flow.onDocument(doc("a.pdf"), io);
    events.length = 0;
    await flow.onDecision("id1", "cancel", io);
    expect(events).toEqual([`reply ${messages.overwriteCancelled("a.pdf")}`]);
  });

  it("an answered id is no longer pending: a second tap gets confirmationExpired (R5.7, R5.9)", async () => {
    const { flow, io, events } = setup({}, { existing: [`${PDFS}a.pdf`] });
    await flow.onDocument(doc("a.pdf"), io);
    await flow.onDecision("id1", "replace", io);
    events.length = 0;
    await flow.onDecision("id1", "replace", io);
    expect(events).toEqual([`reply ${messages.confirmationExpired}`]);
  });

  it("an unknown id → confirmationExpired, nothing else (R5.9)", async () => {
    const { flow, io, events } = setup();
    await flow.onDecision("nope0000", "replace", io);
    expect(events).toEqual([`reply ${messages.confirmationExpired}`]);
  });

  it("an id older than 10 minutes → confirmationExpired, nothing downloaded (R5.8, R5.9)", async () => {
    let now = 0;
    const { flow, io, events } = setup({}, { existing: [`${PDFS}a.pdf`], now: () => now });
    await flow.onDocument(doc("a.pdf"), io);
    now = 10 * MIN + 1;
    events.length = 0;
    await flow.onDecision("id1", "replace", io);
    expect(events).toEqual([`reply ${messages.confirmationExpired}`]);
  });

  it("two pending documents: each decision acts on its own document (R5.11)", async () => {
    const { flow, io, events } = setup({}, { existing: [`${PDFS}a.pdf`, `${BOOKS}b.epub`] });
    await flow.onDocument(doc("a.pdf", { file_id: "FA" }), io);
    await flow.onDocument(doc("b.epub", { file_id: "FB" }), io);
    events.length = 0;
    await flow.onDecision("id2", "replace", io);
    await flow.onDecision("id1", "cancel", io);
    expect(events).toEqual([
      `mkdtemp ${TMP}`,
      `download FB -> ${TMP}/b.epub`,
      `upload ${TMP}/b.epub -> ${BOOKS}`,
      `reply ${messages.docDelivered("b.epub")}`,
      `rmdir ${TMP}`,
      `reply ${messages.overwriteCancelled("a.pdf")}`,
    ]);
  });
});

describe("document flow — failures (R4.7, R6.3, R7.3–R7.5)", () => {
  it("check fails (Kindle unreachable) → docSendFailed, nothing downloaded, no temp dir (acceptance 13)", async () => {
    const exists = vi.fn().mockRejectedValue(UNREACHABLE);
    const { flow, io, events } = setup({ exists });
    await flow.onDocument(doc("Libro.epub"), io);
    expect(events).toEqual([
      `reply ${messages.docAck}`,
      `reply ${messages.docSendFailed("Libro.epub", UNREACHABLE.message)}`,
    ]);
  });

  it("check fails with a config error → uploadConfig (acceptance 14)", async () => {
    const exists = vi.fn().mockRejectedValue(BROKEN_KEY);
    const { flow, io, events } = setup({ exists });
    await flow.onDocument(doc("Libro.epub"), io);
    expect(events).toEqual([`reply ${messages.docAck}`, `reply ${messages.uploadConfig(BROKEN_KEY.message)}`]);
  });

  it("download fails → docDownloadFailed, no upload, temp dir removed", async () => {
    const err = new TelegramDownloadError("http", "HTTP 404 downloading documents/file_0.pdf");
    const download = vi.fn(async (fileId: string, dest: string) => {
      void fileId;
      void dest;
      throw err;
    });
    const { flow, io, events, deps } = setup({ download });
    await flow.onDocument(doc("a.pdf"), io);
    expect(deps.upload).not.toHaveBeenCalled();
    expect(events.slice(-2)).toEqual([`reply ${messages.docDownloadFailed(err.message)}`, `rmdir ${TMP}`]);
  });

  it("getFile says too big → tooBig without a size (R6.4)", async () => {
    const download = vi.fn().mockRejectedValue(new TelegramFileTooBigError());
    const { flow, io, events } = setup({ download });
    await flow.onDocument(doc("a.pdf"), io);
    expect(events.slice(-2)).toEqual([`reply ${messages.tooBig()}`, `rmdir ${TMP}`]);
  });

  it("upload fails → docSendFailed, temp dir removed, nothing else (R7.3, R7.5)", async () => {
    const upload = vi.fn().mockRejectedValue(new UploadFailedError("exit-code", "scp exited with code 1"));
    const { flow, io, events } = setup({ upload });
    await flow.onDocument(doc("a.pdf"), io);
    expect(events.slice(-2)).toEqual([
      `reply ${messages.docSendFailed("a.pdf", "scp exited with code 1")}`,
      `rmdir ${TMP}`,
    ]);
  });

  it("an unexpected error in the delivery → unexpected, temp dir removed", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("boom"));
    const { flow, io, events, logger } = setup({ upload });
    await flow.onDocument(doc("a.pdf"), io);
    expect(events.slice(-2)).toEqual([`reply ${messages.unexpected}`, `rmdir ${TMP}`]);
    expect(logger.error).toHaveBeenCalled();
  });

  it("a reply that throws does not stop the delivery; it is logged", async () => {
    const { flow, deps, logger } = setup();
    const io: ChatIO = {
      reply: vi.fn().mockRejectedValue(new Error("Telegram down")),
      askOverwrite: vi.fn(),
    };
    await flow.onDocument(doc("a.pdf"), io);
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.removeDir).toHaveBeenCalledWith(TMP);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("neither function ever rejects, even when every fake throws", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const { flow } = setup({
      exists: vi.fn(boom),
      makeTempDir: vi.fn(boom),
      removeDir: vi.fn(boom),
    });
    const throwing: ChatIO = { reply: vi.fn(boom), askOverwrite: vi.fn(boom) };
    await expect(flow.onDocument(doc("a.pdf"), throwing)).resolves.toBeUndefined();
    await expect(flow.onDecision("x", "replace", throwing)).resolves.toBeUndefined();

    const existing = setup({ makeTempDir: vi.fn(boom) }, { existing: [`${PDFS}a.pdf`] });
    // askOverwrite throws here: onDocument still resolves, and the pending entry is still usable.
    await expect(existing.flow.onDocument(doc("a.pdf"), throwing)).resolves.toBeUndefined();
    await expect(existing.flow.onDecision("id1", "replace", throwing)).resolves.toBeUndefined();
  });

  it("removeDir failing is logged, not thrown", async () => {
    const removeDir = vi.fn().mockRejectedValue(new Error("EBUSY"));
    const { flow, io, logger } = setup({ removeDir });
    await expect(flow.onDocument(doc("a.pdf"), io)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("document flow — the token never reaches the log (R6.5, acceptance 15)", () => {
  it("every logger call, formatted as a real log line, is free of the token across all outcomes", async () => {
    const lines: string[] = [];
    const record =
      (level: "info" | "warn" | "error") =>
      (message: string, meta?: Record<string, unknown>) => {
        lines.push(formatLine(new Date(0), level, message, meta));
      };
    const logger: Logger = { info: record("info"), warn: record("warn"), error: record("error") };
    const failures = [
      new TelegramDownloadError("network", "network error downloading documents/file_0.pdf (ECONNRESET)"),
      new TelegramFileTooBigError(),
      new Error("unexpected"),
    ];
    for (const err of failures) {
      const { flow, io } = setup({ logger, download: vi.fn().mockRejectedValue(err) });
      await flow.onDocument(doc("a.pdf"), io);
    }
    const ok = setup({ logger }, { existing: [`${PDFS}a.pdf`] });
    await ok.flow.onDocument(doc("a.pdf"), ok.io);
    await ok.flow.onDecision("id1", "replace", ok.io);
    await ok.flow.onDocument(doc("photo.jpg"), ok.io);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("api.telegram.org/file/bot");
    }
  });
});
