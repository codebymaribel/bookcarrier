/**
 * Public API of the `telegram` context. Telegram interface: owner filter, handlers and buttons that route updates to the contexts.
 * Code outside `src/telegram/` imports only from here.
 */
export { createBot, notifyOwner } from "./bot.js";
