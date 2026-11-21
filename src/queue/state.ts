import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";

export type Stage = "download" | "upload";

/** One pending request (design.md, "State shape"). */
export type QueueItem = {
  /** uuid v4, generated on enqueue; also the name of its spool sub-directory. */
  id: string;
  /** Canonical AO3 work URL. */
  url: string;
  /** The stage it is in: only this stage is retried (R3.1). */
  stage: Stage;
  /** Path of the EPUB in the spool; present only when `stage === "upload"`. */
  epubPath?: string;
  /** Known once the download succeeded; used in the delivery and give-up messages. */
  title?: string;
  /** Failed retries so far (the failure that enqueued it is not counted). */
  attempts: number;
  /** Epoch ms of the first enqueue: the basis of the give-up window, never reset. */
  firstQueuedAt: number;
  /** Epoch ms of the next attempt. */
  nextAttemptAt: number;
  /** Last error, for the give-up message (R6.4). */
  lastError: string;
};

/** The whole persisted file. `version` exists so a later format change can recognize old files. */
export type QueueState = {
  version: 1;
  items: QueueItem[];
};

export type ReadResult = {
  state: QueueState;
  /** Set when the file existed but was unreadable: where it was moved to (R2.5). */
  corruptBackup?: string;
};

export type StateStore = {
  read(): Promise<ReadResult>;
  write(state: QueueState): Promise<void>;
};

export function emptyState(): QueueState {
  return { version: 1, items: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === "string";

function isQueueItem(value: unknown): value is QueueItem {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["url"] === "string" &&
    (value["stage"] === "download" || value["stage"] === "upload") &&
    isOptionalString(value["epubPath"]) &&
    isOptionalString(value["title"]) &&
    isFiniteNumber(value["attempts"]) &&
    isFiniteNumber(value["firstQueuedAt"]) &&
    isFiniteNumber(value["nextAttemptAt"]) &&
    typeof value["lastError"] === "string"
  );
}

/** Parses the file's text; `undefined` when it is not JSON or not a version-1 state. */
function parseState(text: string): QueueState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["items"])) return undefined;
  if (!raw["items"].every(isQueueItem)) return undefined;
  return { version: 1, items: raw["items"] };
}

/**
 * Reads and writes the queue's JSON file.
 *
 * - `read()`: a missing file is an empty queue (R2.4). A file that is not valid JSON, or not a
 *   version-1 state, is moved aside to `<path>.corrupt-<now>` so it can be inspected, and the
 *   result says so in `corruptBackup`, so the caller can notify the owner (R2.5). Other read errors
 *   (permissions, I/O) are thrown: silently starting empty would drop the owner's requests.
 * - `write()`: atomic with write-file-atomic (temp file in the same directory + fsync + rename),
 *   so a crash never leaves a truncated file (R2.2). Writes are chained, so two concurrent calls run
 *   in order and the last one wins; a failed write rejects its caller without breaking the chain.
 */
export function createStateStore(path: string, now: () => number = Date.now): StateStore {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if (isRecord(err) && err["code"] === "ENOENT") return { state: emptyState() };
        throw err;
      }
      const state = parseState(text);
      if (state !== undefined) return { state };
      const corruptBackup = `${path}.corrupt-${now()}`;
      await rename(path, corruptBackup);
      return { state: emptyState(), corruptBackup };
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
