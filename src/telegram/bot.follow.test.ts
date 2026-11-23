import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  createBot,
  FOLLOW_DATA,
  followKeyboard,
  notifyOwner,
  unfollowKeyboard,
} from "./bot.js";
import type { DeliveryAction, FicMeta, Pipeline, Send } from "../fanfic/index.js";
import { type DeliveryOutcome, type FollowedFic, type Follows, followsMessages } from "../follows/index.js";
import type { DocumentFlow } from "../documents/index.js";
import { logger as defaultLogger, type ResolvedConfig } from "../shared/index.js";

const MIN = 60_000;
const LINK = "https://archiveofourown.org/works/65164981";
const META: FicMeta = {
  workId: "65164981",
  url: LINK,
  title: "Title",
  author: "Someone",
  chapters: 12,
  status: "in-progress",
};

describe("follow keyboards and callback data (R3.2, R4.3)", () => {
  it("followKeyboard is one \"Follow\" button with fo:<workId>", () => {
    expect(followKeyboard("65164981").inline_keyboard).toEqual([[{ text: "Follow", callback_data: "fo:65164981" }]]);
  });

  it("unfollowKeyboard is one \"Unfollow\" button with uf:<workId>", () => {
    expect(unfollowKeyboard("65164981").inline_keyboard).toEqual([
      [{ text: "Unfollow", callback_data: "uf:65164981" }],
    ]);
  });

  it("callback_data stays within 64 bytes for a 12-digit id and never carries a title", () => {
    const id = "999999999999";
    for (const kb of [followKeyboard(id), unfollowKeyboard(id)]) {
      const button = kb.inline_keyboard[0]?.[0];
      const data = button !== undefined && "callback_data" in button ? button.callback_data : "";
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(data).toMatch(FOLLOW_DATA);
    }
  });

  it("FOLLOW_DATA matches fo:/uf: with 1–12 digits and nothing else", () => {
    expect(FOLLOW_DATA.test("fo:123")).toBe(true);
    expect(FOLLOW_DATA.test("uf:123456789012")).toBe(true);
    expect(FOLLOW_DATA.exec("uf:42")?.slice(1)).toEqual(["uf", "42"]);
    expect(FOLLOW_DATA.test("fo:abc")).toBe(false);
    expect(FOLLOW_DATA.test("fo:")).toBe(false);
    expect(FOLLOW_DATA.test("xx:123")).toBe(false);
    expect(FOLLOW_DATA.test("fo:1234567890123")).toBe(false);
    expect(FOLLOW_DATA.test("fo:12:y")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// T9: Follow and Unfollow taps, wired through a real grammY bot with captured API calls.
// ---------------------------------------------------------------------------------------------

const OWNER = 42;
const STRANGER = 99;
const botConfig: ResolvedConfig = {
  telegramToken: "123:fake",
  ownerId: OWNER,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  sshKeyPath: "/keys/kindle",
  downloadTimeoutMs: 1_000,
  uploadTimeoutMs: 1_000,
  sshConnectTimeoutSec: 1,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/AO3/",
  queuePath: "/q/queue.json",
  followsPath: "/q/follows.json",
  spoolDir: "/q/spool",
  giveUpAfterMs: 30 * MIN,
  retryBackoffMinutes: [1, 2, 4, 8, 15],
  deferredRetryMs: 7_200_000,
  deferredGiveUpAfterMs: 86_400_000,
  documentFolders: new Map([["epub", "/mnt/us/documents/books/"]]),
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

const user = (id: number) => ({ id, is_bot: false, first_name: "T" });
const chat = (id: number) => ({ id, type: "private" as const, first_name: "T" });
const tap = (fromId: number, data: string): Update => ({
  update_id: 3,
  callback_query: {
    id: "cq-1",
    from: user(fromId),
    chat_instance: "ci",
    data,
    message: { message_id: 7, date: 0, chat: chat(fromId), text: "Delivered" },
  },
});

type Call = { method: string; payload: Record<string, unknown> };

const FOLLOWED: FollowedFic = { ...META, followedAt: 1, updatedAt: 1 };

function fakeFollows(overrides: Partial<Follows> = {}) {
  const follows = {
    onDelivered: vi.fn(async () => ({ kind: "none" }) as DeliveryOutcome),
    follow: vi.fn(async () => ({ kind: "followed", fic: FOLLOWED }) as Awaited<ReturnType<Follows["follow"]>>),
    unfollow: vi.fn(
      async () => ({ kind: "unfollowed", title: "Title" }) as Awaited<ReturnType<Follows["unfollow"]>>,
    ),
    ...overrides,
  };
  return follows;
}

function botWith(
  follows: ReturnType<typeof fakeFollows>,
  opts: { failMethods?: string[]; documents?: DocumentFlow; pipeline?: Pick<Pipeline, "handle"> } = {},
) {
  const calls: Call[] = [];
  const documents: DocumentFlow = opts.documents ?? { onDocument: vi.fn(), onDecision: vi.fn() };
  const pipeline = opts.pipeline ?? { handle: vi.fn(async () => {}) };
  const bot = createBot(botConfig, pipeline, { botInfo }, documents, follows);
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (opts.failMethods?.includes(method)) return Promise.reject(new Error(`${method} failed`));
    return Promise.resolve({ ok: true as const, result: true as never });
  });
  const methods = () => calls.map((c) => c.method);
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]));
  const edit = () => calls.find((c) => c.method === "editMessageReplyMarkup");
  return { bot, calls, methods, texts, edit, documents, pipeline };
}

describe("Follow tap (R3.3, R3.4, R3.6; acceptance 2, 14)", () => {
  it("fo:<id> answers the query, follows, swaps the button for Unfollow and replies with the chapter count", async () => {
    const follows = fakeFollows();
    const { bot, methods, texts, edit } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(follows.follow).toHaveBeenCalledExactlyOnceWith("65164981");
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(edit()?.payload).toMatchObject({ chat_id: OWNER, message_id: 7 });
    expect(edit()?.payload["reply_markup"]).toEqual(unfollowKeyboard("65164981"));
    expect(texts()).toEqual([followsMessages.nowFollowing("Title", 12)]);
    expect(texts()[0]).toContain("12 chapters");
  });

  it("already followed → Unfollow keyboard and alreadyFollowing", async () => {
    const follows = fakeFollows({ follow: vi.fn(async () => ({ kind: "already", fic: FOLLOWED }) as never) });
    const { bot, texts, edit } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(edit()?.payload["reply_markup"]).toEqual(unfollowKeyboard("65164981"));
    expect(texts()).toEqual([followsMessages.alreadyFollowing("Title")]);
  });

  it("unknown (old button) → markup removed and followUnknown replied, nothing stored", async () => {
    const follows = fakeFollows({ follow: vi.fn(async () => ({ kind: "unknown" }) as never) });
    const { bot, texts, edit } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(edit()).toBeDefined();
    expect(edit()?.payload["reply_markup"]).toBeUndefined();
    expect(texts()).toEqual([followsMessages.followUnknown()]);
  });

  it("follow rejecting → followSaveFailed replied, markup untouched, error logged", async () => {
    const boom = new Error("disk full");
    const error = vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
    const follows = fakeFollows({ follow: vi.fn().mockRejectedValue(boom) });
    const { bot, methods, texts } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(texts()).toEqual([followsMessages.followSaveFailed()]);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: boom }));
    error.mockRestore();
  });
});

