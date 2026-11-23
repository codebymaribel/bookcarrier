/** A fic's status on AO3, as FanFicFare reports it (R2.4). */
export type FicStatus = "in-progress" | "completed" | "unknown";

/** What Bookcarrier knows about a delivered AO3 fic, read from FanFicFare's metadata (R2.1). */
export type FicMeta = {
  /** AO3 work id, digits only. The key of a follow. */
  workId: string;
  /** Canonical work URL (`https://archiveofourown.org/works/<id>`). */
  url: string;
  title: string;
  author: string;
  /** Published chapters, a positive integer. */
  chapters: number;
  status: FicStatus;
};

/** The parts of the request the bot already knows, independent of FanFicFare's JSON. */
export type FicLink = { workId: string; url: string; fallbackTitle: string };

/** Digits with optional thousands separators, as FanFicFare's `commaGroups` writes them (research §1). */
const CHAPTER_COUNT = /^\d{1,3}(?:,\d{3})*$|^\d+$/;

function parseChapters(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!CHAPTER_COUNT.test(text)) return undefined;
  const chapters = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(chapters) && chapters > 0 ? chapters : undefined;
}

function parseStatus(value: unknown): FicStatus {
  if (value === "Completed") return "completed";
  if (value === "In-Progress") return "in-progress";
  return "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Reads the fields Bookcarrier needs from FanFicFare's `--json-meta-file` output.
 *
 * Returns `undefined` when `raw` is not an object or `numChapters` is not a positive integer (R2.2,
 * R2.3): without a chapter count there is nothing to follow. `workId` and `url` always come from the
 * link the bot parsed, so a follow is keyed exactly like the rest of the bot; `title` falls back to
 * the downloader's title, `author` to `""`; an unrecognized status becomes `unknown` (R2.4).
 */
export function parseFicMeta(raw: unknown, link: FicLink): FicMeta | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const fields = raw as Record<string, unknown>;
  const chapters = parseChapters(fields["numChapters"]);
  if (chapters === undefined) return undefined;
  return {
    workId: link.workId,
    url: link.url,
    title: nonEmptyString(fields["title"]) ?? link.fallbackTitle,
    author: nonEmptyString(fields["author"]) ?? "",
    chapters,
    status: parseStatus(fields["status"]),
  };
}
