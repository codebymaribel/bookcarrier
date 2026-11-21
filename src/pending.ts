import { randomBytes } from "node:crypto";

/** What is needed to continue after "Replace": never the file itself (R5.2). */
export type PendingOverwrite = { fileId: string; safeName: string; folder: string };

export type PendingStore = {
  /** Stores an entry and returns its short id. Drops expired entries first. */
  add(entry: PendingOverwrite): string;
  /** Removes and returns the entry; undefined if it never existed, was taken, or expired. */
  take(id: string): PendingOverwrite | undefined;
  /** How many entries are held right now (expired ones included until the next `add`). */
  size(): number;
};

export type PendingStoreOptions = {
  ttlMs: number;
  now?: () => number;
  newId?: () => string;
};

/** 6 random bytes → 8 characters of `[A-Za-z0-9_-]`; `ow:<id>:y` stays far under 64 bytes (R5.3). */
function defaultNewId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * In-memory store of pending overwrite confirmations (R5.2, R5.7–R5.10).
 *
 * Expiry is lazy, with no timers: `take` refuses an entry older than `ttlMs`, and `add` sweeps out
 * expired ones. `take` always removes the entry, so a double tap acts once. Nothing is persisted.
 */
export function createPendingStore(opts: PendingStoreOptions): PendingStore {
  const { ttlMs, now = Date.now, newId = defaultNewId } = opts;
  const entries = new Map<string, { entry: PendingOverwrite; createdAt: number }>();

  const isExpired = (createdAt: number): boolean => now() - createdAt > ttlMs;

  return {
    add(entry) {
      for (const [id, item] of entries) {
        if (isExpired(item.createdAt)) entries.delete(id);
      }
      let id = newId();
      while (entries.has(id)) id = newId();
      entries.set(id, { entry, createdAt: now() });
      return id;
    },

    take(id) {
      const item = entries.get(id);
      if (item === undefined) return undefined;
      entries.delete(id);
      return isExpired(item.createdAt) ? undefined : item.entry;
    },

    size() {
      return entries.size;
    },
  };
}