describe("Unfollow tap (R4; acceptance 4)", () => {
  it("uf:<id> answers, unfollows, removes the markup and replies with the title", async () => {
    const follows = fakeFollows();
    const { bot, methods, texts, edit } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "uf:65164981"));
    expect(follows.unfollow).toHaveBeenCalledExactlyOnceWith("65164981");
    expect(follows.follow).not.toHaveBeenCalled();
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
    expect(edit()?.payload["reply_markup"]).toBeUndefined();
    expect(texts()).toEqual([followsMessages.unfollowed("Title")]);
  });

  it("not followed → notFollowing replied and the message markup is left alone (R4.2)", async () => {
    const follows = fakeFollows({ unfollow: vi.fn(async () => ({ kind: "not-followed" }) as never) });
    const { bot, methods, texts } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "uf:65164981"));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(texts()).toEqual([followsMessages.notFollowing()]);
  });

  it("unfollow rejecting → followSaveFailed replied, markup untouched", async () => {
    const error = vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
    const follows = fakeFollows({ unfollow: vi.fn().mockRejectedValue(new Error("disk full")) });
    const { bot, methods, texts } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "uf:65164981"));
    expect(methods()).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(texts()).toEqual([followsMessages.followSaveFailed()]);
    error.mockRestore();
  });
});

