export type LinkResult =
  | { ok: true; workId: string; canonicalUrl: string }
  | { ok: false; reason: "no-ao3-link" | "unsupported-link" };

const AO3_HOSTS: ReadonlySet<string> = new Set(["archiveofourown.org", "www.archiveofourown.org"]);

/** `/works/<id>` or `/works/<id>/chapters/<n>`, optionally under `/collections/<name>`. */
const WORK_PATH = /^(?:\/collections\/[^/]+)?\/works\/(\d+)(?:\/chapters\/\d+)?\/?$/;

/** Anything that looks like `http(s)://…` up to whitespace or a closing quote/bracket. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"]+/gi;

/** Punctuation that usually belongs to the sentence around a URL, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Parses `candidate` as a URL; returns `undefined` if it is not one.
 * Trailing sentence punctuation is stripped first ("see https://…/works/1.").
 */
function parseCandidate(candidate: string): URL | undefined {
  try {
    return new URL(candidate.replace(TRAILING_PUNCTUATION, ""));
  } catch {
    return undefined;
  }
}

/**
 * Finds the AO3 work link inside a message (R2.1–R2.6).
 *
 * URLs are found by parsing, not by matching the whole text, and the hostname must be exactly
 * `archiveofourown.org` or `www.archiveofourown.org`: `evil.example/archiveofourown.org/works/1`,
 * `archiveofourown.org.evil.com` and `archiveofourown.org@evil.com` are all rejected. The first AO3
 * URL in the text decides (R2.5); query string and fragment are ignored.
 *
 * - `no-ao3-link` (R2.2): no URL at all, or only URLs from other sites.
 * - `unsupported-link` (R2.3): an AO3 URL that is not an individual work (series, collection page,
 *   user page…).
 * - `canonicalUrl` is always `https://archiveofourown.org/works/<id>` (R2.6).
 */
export function extractWorkLink(text: string): LinkResult {
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    const url = parseCandidate(candidate);
    if (url === undefined || !AO3_HOSTS.has(url.hostname)) continue;

    const workId = WORK_PATH.exec(url.pathname)?.[1];
    if (workId === undefined) return { ok: false, reason: "unsupported-link" };
    return { ok: true, workId, canonicalUrl: `https://archiveofourown.org/works/${workId}` };
  }
  return { ok: false, reason: "no-ao3-link" };
}
