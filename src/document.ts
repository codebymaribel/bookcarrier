/**
 * Telegram's limit for bots downloading files (official Bot API): 20 MiB, binary (owner check L3:
 * a 20,333,552-byte file downloads fine). Not config: it is Telegram's, not ours.
 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** The slice of grammY's `Document` that validation needs. Both fields are optional in the API. */
export type DocumentInfo = { file_name?: string; file_size?: number };

export type DocumentCheck =
  | { ok: true; safeName: string; extension: string; folder: string }
  | { ok: false; reason: "unsupported-format" }
  | { ok: false; reason: "too-big"; sizeBytes: number };

/** What FAT32 does not accept in a name: `\ / : * ? " < > |` and control characters (R3.2). */
// eslint-disable-next-line no-control-regex
const FAT_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

const ONLY_DOTS_AND_SPACES = /^[. ]*$/;

/**
 * Turns the sender's `file_name` into the name used on the Kindle, or `undefined` if nothing
 * usable is left (R3.1–R3.4).
 *
 * - Only the part after the last `/` or `\` is kept (R3.1), on every platform.
 * - FAT-forbidden characters become `_`; trailing dots and spaces are removed (R3.2).
 * - Unicode letters are kept, normalized to NFC so the NFD form iOS/macOS may send matches the
 *   same name already on the Kindle (R3.3).
 * - Empty, or nothing but dots and spaces before the extension (`.pdf`, `..pdf`) → `undefined` (R3.4).
 */
export function sanitizeFileName(name: string): string | undefined {
  const base = name.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const safe = base.replace(FAT_FORBIDDEN, "_").replace(TRAILING_DOTS_AND_SPACES, "");
  if (safe === "") return undefined;

  const dot = safe.lastIndexOf(".");
  const stem = dot === -1 ? safe : safe.slice(0, dot);
  if (ONLY_DOTS_AND_SPACES.test(stem)) return undefined;
  return safe;
}

/**
 * Decides whether a document is accepted, and where it goes (R2.2–R2.6, R3.4, R8.6).
 *
 * `folders` is the resolved `documentFolders` config (extension → folder ending in `/`). It is a
 * `Map`, so an extension like `constructor` is never "found" on an object prototype.
 *
 * The format is checked before the size, so a 30 MB `.zip` is "unsupported", not "too big".
 */
export function validateDocument(
  doc: DocumentInfo,
  folders: ReadonlyMap<string, string>,
): DocumentCheck {
  if (doc.file_name === undefined) return { ok: false, reason: "unsupported-format" };

  const safeName = sanitizeFileName(doc.file_name);
  if (safeName === undefined) return { ok: false, reason: "unsupported-format" };

  const dot = safeName.lastIndexOf(".");
  const extension = dot === -1 ? "" : safeName.slice(dot + 1).toLowerCase();
  const folder = folders.get(extension);
  if (extension === "" || folder === undefined) return { ok: false, reason: "unsupported-format" };

  if (doc.file_size !== undefined && doc.file_size > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: "too-big", sizeBytes: doc.file_size };
  }

  return { ok: true, safeName, extension, folder };
}
