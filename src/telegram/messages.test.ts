import { describe, expect, it } from "vitest";
import { documentFailureMessage, messages } from "./messages.js";
import { TelegramDownloadError, TelegramFileTooBigError } from "../documents/telegram-file.js";
import { UploadConfigError, UploadFailedError } from "../kindle/uploader.js";

const MB = 1024 * 1024;

describe("document messages (R2.3, R2.5, R5, R7)", () => {
  it("unsupportedFormat lists the formats it is given, upper-cased (R2.3)", () => {
    expect(messages.unsupportedFormat(["epub", "mobi", "pdf"])).toBe(
      "I can't send that kind of file. Send me one of: EPUB, MOBI, PDF.",
    );
    expect(messages.unsupportedFormat(["epub", "pdf"])).toContain("EPUB, PDF.");
  });

  it("tooBig states the size and the 20 MB limit when the size is known (R2.5)", () => {
    expect(messages.tooBig(25 * MB)).toBe(
      "That file is 25 MB; I can only fetch files up to 20 MB from Telegram.",
    );
    expect(messages.tooBig(Math.round(25.3 * MB))).toContain("25.3 MB");
  });

  it("tooBig without a known size omits the number (R6.4)", () => {
    const text = messages.tooBig();
    expect(text).toBe("That file is too big; I can only fetch files up to 20 MB from Telegram.");
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it("the name-carrying texts include the name", () => {
    expect(messages.alreadyExists("Libro.epub")).toBe("“Libro.epub” is already on your Kindle. Replace it?");
    expect(messages.overwriteCancelled("Libro.epub")).toBe(
      "OK, I left “Libro.epub” as it was. Nothing was sent.",
    );
    expect(messages.docDelivered("Dune_ Messiah.epub")).toBe("Delivered “Dune_ Messiah.epub” to your Kindle.");
    expect(messages.docSendFailed("Libro.epub", "timed out")).toBe(
      "I couldn't send “Libro.epub” to your Kindle (timed out). Is it awake and on the Wi-Fi? Send me the file again when it is.",
    );
    expect(messages.docDownloadFailed("HTTP 404")).toBe("I couldn't get that file from Telegram: HTTP 404");
    expect(messages.docAck).toBe("Got it, checking your Kindle…");
    expect(messages.confirmationExpired).toBe("That request is no longer pending. Send me the file again.");
  });

  it("no document text mentions a link or a fic (those are the fics' texts)", () => {
    const texts = [
      messages.docAck,
      messages.unsupportedFormat(["epub", "mobi", "pdf"]),
      messages.tooBig(25 * MB),
      messages.tooBig(),
      messages.alreadyExists("x.pdf"),
      messages.overwriteCancelled("x.pdf"),
      messages.confirmationExpired,
      messages.docDelivered("x.pdf"),
      messages.docDownloadFailed("d"),
      messages.docSendFailed("x.pdf", "d"),
    ];
    for (const t of texts) expect(t).not.toMatch(/\b(links?|fics?)\b/i);
  });
});

describe("documentFailureMessage (R6.3, R6.4, R7.3, R7.4)", () => {
  it("TelegramFileTooBigError → tooBig without a size", () => {
    expect(documentFailureMessage(new TelegramFileTooBigError("too big"), "x.pdf")).toBe(messages.tooBig());
  });

  it("TelegramDownloadError → docDownloadFailed with its message", () => {
    const err = new TelegramDownloadError("http", "HTTP 404 downloading documents/file_0.pdf");
    expect(documentFailureMessage(err, "x.pdf")).toBe(messages.docDownloadFailed(err.message));
  });

  it("UploadConfigError → uploadConfig", () => {
    const err = new UploadConfigError("binary-not-found", "ssh not found");
    expect(documentFailureMessage(err, "x.pdf")).toBe(messages.uploadConfig(err.message));
  });

  it("UploadFailedError → docSendFailed with the name", () => {
    const err = new UploadFailedError("exit-code", "Operation timed out");
    expect(documentFailureMessage(err, "Libro.epub")).toBe(messages.docSendFailed("Libro.epub", err.message));
  });

  it("anything else → unexpected", () => {
    expect(documentFailureMessage(new Error("bug"), "x.pdf")).toBe(messages.unexpected);
    expect(documentFailureMessage("not even an error", "x.pdf")).toBe(messages.unexpected);
  });
});
