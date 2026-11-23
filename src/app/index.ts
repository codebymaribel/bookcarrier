/**
 * Public API of the `app` context. Composition root: startup checks and the daemon that wires every context together.
 * Code outside `src/app/` imports only from here.
 */
export { checkRequiredBinaries } from "./binaries.js";
export { createDaemon, pollUntilStopped } from "./daemon.js";
