import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../telegram/index.js";
import { messages, type FicMeta } from "../fanfic/index.js";
import { followsMessages } from "../follows/index.js";
import type { ResolvedConfig } from "../shared/index.js";
import { createDaemon } from "./daemon.js";

const OWNER = 42;
let root: string;
let cfg: ResolvedConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "probe-"));
  cfg = {
    telegramToken: "1:x", ownerId: OWNER, kindleUser: "r", kindleHost: "h", sshKeyPath: "/k", downloadTimeoutMs: 1000,
    uploadTimeoutMs: 1000, sshConnectTimeoutSec: 1, kindlePort: 2222, remotePath: "/m/", queuePath: join(root, "q.json"),
    followsPath: join(root, "f.json"), spoolDir: join(root, "spool"), giveUpAfterMs: 1800000, retryBackoffMinutes: [1],
    deferredRetryMs: 7200000, deferredGiveUpAfterMs: 86400000, documentFolders: new Map([["epub", "/m/"]]),
  } as ResolvedConfig;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const botInfo = { id: 1, is_bot: true as const, first_name: "B", username: "b_bot", can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const link = (id: string) => `https://archiveofourown.org/works/${id}`;
const text = (from: number, t: string): Update => ({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: from, type: "private", first_name: "T" }, from: { id: from, is_bot: false, first_name: "T" }, text: t } });
const tap = (from: number, data: string): Update => ({ update_id: 2, callback_query: { id: "c", from: { id: from, is_bot: false, first_name: "T" }, chat_instance: "ci", data, message: { message_id: 7, date: 0, chat: { id: from, type: "private", first_name: "T" }, text: "D" } } });

async function boot(metaFor: (id: string) => FicMeta | undefined) {
  const download = vi.fn(async (_url: string, _dir: string, opts: { workId?: string }) => ({ filePath: join(root, "x.epub"), title: `T${opts.workId}`, meta: metaFor(opts.workId!) }));
  const upload = vi.fn(async () => {});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = await createDaemon(cfg, { logger, notify: vi.fn(async () => {}), download: download as never, upload });
  const bot = createBot(cfg, daemon.pipeline, { botInfo }, undefined, daemon.follows);
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use((_p, method, payload) => { calls.push({ method, payload }); return Promise.resolve({ ok: true as const, result: true as never }); });
  return { bot, calls, download, upload, daemon, logger };
}
const m = (id: string, chapters: number, status: FicMeta["status"] = "in-progress"): FicMeta => ({ workId: id, url: link(id), title: `T${id}`, author: "A", chapters, status });
const sent = (calls: any[]) => calls.filter((c) => c.method === "sendMessage");
const file = async () => JSON.parse(await readFile(cfg.followsPath, "utf8"));

