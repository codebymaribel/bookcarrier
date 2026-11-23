/**
 * Public API of the `fanfic` context. Fics shared as AO3 links: link parsing, FanFicFare download, failure policy and the request/retry pipeline.
 * Code outside `src/fanfic/` imports only from here.
 */
export { downloadEpub, FANFICFARE_BIN } from "./downloader.js";
export { messages } from "./messages.js";
export { createPipeline, type Pipeline, type PipelineDeps, type Send } from "./pipeline.js";
