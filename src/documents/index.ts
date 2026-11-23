/**
 * Public API of the `documents` context. Documents sent to the bot as files (EPUB, MOBI, PDF): validation, Telegram download, overwrite confirmation, delivery.
 * Code outside `src/documents/` imports only from here.
 */
export { type ChatIO, createDocumentFlow, type DocumentConfig, type DocumentFlow, telegramDownloader } from "./flow.js";
export { messages } from "./messages.js";
export { createPendingStore } from "./pending.js";
