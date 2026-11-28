import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { appendTail, summarizeStderr } from "../shared/index.js";
import { type FicMeta, parseFicMeta } from "./fic-meta.js";

export const FANFICFARE_BIN = "fanficfare";

/**
 * FanFicFare's own template, NOT a JS template string: FanFicFare expands `${storyId}`, `${title}`
 * and `${formatext}` itself, and sanitizes the result with its `output_filename_safepattern` (R4.1, R4.2).
 */
const OUTPUT_FILENAME_ARG = "output_filename=${storyId}-${title}${formatext}";

export type DownloadOptions = {
  timeoutMs: number;
  /**
   * AO3 work id of the link being downloaded (feature 5). With it, the chapter metadata FanFicFare
   * writes is read into `meta`; without it the metadata file is ignored.
   */
  workId?: string;
};
export type DownloadResult = {
  filePath: string;
  title: string;
  /** Chapter metadata (R2.1); absent when it could not be read, see `metaWarning` (R2.3). */
  meta?: FicMeta;
  /** Why `meta` is absent, naming the work id; for the caller to log. Never fails the download. */
  metaWarning?: string;
};

export type DownloadFailureReason = "exit-code" | "timeout" | "no-file" | "multiple-files";

/** The download ran and failed (R3.3, R3.4). Possibly transient: AO3 down, 429, timeout. */
export class DownloadFailedError extends Error {
  readonly reason: DownloadFailureReason;
  /** Tail of FanFicFare's stderr (may be a Python traceback): for the logs, never for the owner. */
  readonly stderr: string;

  constructor(reason: DownloadFailureReason, message: string, stderr = "") {
    super(message);
    this.name = "DownloadFailedError";
    this.reason = reason;
    this.stderr = stderr;
  }
}

/**
 * FanFicFare could not even be launched (R3.5): `spawn` emitted `error`, typically `ENOENT`.
 * An installation/PATH problem, deliberately a different class from {@link DownloadFailedError}.
 */
export class DownloadLaunchError extends Error {
  readonly binary: string;

  constructor(binary: string, cause: Error) {
    super(`could not launch "${binary}" (${cause.message}); is it installed and on the PATH?`, {
      cause,
    });
    this.name = "DownloadLaunchError";
    this.binary = binary;
  }
}

/**
 * Derives the display title from FanFicFare's file name: strips the `<storyId>-` prefix and the
 * extension. Best-effort (design.md): accents come out as `_` because FanFicFare sanitized them.
 */
function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.slice(0, fileName.length - extname(fileName).length);
  return /^\d+-(.+)$/.exec(withoutExt)?.[1] ?? withoutExt;
}

/**
 * Finds the one non-empty `.epub` FanFicFare left in `outDir` (R3.2, R3.3). The directory is
 * exclusive to this request, so any count other than one is an error; other files are ignored.
 */
async function findEpub(outDir: string): Promise<DownloadResult> {
  const epubs = (await readdir(outDir)).filter((name) => extname(name).toLowerCase() === ".epub");
  if (epubs.length > 1) {
    throw new DownloadFailedError(
      "multiple-files",
      `${FANFICFARE_BIN} left ${epubs.length} EPUB files in ${outDir}; expected exactly one`,
    );
  }
  const fileName = epubs[0];
  if (fileName === undefined) {
    throw new DownloadFailedError("no-file", `${FANFICFARE_BIN} finished but left no EPUB in ${outDir}`);
  }
  const filePath = join(outDir, fileName);
  if ((await stat(filePath)).size === 0) {
    throw new DownloadFailedError("no-file", `${FANFICFARE_BIN} left an empty EPUB: ${fileName}`);
  }
  return { filePath, title: titleFromFileName(fileName) };
}

/**
 * Reads `<epub>.json`, FanFicFare's `--json-meta-file` output (R2.1). Never throws: any problem
 * (missing, unreadable, invalid JSON, no usable `numChapters`) becomes a `metaWarning` (R2.3).
 */
async function readMeta(result: DownloadResult, url: string, workId: string): Promise<DownloadResult> {
  const warn = (why: string): DownloadResult => ({
    ...result,
    metaWarning: `no chapter metadata for work ${workId}: ${why}`,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(`${result.filePath}.json`, "utf8"));
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
  const meta = parseFicMeta(raw, { workId, url, fallbackTitle: result.title });
  return meta === undefined ? warn("invalid or missing numChapters") : { ...result, meta };
}

/**
 * Downloads a fic as EPUB with FanFicFare, as an async subprocess (R3.1).
 *
 * `outDir` must be an empty directory exclusive to this request. FanFicFare names the file itself;
 * afterwards we pick up the single `.epub` it left there instead of predicting the name. With
 * `opts.workId` the `<epub>.json` metadata is read too; its failure never fails the download (R2.3).
 *
 * Rejects with:
 * - {@link DownloadLaunchError} if the process could not be launched (R3.5), checked separately
 *   from the exit code because it is a different kind of problem;
 * - {@link DownloadFailedError} for a non-zero exit, a timeout (R3.4, the process is killed) or a
 *   missing/empty/ambiguous result (R3.3).
 */
export function downloadEpub(
  url: string,
  outDir: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve, reject) => {
    // stdin closed + --non-interactive (R3.6): a prompt fails fast instead of waiting for the timeout.
    const child = spawn(
      FANFICFARE_BIN,
      [url, "-f", "epub", "--non-interactive", "-o", OUTPUT_FILENAME_ARG, "--json-meta-file"],
      { cwd: outDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let stderrTail = "";

    // Both pipes must be consumed or the child can block on a full pipe buffer.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new DownloadFailedError(
            "timeout",
            `${FANFICFARE_BIN} did not finish within ${opts.timeoutMs} ms and was killed`,
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

    // R3.5: the process could not be launched at all.
    child.on("error", (err) => finish(() => reject(new DownloadLaunchError(FANFICFARE_BIN, err))));

    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const how = code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`;
        const summary = summarizeStderr(stderrTail);
        const detail = summary === "" ? "" : `: ${summary}`;
        finish(() =>
          reject(
            new DownloadFailedError("exit-code", `${FANFICFARE_BIN} ${how}${detail}`, stderrTail),
          ),
        );
        return;
      }
      clearTimeout(timer);
      findEpub(outDir)
        .then((found) => (opts.workId === undefined ? found : readMeta(found, url, opts.workId)))
        .then(
          (result) => finish(() => resolve(result)),
          (err: unknown) => finish(() => reject(err)),
        );
    });
  });
}
