import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QueueItem } from "./state.js";

export type Spool = {
  readonly dir: string;
  /** Creates (or empties) the item's directory and returns it, ready for FanFicFare's `outDir`. */
  prepare(id: string): Promise<string>;
  /** Deletes the item's directory and the EPUB in it; a no-op if it is already gone (R5.2, R4.2). */
  discard(id: string): Promise<void>;
  /**
   * Deletes every item directory and loose EPUB not referenced by a restored item; returns the names
   * it removed (R5.3). Entries Bookcarrier did not create are never touched.
   */
  reconcile(items: readonly Pick<QueueItem, "id" | "epubPath">[]): Promise<string[]>;
};

/** Shape of the ids `createQueue` generates (`crypto.randomUUID`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Item ids become directory names: only a single, plain path segment is accepted. */
function assertValidId(id: string): void {
  if (id === "" || id === "." || id === ".." || /[/\\]/.test(id)) {
    throw new Error(`invalid spool id: ${JSON.stringify(id)}`);
  }
}

/**
 * The directory where downloaded EPUBs wait for delivery, by default `~/.bookcarrier/spool/`, never
 * the system's temp directory, which macOS cleans (R5.1).
 *
 * Each request gets its own sub-directory named after its queue id (`<spool>/<id>/<file>.epub`):
 * FanFicFare needs an output directory where its EPUB is the only one, and a per-item directory also
 * keeps two requests for the same work from deleting each other's file.
 */
export function createSpool(dir: string): Spool {
  const itemDir = (id: string): string => {
    assertValidId(id);
    return join(dir, id);
  };

  return {
    dir,

    async prepare(id) {
      const path = itemDir(id);
      await rm(path, { recursive: true, force: true });
      await mkdir(path, { recursive: true });
      return path;
    },

    async discard(id) {
      await rm(itemDir(id), { recursive: true, force: true });
    },

    async reconcile(items) {
      // Only directories that hold a referenced EPUB survive. A download-stage item has no EPUB yet,
      // so its leftover directory is removed too; `prepare` recreates it on the next attempt.
      const keep = new Set(
        items
          .filter((item) => item.epubPath !== undefined && dirname(item.epubPath) === join(dir, item.id))
          .map((item) => item.id),
      );
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      // Only what Bookcarrier itself creates is ever deleted: item directories (named by a uuid) and
      // loose `.epub` files. Anything else is left alone, so a spoolDir pointed at the wrong place
      // (e.g. ~/Documents) cannot lose the owner's files.
      const ours = (name: string): boolean => UUID.test(name) || name.toLowerCase().endsWith(".epub");
      const removed = entries.filter((name) => ours(name) && !keep.has(name));
      await Promise.all(removed.map((name) => rm(join(dir, name), { recursive: true, force: true })));
      return removed;
    },
  };
}
