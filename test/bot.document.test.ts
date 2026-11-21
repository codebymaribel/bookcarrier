import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot, OVERWRITE_DATA } from "../src/bot.js";
import type { ResolvedConfig } from "../src/config.js";
import { createDocumentFlow, type DocumentFlow } from "../src/document-flow.js";
import { messages } from "../src/messages.js";
import { createPendingStore } from "../src/pending.js";

const OWNER = 42;
const STRANGER = 99;
const BOOKS = "/mnt/us/documents/books/";

const config: ResolvedConfig = {
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
  spoolDir: "/q/spool",
  giveUpAfterMs: 30 * 60_000,
  retryBackoffMinutes: [1, 2, 4, 8, 15],
  documentFolders: new Map([
    ["epub", BOOKS],
    ["mobi", BOOKS],
    ["pdf", BOOKS],
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

const user = (id: number) => ({ id, is_bot: false, first_name: "T" });
const chat = (id: number) => ({ id, type: "private" as const, first_name: "T" });

function documentUpdate(fromId: number, fileName = "Libro.epub"): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: chat(fromId),
      from: user(fromId),
      document: { file_id: "FILE-1", file_unique_id: "U1", file_name: fileName, file_size: 1000 },
    },
  };
}

function textUpdate(fromId: number, text: string): Update {
  return {
    update_id: 2,
    message: { message_id: 2, date: 0, chat: chat(fromId), from: user(fromId), text },
  };
}

function tapUpdate(fromId: number, data: string): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "cq-1",
      from: user(fromId),
      chat_instance: "ci",
      data,
      message: { message_id: 7, date: 0, chat: chat(fromId), text: "question" },
    },
  };
}

type Call = { method: string; payload: Record<string, unknown> };

/** A real grammY bot whose API calls are captured into `events`; nothing leaves the machine. */
function botWith(documents: DocumentFlow, opts: { failMethods?: string[] } = {}) {
  const events: string[] = [];
  const calls: Call[] = [];
  const pipeline = { handle: vi.fn(async (text: string) => void events.push(`handle ${text}`)) };
  const bot = createBot(config, pipeline, { botInfo }, documents);
  bot.api.config.use((_prev, method, payload) => {
    events.push(method);
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (opts.failMethods?.includes(method)) return Promise.reject(new Error(`${method} failed`));
    // `never`: the result type depends on the method and the fake result is never inspected.
    return Promise.resolve({ ok: true as const, result: true as never });
  });
  return { bot, events, calls, pipeline };
}

function fakeFlow(events?: string[]): DocumentFlow & {
  onDocument: ReturnType<typeof vi.fn>;
  onDecision: ReturnType<typeof vi.fn>;
} {
  return {
    onDocument: vi.fn(async () => void events?.push("onDocument")),
    onDecision: vi.fn(async (id: string, action: string) => void events?.push(`onDecision ${id} ${action}`)),
  };
}

