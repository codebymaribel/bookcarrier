import { describe, expect, it } from "vitest";
import { MAX_DOWNLOAD_BYTES, sanitizeFileName, validateDocument } from "../src/document.js";

const MiB = 1024 * 1024;

/** The default `documentFolders` (R8.2), as config.ts resolves it. */
const DEFAULT_FOLDERS: ReadonlyMap<string, string> = new Map([
  ["epub", "/mnt/us/documents/books/"],
  ["mobi", "/mnt/us/documents/books/"],
  ["pdf", "/mnt/us/documents/books/"],
]);

describe("sanitizeFileName — path traversal (R3.1)", () => {
  it.each([
    ["../../x.pdf", "x.pdf"],
    ["a/b.pdf", "b.pdf"],
    ["a\\b.pdf", "b.pdf"],
  ])("%s → %s", (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});

describe("sanitizeFileName — FAT characters (R3.2)", () => {
  it("Dune: Messiah.epub → Dune_ Messiah.epub", () => {
    expect(sanitizeFileName("Dune: Messiah.epub")).toBe("Dune_ Messiah.epub");
  });

  it.each(["*", "?", '"', "<", ">", "|", "\u0000", "\u0001", "\u001f", "\n", "\u007f"])(
    "%j → _",
    (ch) => {
      expect(sanitizeFileName(`a${ch}b.pdf`)).toBe("a_b.pdf");
    },
  );

  it("keeps an inner dot followed by a space", () => {
    expect(sanitizeFileName("name. .pdf")).toBe("name. .pdf");
  });

  it("removes trailing dots and spaces", () => {
    expect(sanitizeFileName("name.pdf. ")).toBe("name.pdf");
    expect(sanitizeFileName("name.pdf...")).toBe("name.pdf");
  });
});

describe("sanitizeFileName — Unicode (R3.3)", () => {
  it("keeps the accent", () => {
    expect(sanitizeFileName("Corazón.pdf")).toBe("Corazón.pdf");
  });

  it("the NFD form comes out identical to the NFC form", () => {
    const nfc = "Corazón.pdf".normalize("NFC");
    const nfd = "Corazón.pdf".normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(sanitizeFileName(nfd)).toBe(nfc);
  });
});

describe("sanitizeFileName — nothing left (R3.4)", () => {
  it.each(["", ".pdf", "..pdf", "   .pdf", "a/", "...", "  "])("%j → undefined", (input) => {
    expect(sanitizeFileName(input)).toBeUndefined();
  });
});

describe("validateDocument — accepted formats (R2.2)", () => {
  it("MAX_DOWNLOAD_BYTES is 20 MiB (Bot API limit, L3)", () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(20_971_520);
  });

  it.each([
    ["book.epub", "epub"],
    ["Book.MOBI", "mobi"],
    ["Report.PDF", "pdf"],
  ])("%s → ok, extension %s, folder from the map", (file_name, extension) => {
    expect(validateDocument({ file_name }, DEFAULT_FOLDERS)).toEqual({
      ok: true,
      safeName: file_name,
      extension,
      folder: "/mnt/us/documents/books/",
    });
  });

  it("returns the sanitized name (R3.5)", () => {
    expect(validateDocument({ file_name: "Dune: Messiah.epub" }, DEFAULT_FOLDERS)).toEqual({
      ok: true,
      safeName: "Dune_ Messiah.epub",
      extension: "epub",
      folder: "/mnt/us/documents/books/",
    });
  });
});

describe("validateDocument — unsupported (R2.3, R2.6, R3.4)", () => {
  it.each(["book.azw3", "photo.jpg", "no-extension", "x.mp4", "x.gif", "x.constructor"])(
    "%s → unsupported-format",
    (file_name) => {
      expect(validateDocument({ file_name }, DEFAULT_FOLDERS)).toEqual({
        ok: false,
        reason: "unsupported-format",
      });
    },
  );

  it("no file_name → unsupported-format", () => {
    expect(validateDocument({}, DEFAULT_FOLDERS)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
    expect(validateDocument({ file_size: 10 }, DEFAULT_FOLDERS)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
  });

  it("a name that sanitizes to nothing → unsupported-format", () => {
    expect(validateDocument({ file_name: "..pdf" }, DEFAULT_FOLDERS)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
  });
});

describe("validateDocument — size (R2.5)", () => {
  it("25 MiB .pdf → too-big with the size", () => {
    const sizeBytes = 25 * MiB;
    expect(validateDocument({ file_name: "x.pdf", file_size: sizeBytes }, DEFAULT_FOLDERS)).toEqual(
      { ok: false, reason: "too-big", sizeBytes },
    );
  });

  it("one byte over 20 MiB → too-big", () => {
    const sizeBytes = 20 * MiB + 1;
    expect(validateDocument({ file_name: "x.pdf", file_size: sizeBytes }, DEFAULT_FOLDERS)).toEqual(
      { ok: false, reason: "too-big", sizeBytes },
    );
  });

  it("a 20,333,552-byte PDF (over 20,000,000 but under 20 MiB, L3) → ok", () => {
    expect(
      validateDocument({ file_name: "x.pdf", file_size: 20_333_552 }, DEFAULT_FOLDERS).ok,
    ).toBe(true);
  });

  it("exactly 20 MiB → ok", () => {
    expect(validateDocument({ file_name: "x.pdf", file_size: 20 * MiB }, DEFAULT_FOLDERS).ok).toBe(
      true,
    );
  });

  it("no file_size → ok", () => {
    expect(validateDocument({ file_name: "x.pdf" }, DEFAULT_FOLDERS).ok).toBe(true);
  });

  it("a 30 MiB .zip → unsupported-format, not too-big (format first)", () => {
    expect(validateDocument({ file_name: "x.zip", file_size: 30 * MiB }, DEFAULT_FOLDERS)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
  });
});

describe("validateDocument — custom map (R8.6)", () => {
  const custom: ReadonlyMap<string, string> = new Map([["pdf", "/a/"]]);

  it("book.epub → unsupported-format", () => {
    expect(validateDocument({ file_name: "book.epub" }, custom)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
  });

  it("x.pdf → folder /a/", () => {
    expect(validateDocument({ file_name: "x.pdf" }, custom)).toEqual({
      ok: true,
      safeName: "x.pdf",
      extension: "pdf",
      folder: "/a/",
    });
  });
});
