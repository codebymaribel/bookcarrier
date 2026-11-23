import { describe, expect, it } from "vitest";
import { parseFicMeta } from "./fic-meta.js";

const LINK = {
  workId: "12345678",
  url: "https://archiveofourown.org/works/12345678",
  fallbackTitle: "Fallback_Title",
};

/** A FanFicFare `--json-meta-file` object with just the fields Bookcarrier reads. */
function json(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storyId: "12345678",
    title: "My Fic",
    author: "someone",
    numChapters: "12",
    status: "In-Progress",
    ...overrides,
  };
}

describe("parseFicMeta — chapter count (R2.2)", () => {
  it.each([
    [12, 12],
    ["12", 12],
    ["1,204", 1204],
    [" 7 ", 7],
  ])("numChapters %j → %d", (numChapters, expected) => {
    expect(parseFicMeta(json({ numChapters }), LINK)?.chapters).toBe(expected);
  });

  it.each([[0], [-3], ["0"], ["abc"], [1.5], ["1.5"], [""], [null], [true], ["1,2,3x"]])(
    "numChapters %j → undefined",
    (numChapters) => {
      expect(parseFicMeta(json({ numChapters }), LINK)).toBeUndefined();
    },
  );

  it("missing numChapters → undefined (R2.3)", () => {
    const raw = json();
    delete raw["numChapters"];
    expect(parseFicMeta(raw, LINK)).toBeUndefined();
  });

  it.each([[null], [undefined], ["text"], [42], [[1, 2]]])("non-object input %j → undefined", (raw) => {
    expect(parseFicMeta(raw, LINK)).toBeUndefined();
  });
});

describe("parseFicMeta — status (R2.4)", () => {
  it.each([
    ["Completed", "completed"],
    ["In-Progress", "in-progress"],
    ["Abandoned", "unknown"],
    [undefined, "unknown"],
    [3, "unknown"],
  ])("status %j → %s", (status, expected) => {
    expect(parseFicMeta(json({ status }), LINK)?.status).toBe(expected);
  });
});

describe("parseFicMeta — identity and text fields", () => {
  it("returns the full FicMeta", () => {
    expect(parseFicMeta(json(), LINK)).toEqual({
      workId: "12345678",
      url: "https://archiveofourown.org/works/12345678",
      title: "My Fic",
      author: "someone",
      chapters: 12,
      status: "in-progress",
    });
  });

  it("takes workId and url from the link, not from the JSON", () => {
    const meta = parseFicMeta(json({ storyId: "999", storyUrl: "https://example.com/x" }), LINK);
    expect(meta?.workId).toBe("12345678");
    expect(meta?.url).toBe("https://archiveofourown.org/works/12345678");
  });

  it("missing or empty title → the fallback title; missing author → empty string", () => {
    const raw = json({ title: "" });
    delete raw["author"];
    const meta = parseFicMeta(raw, LINK);
    expect(meta?.title).toBe("Fallback_Title");
    expect(meta?.author).toBe("");
  });
});
