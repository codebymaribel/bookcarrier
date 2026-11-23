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
