import { describe, expect, it } from "vitest";
import { followsMessages as messages } from "./index.js";

describe("follow messages (R3.3, R3.4, R3.6, R4, R5.2, R8.1)", () => {
  const TITLE = "A_B *C* [D](x)";

  it("nowFollowing states the title and the chapter count", () => {
    expect(messages.nowFollowing("T", 12)).toBe("Following “T” — 12 chapters delivered.");
    expect(messages.nowFollowing("T", 1)).toContain("1 chapter delivered");
    expect(messages.nowFollowing("T", 1)).not.toContain("1 chapters");
  });

  it("titles are kept literally, with no escaping or markup", () => {
    for (const text of [messages.nowFollowing(TITLE, 3), messages.alreadyFollowing(TITLE), messages.unfollowed(TITLE)]) {
      expect(text).toContain(TITLE);
      expect(text).not.toContain("\\");
    }
  });

  it("alreadyFollowing and unfollowed keep their exact text", () => {
    expect(messages.alreadyFollowing("T")).toBe("You're already following “T”.");
    expect(messages.unfollowed("T")).toBe("OK, I'm no longer following “T”.");
  });

  it("followsFileCorrupt names the backup path", () => {
    expect(messages.followsFileCorrupt("/x/follows.json.corrupt-1")).toBe(
      "The file with your followed fics was unreadable, so I started with none followed. " +
        "The old file was kept as /x/follows.json.corrupt-1 so it can be inspected.",
    );
  });

  it("the remaining texts say what to do", () => {
    expect(messages.notFollowing()).toBe("I wasn't following that fic, so nothing changed.");
    expect(messages.followUnknown()).toBe("I don't have that fic any more. Send me its link again to follow it.");
    expect(messages.followSaveFailed()).toBe("I couldn't save that just now. Try the button again in a moment.");
  });
});
