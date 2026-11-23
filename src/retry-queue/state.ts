import { createJsonFileStore, type JsonFileStore, type JsonReadResult } from "../shared/index.js";

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
  /**
   * Set once AO3's rate limit outlasted the short retry window: the item is then retried every few
   * hours instead of along the backoff ladder (rate-limit deferral, S1). Absent on ordinary items.
   */
  deferred?: boolean;
};

/** The whole persisted file. `version` exists so a later format change can recognize old files. */
export type QueueState = {
  version: 1;
  items: QueueItem[];
};

/** `corruptBackup` is set when the file existed but was unreadable: where it was moved to (R2.5). */
export type ReadResult = JsonReadResult<QueueState>;

export type StateStore = JsonFileStore<QueueState>;

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
    typeof value["lastError"] === "string" &&
    (value["deferred"] === undefined || typeof value["deferred"] === "boolean")
  );
}

/** Validates the parsed JSON; `undefined` when it is not a version-1 state. */
function parseState(raw: unknown): QueueState | undefined {
  if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["items"])) return undefined;
  if (!raw["items"].every(isQueueItem)) return undefined;
  return { version: 1, items: raw["items"] };
}

/**
 * Reads and writes the queue's JSON file, through {@link createJsonFileStore}.
 *
 * - `read()`: a missing file is an empty queue (R2.4). A file that is not valid JSON, or not a
 *   version-1 state, is moved aside to `<path>.corrupt-<now>` and reported in `corruptBackup`, so
 *   the caller can notify the owner (R2.5). Other read errors are thrown.
 * - `write()`: atomic and chained (R2.2); see {@link createJsonFileStore}.
 */
export function createStateStore(path: string, now: () => number = Date.now): StateStore {
  return createJsonFileStore(path, parseState, emptyState, now);
}
