import { spawn } from "node:child_process";
import {
  assertKeyUsable,
  commonSshArgs,
  UploadConfigError,
  UploadFailedError,
} from "./ssh.js";
import { appendTail, summarizeStderr } from "../shared/index.js";

// The error classes live in ssh.ts (shared with `existsOnKindle`); re-exported so existing imports
// from "./uploader.js" keep working.
export { UploadConfigError, UploadFailedError, type UploadConfigProblem } from "./ssh.js";

export const SCP_BIN = "scp";

export type UploadOptions = {
  sshKeyPath: string;
  kindleUser: string;
  kindleHost: string;
  port: number;
  remotePath: string;
  connectTimeoutSec: number;
  timeoutMs: number;
};

/**
 * Copies a local file to the Kindle with `scp`, as an async subprocess (R5.1).
 *
 * Rejects with:
 * - {@link UploadConfigError} if the key is unusable (checked first, `scp` is not even launched,
 *   R5.2) or `scp` cannot be launched (`error` event, R5.5, names the binary);
 * - {@link UploadFailedError} for any non-zero exit or a timeout (R5.3, R5.7). The exit code's
 *   value is never inspected.
 */
export async function uploadToKindle(localPath: string, opts: UploadOptions): Promise<void> {
  await assertKeyUsable(opts.sshKeyPath);

  await new Promise<void>((resolve, reject) => {
    // Uppercase -P is the port (R5.8); lowercase -p would keep timestamps and leave the port at 22.
    // The common options (ConnectTimeout, BatchMode=yes, key) come from ssh.ts (R5.6).
    const child = spawn(
      SCP_BIN,
      [
        "-P",
        String(opts.port),
        ...commonSshArgs(opts),
        localPath,
        `${opts.kindleUser}@${opts.kindleHost}:${opts.remotePath}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let settled = false;
    let stderrTail = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    // Safety net on top of ConnectTimeout, in case the process still hangs.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new UploadFailedError(
            "timeout",
            `${SCP_BIN} did not finish within ${opts.timeoutMs} ms and was killed`,
            stderrTail,
          ),
        ),
      );
    }, opts.timeoutMs);

    /** Settles the promise once; whichever of timeout / error / close comes first wins. */
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    }

    // R5.5: the binary itself could not be executed (ENOENT / EACCES).
    child.on("error", (err) =>
      finish(() =>
        reject(
          new UploadConfigError(
            "binary-not-found",
            `could not launch "${SCP_BIN}" (${err.message}); is it installed and on the PATH?`,
            { cause: err },
          ),
        ),
      ),
    );

    child.on("close", (code, signal) => {
      if (code === 0) return finish(resolve);
      const how = code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`;
      const summary = summarizeStderr(stderrTail, 2);
      finish(() =>
        reject(
          new UploadFailedError(
            "exit-code",
            `${SCP_BIN} ${how}${summary === "" ? "" : `: ${summary}`}`,
            stderrTail,
          ),
        ),
      );
    });
  });
}
