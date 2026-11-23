import { Bot, type BotConfig, type Context, InlineKeyboard } from "grammy";
import { logger as defaultLogger, type ResolvedConfig } from "../shared/index.js";
import {
  type ChatIO,
  createDocumentFlow,
  type DocumentConfig,
  type DocumentFlow,
  telegramDownloader,
} from "../documents/index.js";
import type { Pipeline, Send } from "../fanfic/index.js";

/**
 * Global grammY middleware that only lets the owner through (R1.1).
 *
 * Any update whose `from.id` is not `ownerId` is dropped without calling `next()` and without
 * replying, so a stranger cannot even tell the bot exists and is active. Updates with no `from`
 * (e.g. channel posts) are dropped too: if we cannot tell who sent it, it is not the owner.
 *
 * It must be registered first (`bot.use(ownerOnly(id))`), before any handler.
 */
export function ownerOnly(
  ownerId: number,
): (ctx: Pick<Context, "from">, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return;
    await next();
  };
}

/** A {@link Send} that writes to the owner's private chat: retries have no message to reply to. */
export function notifyOwner(bot: Bot, ownerId: number): Send {
  return (text) => bot.api.sendMessage(ownerId, text);
}

/**
 * `callback_data` of the overwrite buttons: `ow:<8-char id>:y` (Replace) or `:n` (Cancel). Only the
 * pending id and the action, never the file name; 13 bytes, far under Telegram's 64 (R5.3). The
 * `ow:` prefix namespaces it from future buttons.
 */
export const OVERWRITE_DATA = /^ow:([A-Za-z0-9_-]{8}):(y|n)$/;

/** The "Replace" / "Cancel" keyboard for pending confirmation `id` (R5.1). */
export function overwriteKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text("Replace", `ow:${id}:y`).text("Cancel", `ow:${id}:n`);
}

/** The {@link ChatIO} for one update: plain-text replies in the update's chat (R9.1). */
function chatIO(ctx: Context): ChatIO {
  return {
    reply: (text) => ctx.reply(text),
    askOverwrite: (text, id) => ctx.reply(text, { reply_markup: overwriteKeyboard(id) }),
  };
}

/**
 * Creates the grammY bot: owner filter first (R1.1, it also drops strangers' documents and button
 * taps), then the text handler (AO3 links → pipeline) and the document flow (feature 3): documents
 * and overwrite button taps. A text never reaches the document flow and a document never reaches
 * the link extraction (R2.1).
 *
 * `documents` defaults to the real flow, whose download uses this bot's `getFile`. `grammy` and
 * `documents` are only for tests (e.g. a preset `botInfo` so no `getMe` call is made).
 */
export function createBot(
  config: Pick<ResolvedConfig, "telegramToken" | "ownerId"> & DocumentConfig,
  pipeline: Pick<Pipeline, "handle">,
  grammy?: BotConfig<Context>,
  documents?: DocumentFlow,
): Bot {
  const bot = new Bot(config.telegramToken, grammy);
  const docs =
    documents ??
    createDocumentFlow(config, { download: telegramDownloader(config, (fileId) => bot.api.getFile(fileId)) });
  const logWarn = (what: string) => (err: unknown) => {
    defaultLogger.warn(`could not ${what}`, { error: err });
  };

  bot.use(ownerOnly(config.ownerId));
  bot.on("message:text", (ctx) => pipeline.handle(ctx.message.text, (text) => ctx.reply(text)));
  bot.on("message:document", (ctx) => docs.onDocument(ctx.message.document, chatIO(ctx)));
  bot.callbackQuery(OVERWRITE_DATA, async (ctx) => {
    // R5.7: stop the spinner and remove the buttons whatever happens next; failures only logged.
    await ctx.answerCallbackQuery().catch(logWarn("answer a callback query"));
    await ctx.editMessageReplyMarkup().catch(logWarn("remove the overwrite buttons"));
    const [, id = "", action] = ctx.match;
    await docs.onDecision(id, action === "y" ? "replace" : "cancel", chatIO(ctx));
  });
  // Any other button tap: stop the spinner and ignore it.
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery().catch(logWarn("answer a callback query")));
  return bot;
}
