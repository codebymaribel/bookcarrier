import { describe, expect, it } from "vitest";
import { messages } from "./messages.js";

// uploadConfig and unexpected are re-exposed from the kindle and shared contexts; pin their exact
// wording here so a change over there cannot silently alter what the owner reads about a fic.
describe("fic messages re-exposed from other contexts", () => {
  it("uploadConfig keeps its exact text", () => {
    expect(messages.uploadConfig("SSH key not found: /keys/kindle")).toBe(
      "I can't send to the Kindle because of a configuration problem: SSH key not found: /keys/kindle",
    );
  });

  it("unexpected keeps its exact text", () => {
    expect(messages.unexpected).toBe("Something unexpected went wrong. Check the logs.");
  });
});

describe("delivery texts of followed fics (feature 5, R6.2, R6.4, R8.1)", () => {
  const TITLE = "A_B *C* [D](x)";

  it("deliveredFollowUpdated says delivered, follow updated and the new count", () => {
    expect(messages.deliveredFollowUpdated("T", 14)).toBe(
      "Delivered “T” to your Kindle. I updated your follow: now 14 chapters.",
    );
    expect(messages.deliveredFollowUpdated("T", 1)).toContain("now 1 chapter.");
  });

  it("deliveredCompletedUnfollowed says delivered, complete and no longer followed", () => {
    expect(messages.deliveredCompletedUnfollowed("T")).toBe(
      "Delivered “T” to your Kindle. It's complete now, so I'm no longer following it.",
    );
  });

  it("titles are kept literally, with no escaping or markup", () => {
    for (const text of [messages.deliveredFollowUpdated(TITLE, 14), messages.deliveredCompletedUnfollowed(TITLE)]) {
      expect(text).toContain(TITLE);
      expect(text).not.toContain("\\");
    }
  });
});
