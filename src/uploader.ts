import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { appendTail, summarizeStderr } from "./subprocess.js";

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

export type UploadConfigProblem =
  | "key-missing"
  | "key-permissions-open"
  | "key-unreadable"
  | "binary-not-found";

/**
 * Permanent: retrying will not fix it (R5.2, R5.5). The SSH key is missing / has open permissions /
 * cannot be read, or the `scp` binary cannot be launched. Detected BEFORE or AT launch, never from
 * the exit code (R5.7).
 */
export class UploadConfigError extends Error {
  readonly problem: UploadConfigProblem;

  constructor(problem: UploadConfigProblem, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UploadConfigError";
    this.problem = problem;
  }
}

/**
 * The process was launched and failed or hung (R5.3, R5.7): any non-zero exit, or a timeout.
 * Treated as a send failure whatever the exit code is, because OpenSSH's codes are generic.
 */
export class UploadFailedError extends Error {
  readonly reason: "exit-code" | "timeout";
  /** Tail of scp's stderr: for the logs. */
  readonly stderr: string;

  constructor(reason: "exit-code" | "timeout", message: string, stderr = "") {
    super(message);
    this.name = "UploadFailedError";
    this.reason = reason;
    this.stderr = stderr;
  }
}

/**
 * SSH's own criterion for a usable private key (R5.2): neither group nor others have any
 * permission, and the owner can read it. Not exactly `600`: a `400` key is valid for SSH.
 */
function modeProblem(mode: number): "key-permissions-open" | "key-unreadable" | undefined {
  if ((mode & 0o077) !== 0) return "key-permissions-open";
  if ((mode & 0o400) === 0) return "key-unreadable";
  return undefined;
}

/**
 * Checks the key before launching anything (R5.2). `scp` itself would start fine with a bad key,
 * SSH would warn on stderr, ignore the key and exit with the same generic code as an unreachable
 * host; so this has to be done here, deterministically, without parsing OpenSSH's messages.
 *
 * Out of scope on purpose: SSH also checks that the key belongs to the current user.
 */
async function assertKeyUsable(keyPath: string): Promise<void> {
  let info;
  try {
    info = await stat(keyPath);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    const missing = code === "ENOENT" || code === "ENOTDIR";
    throw new UploadConfigError(
      missing ? "key-missing" : "key-unreadable",
      missing
        ? `SSH key not found: ${keyPath}`
        : `SSH key cannot be read: ${keyPath} (${code || "unknown error"})`,
      { cause: err },
    );
  }
  if (!info.isFile()) {
    throw new UploadConfigError("key-missing", `SSH key path is not a file: ${keyPath}`);
  }
  const problem = modeProblem(info.mode);
  if (problem === "key-permissions-open") {
    const octal = (info.mode & 0o777).toString(8).padStart(3, "0");
    throw new UploadConfigError(
      problem,
      `SSH key ${keyPath} has open permissions (${octal}); SSH would ignore it. Use chmod 600`,
    );
  }
  if (problem === "key-unreadable") {
    throw new UploadConfigError(problem, `SSH key ${keyPath} is not readable by its owner`);
  }
}

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
    // BatchMode=yes makes an authentication failure end at once instead of waiting for a password (R5.6).
    const child = spawn(
      SCP_BIN,
      [
        "-P",
        String(opts.port),
        "-o",
        `ConnectTimeout=${opts.connectTimeoutSec}`,
        "-o",
        "BatchMode=yes",
        "-i",
        opts.sshKeyPath,
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