describe("bot wiring — owner only (R1.1, acceptance 16)", () => {
  it("a document from a stranger gets no reply and no API call", async () => {
    const flow = fakeFlow();
    const { bot, calls } = botWith(flow);
    await bot.handleUpdate(documentUpdate(STRANGER));
    expect(flow.onDocument).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a button tap from a stranger gets no reply and no API call (not even answerCallbackQuery)", async () => {
    const flow = fakeFlow();
    const { bot, calls } = botWith(flow);
    await bot.handleUpdate(tapUpdate(STRANGER, "ow:abcdEFGH:y"));
    expect(flow.onDecision).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("bot wiring — documents and texts are separate flows (R2.1)", () => {
  it("an owner's document reaches onDocument with the document, and never the text flow", async () => {
    const flow = fakeFlow();
    const { bot, pipeline } = botWith(flow);
    await bot.handleUpdate(documentUpdate(OWNER));
    expect(flow.onDocument).toHaveBeenCalledOnce();
    expect(flow.onDocument.mock.calls[0]?.[0]).toMatchObject({ file_id: "FILE-1", file_name: "Libro.epub" });
    expect(pipeline.handle).not.toHaveBeenCalled();
  });

  it("an owner's text still goes to the AO3 flow and never to onDocument", async () => {
    const flow = fakeFlow();
    const { bot, pipeline } = botWith(flow);
    await bot.handleUpdate(textUpdate(OWNER, "https://archiveofourown.org/works/1"));
    expect(pipeline.handle).toHaveBeenCalledOnce();
    expect(flow.onDocument).not.toHaveBeenCalled();
  });
});

describe("bot wiring — the overwrite question (R5.1, R5.3)", () => {
  it("askOverwrite replies with an inline keyboard: Replace → ow:<id>:y, Cancel → ow:<id>:n, plain text", async () => {
    const flow: DocumentFlow = {
      onDocument: async (_doc, io) => {
        await io.askOverwrite("“Libro.epub” is already on your Kindle. Replace it?", "abcdEFGH");
      },
      onDecision: vi.fn(),
    };
    const { bot, calls } = botWith(flow);
    await bot.handleUpdate(documentUpdate(OWNER));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe("sendMessage");
    expect(call?.payload["chat_id"]).toBe(OWNER);
    expect(call?.payload["parse_mode"]).toBeUndefined();
    expect(call?.payload["reply_markup"]).toEqual({
      inline_keyboard: [
        [
          { text: "Replace", callback_data: "ow:abcdEFGH:y" },
          { text: "Cancel", callback_data: "ow:abcdEFGH:n" },
        ],
      ],
    });
    expect(Buffer.byteLength("ow:abcdEFGH:y")).toBeLessThanOrEqual(64);
  });

  it("OVERWRITE_DATA matches only ow:<8 id chars>:y|n", () => {
    expect(OVERWRITE_DATA.test("ow:abcd-_GH:y")).toBe(true);
    expect(OVERWRITE_DATA.test("ow:abcdEFGH:n")).toBe(true);
    expect(OVERWRITE_DATA.test("ow:abcdEFGH:x")).toBe(false);
    expect(OVERWRITE_DATA.test("ow:abc:y")).toBe(false);
    expect(OVERWRITE_DATA.test("xx:abcdEFGH:y")).toBe(false);
  });
});

describe("bot wiring — button taps (R5.7)", () => {
  it("a tap on ow:<id>:y answers the query, removes the buttons, then calls onDecision(id, replace)", async () => {
    const events: string[] = [];
    const flow = fakeFlow(events);
    const { bot, calls } = botWith(flow);
    bot.api.config.use((prev, method, payload, signal) => {
      events.push(`api ${method}`);
      return prev(method, payload, signal);
    });
    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:y"));
    expect(events).toEqual(["api answerCallbackQuery", "api editMessageReplyMarkup", "onDecision abcdEFGH replace"]);
    const edit = calls.find((c) => c.method === "editMessageReplyMarkup");
    expect(edit?.payload).toMatchObject({ chat_id: OWNER, message_id: 7 });
    expect(edit?.payload["reply_markup"]).toBeUndefined();
  });

  it("a tap on ow:<id>:n → onDecision(id, cancel)", async () => {
    const flow = fakeFlow();
    const { bot } = botWith(flow);
    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:n"));
    expect(flow.onDecision).toHaveBeenCalledWith("abcdEFGH", "cancel", expect.anything());
  });

  it("if answerCallbackQuery and editMessageReplyMarkup fail, onDecision still runs", async () => {
    const flow = fakeFlow();
    const { bot } = botWith(flow, { failMethods: ["answerCallbackQuery", "editMessageReplyMarkup"] });
    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:y"));
    expect(flow.onDecision).toHaveBeenCalledWith("abcdEFGH", "replace", expect.anything());
  });

  it("a callback_query whose data does not match is answered and nothing else happens", async () => {
    const flow = fakeFlow();
    const { bot, calls, pipeline } = botWith(flow);
    await bot.handleUpdate(tapUpdate(OWNER, "follow:123"));
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    expect(flow.onDecision).not.toHaveBeenCalled();
    expect(pipeline.handle).not.toHaveBeenCalled();
  });
});

describe("bot wiring — end to end with the real flow (acceptance 8, 9, 10, 11)", () => {
  function realFlow(existing: boolean) {
    const steps: string[] = [];
    const flow = createDocumentFlow(config, {
      exists: vi.fn(async () => existing),
      download: vi.fn(async (_id: string, dest: string) => void steps.push(`download ${dest}`)),
      upload: vi.fn(async (path: string) => void steps.push(`upload ${path}`)),
      pending: createPendingStore({ ttlMs: 10 * 60_000, newId: () => "abcdEFGH" }),
      makeTempDir: async () => "/tmp/d",
      removeDir: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return { flow, steps };
  }

  const texts = (calls: Call[]) =>
    calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]));

  it("existing → question with buttons, nothing downloaded; Replace → delivered, buttons removed", async () => {
    const { flow, steps } = realFlow(true);
    const { bot, calls } = botWith(flow);
    await bot.handleUpdate(documentUpdate(OWNER));
    expect(texts(calls)).toEqual([messages.docAck, messages.alreadyExists("Libro.epub")]);
    expect(steps).toEqual([]);

    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:y"));
    expect(steps).toEqual(["download /tmp/d/Libro.epub", "upload /tmp/d/Libro.epub"]);
    expect(calls.map((c) => c.method)).toContain("editMessageReplyMarkup");
    expect(texts(calls).at(-1)).toBe(messages.docDelivered("Libro.epub"));
  });

  it("Cancel → nothing sent, nothing downloaded; a later tap → no longer pending", async () => {
    const { flow, steps } = realFlow(true);
    const { bot, calls } = botWith(flow);
    await bot.handleUpdate(documentUpdate(OWNER));
    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:n"));
    expect(texts(calls).at(-1)).toBe(messages.overwriteCancelled("Libro.epub"));
    await bot.handleUpdate(tapUpdate(OWNER, "ow:abcdEFGH:y"));
    expect(texts(calls).at(-1)).toBe(messages.confirmationExpired);
    expect(steps).toEqual([]);
  });
});
