import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { ownerOnly } from "./bot.js";

const OWNER = 42;
const STRANGER = 99;

describe("ownerOnly (unit)", () => {
  it("calls next() for the owner", async () => {
    const next = vi.fn(() => Promise.resolve());
    await ownerOnly(OWNER)({ from: { id: OWNER, is_bot: false, first_name: "M" } }, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not call next() for a different id", async () => {
    const next = vi.fn(() => Promise.resolve());
    await ownerOnly(OWNER)({ from: { id: STRANGER, is_bot: false, first_name: "X" } }, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next() when the update has no sender", async () => {
    const next = vi.fn(() => Promise.resolve());
    await ownerOnly(OWNER)({ from: undefined }, next);
    expect(next).not.toHaveBeenCalled();
  });
});

/** Real grammY `Bot` fed with fake updates; every outgoing API call is captured, none leaves the machine. */
function botWithSpy() {
  const bot = new Bot("123:fake", {
    botInfo: {
      id: 1,
      is_bot: true,
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
    },
  });
  const apiCalls: string[] = [];
  bot.api.config.use((_prev, method) => {
    apiCalls.push(method);
    // `never` is justified: the result type depends on the generic API method and the fake
    // reply is never inspected; only the fact that a call happened matters here.
    return Promise.resolve({ ok: true as const, result: true as never });
  });
  const handler = vi.fn(async (ctx: { reply: (text: string) => Promise<unknown> }) => {
    await ctx.reply("hi");
  });
  bot.use(ownerOnly(OWNER));
  bot.on("message", handler);
  return { bot, apiCalls, handler };
}

function messageFrom(id: number) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id, type: "private" as const, first_name: "T" },
      from: { id, is_bot: false, first_name: "T" },
      text: "hello",
    },
  };
}

describe("ownerOnly (inside a real grammY Bot)", () => {
  it("a message from another id gets no reply and reaches no handler (R1.1)", async () => {
    const { bot, apiCalls, handler } = botWithSpy();
    await bot.handleUpdate(messageFrom(STRANGER));
    expect(handler).not.toHaveBeenCalled();
    expect(apiCalls).toEqual([]);
  });

  it("a message from the owner reaches the next handler", async () => {
    const { bot, apiCalls, handler } = botWithSpy();
    await bot.handleUpdate(messageFrom(OWNER));
    expect(handler).toHaveBeenCalledOnce();
    expect(apiCalls).toEqual(["sendMessage"]);
  });
});