describe("e2e follow", () => {
  it("1,2,3,4,5,13: full lifecycle with real follows + daemon + bot", async () => {
    let meta: FicMeta | undefined = m("1", 12);
    const { bot, calls, download } = await boot(() => meta);
    await bot.handleUpdate(text(OWNER, link("1")));
    const delivered = sent(calls).at(-1)!;
    expect(delivered.payload.text).toBe(messages.delivered("T1"));
    expect(delivered.payload.reply_markup.inline_keyboard).toEqual([[{ text: "Follow", callback_data: "fo:1" }]]);
    await bot.handleUpdate(tap(OWNER, "fo:1"));
    expect(calls.find((c) => c.method === "editMessageReplyMarkup")!.payload.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Unfollow", callback_data: "uf:1" });
    expect(sent(calls).at(-1)!.payload.text).toContain("12 chapters");
    expect((await file()).followed).toMatchObject([{ workId: "1", chapters: 12, status: "in-progress" }]);
    // 5: resend with 14
    meta = m("1", 14);
    await bot.handleUpdate(text(OWNER, link("1")));
    const upd = sent(calls).at(-1)!;
    expect(upd.payload.text).toBe(messages.deliveredFollowUpdated("T1", 14));
    expect(upd.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("uf:1");
    expect((await file()).followed[0].chapters).toBe(14);
    // 13: completed
    meta = m("1", 15, "completed");
    await bot.handleUpdate(text(OWNER, link("1")));
    const done = sent(calls).at(-1)!;
    expect(done.payload.text).toBe(messages.deliveredCompletedUnfollowed("T1"));
    expect(done.payload.reply_markup).toBeUndefined();
    expect((await file()).followed).toEqual([]);
    // 12: one download per delivery
    expect(download).toHaveBeenCalledTimes(3);
    // 3: complete never followed
    meta = m("2", 5, "completed");
    await bot.handleUpdate(text(OWNER, link("2")));
    expect(sent(calls).at(-1)!.payload.reply_markup).toBeUndefined();
  });
  it("4: unfollow tap removes", async () => {
    const { bot, calls } = await boot((id) => m(id, 3));
    await bot.handleUpdate(text(OWNER, link("1")));
    await bot.handleUpdate(tap(OWNER, "fo:1"));
    calls.length = 0;
    await bot.handleUpdate(tap(OWNER, "uf:1"));
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(calls[1]!.payload.reply_markup).toBeUndefined();
    expect(calls[2]!.payload.text).toBe(followsMessages.unfollowed("T1"));
    expect((await file()).followed).toEqual([]);
    calls.length = 0;
    await bot.handleUpdate(tap(OWNER, "uf:1"));
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[1]!.payload.text).toBe(followsMessages.notFollowing());
  });
  it("14: 10 later deliveries push A out; tap A says send again, stores nothing", async () => {
    const { bot, calls } = await boot((id) => m(id, 3));
    for (let i = 1; i <= 11; i++) await bot.handleUpdate(text(OWNER, link(String(i))));
    const before = await readFile(cfg.followsPath, "utf8");
    calls.length = 0;
    await bot.handleUpdate(tap(OWNER, "fo:1"));
    expect(sent(calls)[0]!.payload.text).toBe(followsMessages.followUnknown());
    expect(await readFile(cfg.followsPath, "utf8")).toBe(before);
    // 10th is still followable
    await bot.handleUpdate(tap(OWNER, "fo:2"));
    expect((await file()).followed.map((f: any) => f.workId)).toEqual(["2"]);
  });
  it("15 + 8: restart then tap follows; followed survive restart", async () => {
    const a = await boot((id) => m(id, 7));
    await a.bot.handleUpdate(text(OWNER, link("5")));
    await a.bot.handleUpdate(text(OWNER, link("6")));
    await a.bot.handleUpdate(tap(OWNER, "fo:6"));
    const b = await boot((id) => m(id, 7));
    await b.bot.handleUpdate(tap(OWNER, "fo:5"));
    expect((await file()).followed.map((f: any) => f.workId).sort()).toEqual(["5", "6"]);
    expect((await b.daemon.follows.follow("6")).kind).toBe("already");
  });
  it("10: non-owner taps change nothing, no replies", async () => {
    const { bot, calls } = await boot((id) => m(id, 7));
    await bot.handleUpdate(text(OWNER, link("5")));
    const before = await readFile(cfg.followsPath, "utf8");
    calls.length = 0;
    await bot.handleUpdate(tap(99, "fo:5"));
    await bot.handleUpdate(tap(99, "uf:5"));
    expect(calls).toEqual([]);
    expect(await readFile(cfg.followsPath, "utf8")).toBe(before);
  });
  it("6: no meta → delivered, no button, follows file untouched", async () => {
    const { bot, calls, upload } = await boot(() => undefined);
    await bot.handleUpdate(text(OWNER, link("5")));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sent(calls).at(-1)!.payload.text).toBe(messages.delivered("T5"));
    expect(sent(calls).at(-1)!.payload.reply_markup).toBeUndefined();
  });
  it("R6.3: re-delivery of followed fic w/o meta leaves follow unchanged", async () => {
    let meta: FicMeta | undefined = m("1", 12);
    const { bot, calls } = await boot(() => meta);
    await bot.handleUpdate(text(OWNER, link("1")));
    await bot.handleUpdate(tap(OWNER, "fo:1"));
    const before = await readFile(cfg.followsPath, "utf8");
    meta = undefined;
    await bot.handleUpdate(text(OWNER, link("1")));
    expect(sent(calls).at(-1)!.payload.reply_markup).toBeUndefined();
    expect(await readFile(cfg.followsPath, "utf8")).toBe(before);
  });
});
