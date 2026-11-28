import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";

export type JsonReadResult<T> = {
  state: T;
  /** Set when the file existed but was unreadable: where it was moved to. */
  corruptBackup?: string;
};

export type JsonFileStore<T> = {
  read(): Promise<JsonReadResult<T>>;
  write(state: T): Promise<void>;
};

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as Record<string, unknown>)["code"] === code;
}

/**
 * Reads and writes one JSON state file. Shared by the retry queue and the followed fics.
 *
 * - `read()`: a missing file is `empty()`. A file that is not JSON, or that `parse` rejects
 *   (`undefined`, which is also how a wrong `version` is reported), is moved aside to
 *   `<path>.corrupt-<now>` so it can be inspected, and `corruptBackup` says so; the state is then
 *   `empty()`. Other read errors (permissions, I/O) are thrown: silently starting empty would drop
 *   the owner's data.
 * - `write()`: atomic with write-file-atomic (temp file in the same directory + fsync + rename), so
 *   a crash never leaves a truncated file. Writes are chained, so two concurrent calls run in order
 *   and the last one wins; a failed write rejects its caller without breaking the chain.
 */
export function createJsonFileStore<T>(
  path: string,
  parse: (raw: unknown) => T | undefined,
  empty: () => T,
  now: () => number = Date.now,
): JsonFileStore<T> {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if (isErrnoCode(err, "ENOENT")) return { state: empty() };
        throw err;
      }
      let raw: unknown;
      let state: T | undefined;
      try {
        raw = JSON.parse(text);
        state = parse(raw);
      } catch {
        state = undefined;
      }
      if (state !== undefined) return { state };
      const corruptBackup = `${path}.corrupt-${now()}`;
      await rename(path, corruptBackup);
      return { state: empty(), corruptBackup };
    },

    write(state) {
      const run = async (): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
      };
      const result = chain.then(run, run);
      chain = result.catch(() => undefined);
      return result;
    },
  };
}
