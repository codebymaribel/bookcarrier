import { describe, expect, it } from "vitest";
import { extractWorkLink } from "./ao3-link.js";

const ok = (workId: string) => ({
  ok: true,
  workId,
  canonicalUrl: `https://archiveofourown.org/works/${workId}`,
});
const rejected = (reason: "no-ao3-link" | "unsupported-link") => ({ ok: false, reason });

describe("extractWorkLink — basic cases (R2.1–R2.3)", () => {
  it("accepts a plain work URL", () => {
    expect(extractWorkLink("https://archiveofourown.org/works/61265059")).toEqual(ok("61265059"));
  });

  it("text with no URL → no-ao3-link", () => {
    expect(extractWorkLink("hello there")).toEqual(rejected("no-ao3-link"));
    expect(extractWorkLink("")).toEqual(rejected("no-ao3-link"));
  });

  it("URL from another site → no-ao3-link", () => {
    expect(extractWorkLink("https://example.com/works/123")).toEqual(rejected("no-ao3-link"));
  });

  it("AO3 series → unsupported-link", () => {
    expect(extractWorkLink("https://archiveofourown.org/series/456")).toEqual(
      rejected("unsupported-link"),
    );
  });

  it("AO3 user page and collection page → unsupported-link", () => {
    expect(extractWorkLink("https://archiveofourown.org/users/someone")).toEqual(
      rejected("unsupported-link"),
    );
    expect(extractWorkLink("https://archiveofourown.org/collections/some_coll")).toEqual(
      rejected("unsupported-link"),
    );
  });
});

describe("extractWorkLink — real Android share text (manual test 3)", () => {
  it("finds the URL on the second line, after the title", () => {
    const shared =
      "Rio, Rio - carsynmerrill (onthepitch) - Agatha All Along (TV) [Archive of Our Own]\n" +
      "https://archiveofourown.org/works/61265059";
    expect(extractWorkLink(shared)).toEqual(ok("61265059"));
  });
});

describe("extractWorkLink — accepted forms (R2.4)", () => {
  it.each([
    "https://archiveofourown.org/works/65164981/chapters/167610601",
    "https://archiveofourown.org/collections/some_coll/works/65164981",
    "https://www.archiveofourown.org/works/65164981",
    "http://archiveofourown.org/works/65164981",
    "https://archiveofourown.org/works/65164981?view_adult=true",
    "https://archiveofourown.org/works/65164981#comments",
    "https://archiveofourown.org/works/65164981/",
    "HTTPS://ARCHIVEOFOUROWN.ORG/works/65164981",
  ])("%s → work 65164981", (input) => {
    expect(extractWorkLink(input)).toEqual(ok("65164981"));
  });

  it("ignores sentence punctuation stuck to the URL", () => {
    expect(extractWorkLink("read this: https://archiveofourown.org/works/7.")).toEqual(ok("7"));
    expect(extractWorkLink("(https://archiveofourown.org/works/7)")).toEqual(ok("7"));
  });

  it("a /works path with no numeric id is unsupported", () => {
    expect(extractWorkLink("https://archiveofourown.org/works/search?q=x")).toEqual(
      rejected("unsupported-link"),
    );
    expect(extractWorkLink("https://archiveofourown.org/works/123/bookmarks")).toEqual(
      rejected("unsupported-link"),
    );
  });
});

describe("extractWorkLink — hostname must be exact (R2.4)", () => {
  it.each([
    "https://evil.example/archiveofourown.org/works/1",
    "https://notarchiveofourown.org/works/1",
    "https://archiveofourown.org.evil.com/works/1",
    "https://archiveofourown.org@evil.com/works/1",
    "https://evil.example/?next=archiveofourown.org/works/1",
  ])("%s → no-ao3-link", (input) => {
    expect(extractWorkLink(input)).toEqual(rejected("no-ao3-link"));
  });
});

describe("extractWorkLink — several links (R2.5)", () => {
  it("uses the first AO3 URL and ignores the rest", () => {
    const text =
      "https://archiveofourown.org/works/111 and https://archiveofourown.org/works/222";
    expect(extractWorkLink(text)).toEqual(ok("111"));
  });

  it("skips URLs from other sites before the first AO3 one", () => {
    const text = "https://example.com/x https://archiveofourown.org/works/333";
    expect(extractWorkLink(text)).toEqual(ok("333"));
  });

  it("the first AO3 URL decides, even if it is not a work", () => {
    const text = "https://archiveofourown.org/series/9 https://archiveofourown.org/works/444";
    expect(extractWorkLink(text)).toEqual(rejected("unsupported-link"));
  });
});

describe("extractWorkLink — canonical URL (R2.6)", () => {
  it.each([
    "https://archiveofourown.org/works/555/chapters/9?view_adult=true#top",
    "https://www.archiveofourown.org/collections/c/works/555",
    "http://archiveofourown.org/works/555/",
  ])("%s → https://archiveofourown.org/works/555", (input) => {
    const result = extractWorkLink(input);
    expect(result.ok && result.canonicalUrl).toBe("https://archiveofourown.org/works/555");
  });
});