describe("Telegram failures during a tap only warn", () => {
  it("answerCallbackQuery and editMessageReplyMarkup failing → warnings, the reply is still sent", async () => {
    const warn = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
    const follows = fakeFollows();
    const { bot, texts } = botWith(follows, { failMethods: ["answerCallbackQuery", "editMessageReplyMarkup"] });
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(follows.follow).toHaveBeenCalledOnce();
    expect(texts()).toEqual([followsMessages.nowFollowing("Title", 12)]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("the reply failing → a warning, nothing thrown", async () => {
    const warn = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
    const { bot } = botWith(fakeFollows(), { failMethods: ["sendMessage"] });
    await expect(bot.handleUpdate(tap(OWNER, "uf:65164981"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("owner filtering, feature 3 buttons and documents (acceptance 10, 11)", () => {
  it("a tap from a non-owner calls nothing and replies nothing", async () => {
    const follows = fakeFollows();
    const { bot, calls } = botWith(follows);
    await bot.handleUpdate(tap(STRANGER, "fo:65164981"));
    await bot.handleUpdate(tap(STRANGER, "uf:65164981"));
    expect(follows.follow).not.toHaveBeenCalled();
    expect(follows.unfollow).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("ow: buttons still reach the document flow, and never the follows", async () => {
    const follows = fakeFollows();
    const documents: DocumentFlow = { onDocument: vi.fn(), onDecision: vi.fn() };
    const { bot, methods } = botWith(follows, { documents });
    await bot.handleUpdate(tap(OWNER, "ow:abcdEFGH:y"));
    expect(documents.onDecision).toHaveBeenCalledWith("abcdEFGH", "replace", expect.anything());
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(follows.follow).not.toHaveBeenCalled();
    expect(follows.unfollow).not.toHaveBeenCalled();
  });

  it("other callback data is only answered, as before", async () => {
    const follows = fakeFollows();
    const { bot, methods } = botWith(follows);
    await bot.handleUpdate(tap(OWNER, "fo:abc"));
    expect(methods()).toEqual(["answerCallbackQuery"]);
    expect(follows.follow).not.toHaveBeenCalled();
  });

  it("a document delivery message carries no reply_markup", async () => {
    const documents: DocumentFlow = {
      onDocument: vi.fn(async (_doc, io) => void (await io.reply("Delivered “Libro.epub” to your Kindle."))),
      onDecision: vi.fn(),
    };
    const { bot, calls } = botWith(fakeFollows(), { documents });
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: chat(OWNER),
        from: user(OWNER),
        document: { file_id: "F", file_unique_id: "U", file_name: "Libro.epub", file_size: 10 },
      },
    });
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload["reply_markup"]).toBeUndefined();
  });
});

describe("the delivery action reaches Telegram as reply_markup", () => {
  const send = (action: DeliveryAction) =>
    ({
      handle: vi.fn(async (_text: string, reply: Send) => {
        await reply("plain");
        await reply("with action", action);
      }),
    }) satisfies Pick<Pipeline, "handle">;
  const textMessage: Update = {
    update_id: 2,
    message: { message_id: 2, date: 0, chat: chat(OWNER), from: user(OWNER), text: LINK },
  };

  it("a pipeline reply with action follow gets the Follow keyboard, one without has no reply_markup", async () => {
    const { bot, calls } = botWith(fakeFollows(), { pipeline: send({ action: "follow", workId: "65164981" }) });
    await bot.handleUpdate(textMessage);
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent[0]?.payload["reply_markup"]).toBeUndefined();
    expect(sent[1]?.payload["reply_markup"]).toEqual(followKeyboard("65164981"));
  });

  it("action unfollow gets the Unfollow keyboard", async () => {
    const { bot, calls } = botWith(fakeFollows(), { pipeline: send({ action: "unfollow", workId: "65164981" }) });
    await bot.handleUpdate(textMessage);
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent[1]?.payload["reply_markup"]).toEqual(unfollowKeyboard("65164981"));
  });

  it("notifyOwner translates the action into reply_markup in the owner's chat", async () => {
    const { bot, calls } = botWith(fakeFollows());
    await notifyOwner(bot, OWNER)("hello", { action: "follow", workId: "65164981" });
    await notifyOwner(bot, OWNER)("hello again", { action: "unfollow", workId: "65164981" });
    await notifyOwner(bot, OWNER)("plain");
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent[0]?.payload).toMatchObject({ chat_id: OWNER, text: "hello" });
    expect(sent[0]?.payload["reply_markup"]).toEqual(followKeyboard("65164981"));
    expect(sent[1]?.payload["reply_markup"]).toEqual(unfollowKeyboard("65164981"));
    expect(sent[2]?.payload["reply_markup"]).toBeUndefined();
  });

  it("without follows, a fo: tap is only answered (createBot keeps the optional parameter)", async () => {
    const calls: string[] = [];
    const bot = createBot(botConfig, { handle: vi.fn(async () => {}) }, { botInfo });
    bot.api.config.use((_prev, method) => {
      calls.push(method);
      return Promise.resolve({ ok: true as const, result: true as never });
    });
    await bot.handleUpdate(tap(OWNER, "fo:65164981"));
    expect(calls).toEqual(["answerCallbackQuery"]);
  });
});
