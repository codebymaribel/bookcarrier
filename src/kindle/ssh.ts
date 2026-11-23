import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { appendTail, summarizeStderr } from "../shared/subprocess.js";

/** Who and how to connect: what both `ssh` and `scp` need. */
export type SshTarget = {
  sshKeyPath: string;
  kindleUser: string;
  kindleHost: string;
  port: number;
  connectTimeoutSec: number;
  timeoutMs: number;
};

export const SSH_BIN = "ssh";

export type UploadConfigProblem =
  | "key-missing"
  | "key-permissions-open"
  | "key-unreadable"
  | "binary-not-found";

/**
 * Permanent: retrying will not fix it (R5.2, R5.5). The SSH key is missing / has open permissions /
 * cannot be read, or the `scp`/`ssh` binary cannot be launched. Detected BEFORE or AT launch, never
 * from the exit code (R5.7).
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
  /** Tail of the subprocess's stderr: for the logs. */
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
 * Checks the key before launching anything (R5.2). `scp`/`ssh` would start fine with a bad key,
 * SSH would warn on stderr, ignore the key and exit with the same generic code as an unreachable
 * host; so this has to be done here, deterministically, without parsing OpenSSH's messages.
 *
 * Out of scope on purpose: SSH also checks that the key belongs to the current user.
 */
export async function assertKeyUsable(keyPath: string): Promise<void> {
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
 * Options shared by `ssh` and `scp`. BatchMode=yes makes an authentication failure end at once
 * instead of waiting for a password (R5.6).
 *
 * The port is deliberately NOT here: `scp` takes uppercase `-P`, `ssh` lowercase `-p`. Each call
 * site adds its own letter, so neither can silently inherit the other's.
 */
export function commonSshArgs(target: SshTarget): string[] {
  return [
    "-o",
    `ConnectTimeout=${target.connectTimeoutSec}`,
    "-o",
    "BatchMode=yes",
    "-i",
    target.sshKeyPath,
  ];
}

/**
 * POSIX single-quote quoting (R4.2): wraps the value in '…' and turns every ' into '\''.
 * Inside single quotes a POSIX shell interprets nothing ($, `, \, ", newlines…), so the remote
 * shell sees the value byte for byte.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Asks the Kindle whether `remoteFilePath` exists, with `ssh … test -e '<path>'` (R4.1).
 *
 * Resolves `true` on exit 0 (exists, R4.5) and `false` on exit 1 (does not exist, R4.6). Unlike
 * `scp`, these two codes carry meaning here: they come from `test`, not from SSH.
 *
 * Rejects with:
 * - {@link UploadConfigError} if the key is unusable (checked first, `ssh` is not launched, R4.4) or
 *   `ssh` cannot be launched (`error` event, R4.8, names the binary);
 * - {@link UploadFailedError} for any other exit code (SSH's own 255 included), a signal, or no
 *   answer within `timeoutMs` (R4.7).
 */
export async function existsOnKindle(remoteFilePath: string, target: SshTarget): Promise<boolean> {
  await assertKeyUsable(target.sshKeyPath);

  return new Promise<boolean>((resolve, reject) => {
    // Lowercase -p is ssh's port (R4.3); scp's is uppercase -P. The remote command is ONE argument,
    // already quoted: spawn uses no local shell, the quoting protects the Kindle's shell (R4.2).
    const child = spawn(
      SSH_BIN,
      [
        "-p",
        String(target.port),
        ...commonSshArgs(target),
        `${target.kindleUser}@${target.kindleHost}`,
        `test -e ${shellQuote(remoteFilePath)}`,
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
            `${SSH_BIN} did not finish within ${target.timeoutMs} ms and was killed`,
            stderrTail,
          ),
        ),
      );
    }, target.timeoutMs);

    /** Settles the promise once; whichever of timeout / error / close comes first wins. */
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    }

    // R4.8: the binary itself could not be executed (ENOENT / EACCES).
    child.on("error", (err) =>
      finish(() =>
        reject(
          new UploadConfigError(
            "binary-not-found",
            `could not launch "${SSH_BIN}" (${err.message}); is it installed and on the PATH?`,
            { cause: err },
          ),
        ),
      ),
    );

    child.on("close", (code, signal) => {
      if (code === 0) return finish(() => resolve(true));
      if (code === 1) return finish(() => resolve(false));
      const how = code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`;
      const summary = summarizeStderr(stderrTail, 2);
      finish(() =>
        reject(
          new UploadFailedError(
            "exit-code",
            `${SSH_BIN} ${how}${summary === "" ? "" : `: ${summary}`}`,
            stderrTail,
          ),
        ),
      );
    });
  });
}
