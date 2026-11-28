/**
 * Public API of the `shared` context. Cross-cutting infrastructure: config, logging, subprocess helpers, generic texts.
 * Code outside `src/shared/` imports only from here.
 */
export { ConfigError, loadConfig, type ResolvedConfig } from "./config.js";
export { createJsonFileStore, type JsonFileStore, type JsonReadResult } from "./json-file.js";
export { createLogger, formatLine, logger, type Logger } from "./logger.js";
export { messages } from "./messages.js";
export { appendTail, summarizeStderr } from "./subprocess.js";
