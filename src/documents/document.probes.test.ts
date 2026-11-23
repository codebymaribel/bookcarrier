import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "../telegram/index.js";
import type { ResolvedConfig } from "../shared/index.js";
import { createDocumentFlow, telegramDownloader, type ChatIO } from "./flow.js";
import { createLogger } from "../shared/index.js";
import { messages } from "./messages.js";
import { createPendingStore } from "./pending.js";

const TOKEN = "777777:ZZSECRETTOKENZZ";
const BOOKS = "/mnt/us/documents/books/";
const config: ResolvedConfig = {
  telegramToken: TOKEN, ownerId: 42, kindleUser: "root", kindleHost: "192.0.2.1", sshKeyPath: "/nonexistent/key",
  downloadTimeoutMs: 1000, uploadTimeoutMs: 1000, sshConnectTimeoutSec: 1, kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/AO3/", queuePath: "/q/q.json", spoolDir: "/q/spool",
  giveUpAfterMs: 1800000, retryBackoffMinutes: [1], deferredRetryMs: 7200000, deferredGiveUpAfterMs: 86400000,
  documentFolders: new Map([["epub", BOOKS], ["mobi", BOOKS], ["pdf", BOOKS]]),
};
const botInfo = { id: 1, is_bot: true as const, first_name: "B", username: "b_bot", can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false };
const user = (id: number) => ({ id, is_bot: false, first_name: "T" });
const chat = (id: number) => ({ id, type: "private" as const, first_name: "T" });
let uid = 100;
const docUpd = (from: number, file_name: string, extra: Record<string, unknown> = {}): Update => ({ update_id: uid++,
  message: { message_id: 1, date: 0, chat: chat(from), from: user(from), caption: "x", document: { file_id: "F", file_unique_id: "U", file_name, file_size: 10 }, ...extra } as never });
const tap = (from: number, data: string): Update => ({ update_id: uid++, callback_query: { id: "cq", from: user(from), chat_instance: "c", data,
  message: { message_id: 7, date: 0, chat: chat(from), text: "q" } } as never });

function realBot() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const pipeline = { handle: vi.fn(async () => {}) };
  const bot = createBot(config, pipeline, { botInfo });
  bot.api.config.use((_p, method, payload) => { calls.push({ method, payload: payload as never });
    return Promise.resolve({ ok: true as const, result: true as never }); });
  return { bot, calls, pipeline };
}

describe("probes", () => {
  it("P1 stranger doc / tap (valid ow data) → zero API calls; flow untouched", async () => {
    const { bot, calls, pipeline } = realBot();
    await bot.handleUpdate(docUpd(99, "Libro.epub"));
    await bot.handleUpdate(tap(99, "ow:abcdEFGH:y"));
    await bot.handleUpdate(tap(99, "garbage"));
    expect(calls).toEqual([]); expect(pipeline.handle).not.toHaveBeenCalled();
  });
  it("P2 owner animation (document+animation) → unsupported naming EPUB, MOBI, PDF, plain text", async () => {
    const { bot, calls } = realBot();
    await bot.handleUpdate(docUpd(42, "clip.mp4", { animation: { file_id: "A", file_unique_id: "A", width: 1, height: 1, duration: 1 } }));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload.text).toBe("I can't send that kind of file. Send me one of: EPUB, MOBI, PDF.");
    expect(calls[0]?.payload.parse_mode).toBeUndefined();
  });
  it("P3 owner tap unknown id on real flow → answer, edit, confirmationExpired in order", async () => {
    const { bot, calls } = realBot();
    await bot.handleUpdate(tap(42, "ow:abcdEFGH:y"));
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(calls[2]?.payload.text).toBe(messages.confirmationExpired);
  });
  it("P4 real flow end-to-end, unusable key → uploadConfig, no token on stdout/stderr", async () => {
    const out: string[] = [];
    const so = vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true));
    const { bot, calls } = realBot();
    await bot.handleUpdate(docUpd(42, "Libro.epub"));
    so.mockRestore(); se.mockRestore();
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(String(calls[1]?.payload.text)).toMatch(/^I can't send to the Kindle because of a configuration problem/);
    expect(out.join("")).not.toContain(TOKEN);
  });
  it("P5 real downloader: leaky getFile/fetch errors never reach logs or replies; real temp dir removed", async () => {
    for (const mode of ["getFile", "fetch", "404", "ok"]) {
      const lines: string[] = []; const replies: string[] = [];
      const logger = createLogger({ write: (_l, line) => lines.push(line) });
      const url = `https://api.telegram.org/file/bot${TOKEN}/documents/f.pdf`;
      const getFile = async () => { if (mode === "getFile") throw new Error(`boom ${url}`); return { file_path: "documents/f.pdf" }; };
      const fetchImpl = (async () => {
        if (mode === "fetch") { const e = new TypeError(`fetch failed ${url}`); (e as never as { cause: unknown }).cause = new Error(url); throw e; }
        if (mode === "404") return new Response("no", { status: 404 });
        return new Response("PDFDATA", { status: 200 });
      }) as typeof fetch;
      let dirSeen = "";
      const flow = createDocumentFlow(config, {
        download: telegramDownloader(config, getFile, fetchImpl), logger,
        exists: async () => false,
        upload: async (p) => { dirSeen = p; expect(existsSync(p)).toBe(true); },
        makeTempDir: async () => { const { mkdtemp } = await import("node:fs/promises"); const d = await mkdtemp(`${tmpdir()}/pr-`); dirSeen = d; return d; },
      });
      const io: ChatIO = { reply: async (t) => void replies.push(t), askOverwrite: async () => {} };
      await flow.onDocument({ file_id: "F", file_name: "f.pdf" }, io);
      const all = lines.join("\n") + replies.join("\n");
      expect(all, mode).not.toContain(TOKEN); expect(all, mode).not.toContain("api.telegram.org/file/bot");
      expect(existsSync(dirSeen.replace(/\/f\.pdf$/, "")), mode).toBe(false);
      if (mode === "ok") expect(replies.at(-1)).toBe(messages.docDelivered("f.pdf"));
      else expect(replies.at(-1), mode).toMatch(/^I couldn't get that file from Telegram: /);
    }
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("pr-"))).toEqual([]);
  });
  it("P6 two concurrent Replace taps on the same id → one delivery, one expired; expiry boundary", async () => {
    let t = 0; let ids = 0;
    const pending = createPendingStore({ ttlMs: 600_000, now: () => t, newId: () => `idX${++ids}xxxx`.slice(0, 8) });
    const downloads: string[] = []; const replies: string[] = [];
    const flow = createDocumentFlow(config, { pending, exists: async () => true,
      download: async (f) => void downloads.push(f), upload: async () => {}, makeTempDir: async () => "/x", removeDir: async () => {},
      logger: { info() {}, warn() {}, error() {} } });
    let asked = "";
    const io: ChatIO = { reply: async (m) => void replies.push(m), askOverwrite: async (_m, id) => void (asked = id) };
    await flow.onDocument({ file_id: "F1", file_name: "a.pdf" }, io);
    await Promise.all([flow.onDecision(asked, "replace", io), flow.onDecision(asked, "replace", io)]);
    expect(downloads).toEqual(["F1"]);
    expect(replies.filter((r) => r === messages.confirmationExpired)).toHaveLength(1);
    await flow.onDocument({ file_id: "F2", file_name: "b.pdf" }, io);
    t = 600_001; downloads.length = 0;
    await flow.onDecision(asked, "replace", io);
    expect(downloads).toEqual([]); expect(replies.at(-1)).toBe(messages.confirmationExpired);
  });
});
