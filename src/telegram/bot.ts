import { Bot, type BotConfig, type Context, InlineKeyboard } from "grammy";
import { logger as defaultLogger, type ResolvedConfig } from "../shared/index.js";
import {
  type ChatIO,
  createDocumentFlow,
  type DocumentConfig,
  type DocumentFlow,
  telegramDownloader,
} from "../documents/index.js";
import type { DeliveryAction, Pipeline, Send } from "../fanfic/index.js";
import { type Follows, followsMessages } from "../follows/index.js";

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
  return (text, action) => bot.api.sendMessage(ownerId, text, replyMarkup(action));
}

/** Send options carrying the keyboard of a delivery action, or none (the translation lives here, not in the pipeline). */
function replyMarkup(action: DeliveryAction): { reply_markup: InlineKeyboard } | undefined {
  if (action === undefined) return undefined;
  return {
    reply_markup: action.action === "follow" ? followKeyboard(action.workId) : unfollowKeyboard(action.workId),
  };
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

/**
 * `callback_data` of the follow buttons: `fo:<work id>` (Follow) or `uf:<work id>` (Unfollow). Only
 * the action and the AO3 work id, never the title; at most 15 bytes (R3.2, R4.3).
 */
export const FOLLOW_DATA = /^(fo|uf):(\d{1,12})$/;

/** The "Follow" keyboard of a delivery message (R3.1). */
export function followKeyboard(workId: string): InlineKeyboard {
  return new InlineKeyboard().text("Follow", `fo:${workId}`);
}

/** The "Unfollow" keyboard (R3.3, R6.2). */
export function unfollowKeyboard(workId: string): InlineKeyboard {
  return new InlineKeyboard().text("Unfollow", `uf:${workId}`);
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
 * Feature 5: when `follows` is given, taps on the Follow / Unfollow buttons ({@link FOLLOW_DATA}) are
 * handled before the generic fallback; without it those taps are only answered. The pipeline's
 * abstract delivery action becomes the matching keyboard here.
 *
 * `documents` defaults to the real flow, whose download uses this bot's `getFile`. `grammy` and
 * `documents` are only for tests (e.g. a preset `botInfo` so no `getMe` call is made).
 */
export function createBot(
  config: Pick<ResolvedConfig, "telegramToken" | "ownerId"> & DocumentConfig,
  pipeline: Pick<Pipeline, "handle">,
  grammy?: BotConfig<Context>,
  documents?: DocumentFlow,
  follows?: Pick<Follows, "follow" | "unfollow">,
): Bot {
  const bot = new Bot(config.telegramToken, grammy);
  const docs =
    documents ??
    createDocumentFlow(config, { download: telegramDownloader(config, (fileId) => bot.api.getFile(fileId)) });
  const logWarn = (what: string) => (err: unknown) => {
    defaultLogger.warn(`could not ${what}`, { error: err });
  };

  bot.use(ownerOnly(config.ownerId));
  bot.on("message:text", (ctx) =>
    pipeline.handle(ctx.message.text, (text, action) => ctx.reply(text, replyMarkup(action))),
  );
  bot.on("message:document", (ctx) => docs.onDocument(ctx.message.document, chatIO(ctx)));
  bot.callbackQuery(OVERWRITE_DATA, async (ctx) => {
    // R5.7: stop the spinner and remove the buttons whatever happens next; failures only logged.
    await ctx.answerCallbackQuery().catch(logWarn("answer a callback query"));
    await ctx.editMessageReplyMarkup().catch(logWarn("remove the overwrite buttons"));
    const [, id = "", action] = ctx.match;
    await docs.onDecision(id, action === "y" ? "replace" : "cancel", chatIO(ctx));
  });
  if (follows !== undefined) bot.callbackQuery(FOLLOW_DATA, followTapHandler(follows, logWarn));
  // Any other button tap: stop the spinner and ignore it.
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery().catch(logWarn("answer a callback query")));
  return bot;
}

/**
 * Handles a Follow (`fo:`) or Unfollow (`uf:`) tap (R3.3, R3.4, R3.6, R4.1, R4.2). The query is
 * answered first and failures of Telegram calls are only logged. If the follows file cannot be
 * written, the owner is told and the buttons stay as they were, so the tap can be repeated.
 */
function followTapHandler(
  follows: Pick<Follows, "follow" | "unfollow">,
  logWarn: (what: string) => (err: unknown) => void,
): (ctx: Context & { match: RegExpMatchArray | string }) => Promise<void> {
  return async (ctx) => {
    await ctx.answerCallbackQuery().catch(logWarn("answer a callback query"));
    const [, action = "", workId = ""] = Array.isArray(ctx.match) ? ctx.match : [];
    const say = (text: string) => ctx.reply(text).catch(logWarn("reply to a follow tap"));
    const removeButton = () => ctx.editMessageReplyMarkup().catch(logWarn("remove the follow button"));
    const showUnfollow = () =>
      ctx
        .editMessageReplyMarkup({ reply_markup: unfollowKeyboard(workId) })
        .catch(logWarn("show the unfollow button"));

    try {
      if (action === "fo") {
        const result = await follows.follow(workId);
        if (result.kind === "unknown") {
          await removeButton();
          await say(followsMessages.followUnknown());
          return;
        }
        await showUnfollow();
        await say(
          result.kind === "followed"
            ? followsMessages.nowFollowing(result.fic.title, result.fic.chapters)
            : followsMessages.alreadyFollowing(result.fic.title),
        );
        return;
      }
      const result = await follows.unfollow(workId);
      if (result.kind === "not-followed") {
        await say(followsMessages.notFollowing());
        return;
      }
      await removeButton();
      await say(followsMessages.unfollowed(result.title));
    } catch (err) {
      defaultLogger.error("could not update the follows file", { workId, action, error: err });
      await say(followsMessages.followSaveFailed());
    }
  };
}
