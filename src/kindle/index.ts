/**
 * Public API of the `kindle` context. Delivery to the Kindle over SSH/scp.
 * Code outside `src/kindle/` imports only from here.
 */
export { messages } from "./messages.js";
export { existsOnKindle, SSH_BIN, type SshTarget, UploadConfigError, UploadFailedError } from "./ssh.js";
export { SCP_BIN, type UploadOptions, uploadToKindle } from "./uploader.js";
