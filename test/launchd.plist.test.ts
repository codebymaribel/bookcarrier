import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const xml = readFileSync(
  resolve(import.meta.dirname, "..", "launchd", "com.codebymaribel.bookcarrier.plist"),
  "utf8",
).replace(/\s+/g, "");

it("the LaunchAgent template keeps the launchd contract (R7.1–R7.6)", () => {
  expect(xml).toContain("<key>Label</key><string>com.codebymaribel.bookcarrier</string>");
  expect(xml).toContain("<key>RunAtLoad</key><true/>");
  expect(xml).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(xml).toContain("<key>ThrottleInterval</key><integer>10</integer>");
  expect(xml).toContain("<string>/opt/homebrew/opt/node@24/bin/node</string>");
  expect(xml).toMatch(/<key>PATH<\/key><string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/);
  expect(xml).toContain("__HOME__/Library/Logs/Bookcarrier/");
  expect(xml).not.toMatch(/\/Users\//);
});
