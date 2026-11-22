import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/ssh.js";

// Its own file on purpose: test/ssh.test.ts mocks node:child_process, and the round trip below needs
// the real `sh`.

describe("shellQuote — exact output (R4.2)", () => {
  it("plain name → wrapped in single quotes", () => {
    expect(shellQuote("name")).toBe("'name'");
  });

  it("it's.pdf → every ' becomes '\\''", () => {
    expect(shellQuote("it's.pdf")).toBe("'it'\\''s.pdf'");
  });

  it("empty string → ''", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("$(rm -rf).pdf and backticks stay literal inside the quotes", () => {
    expect(shellQuote("$(rm -rf).pdf")).toBe("'$(rm -rf).pdf'");
    expect(shellQuote("`id`.pdf")).toBe("'`id`.pdf'");
  });
});

/** Runs `printf %s <quoted>` through a real local POSIX shell and returns what it printed. */
function throughShell(value: string): string {
  return execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
}

describe("shellQuote — round trip through a real sh (R4.2, acceptance criterion 7)", () => {
  it.each([
    ["the hostile mix", "it's $(reboot) `id` \"x\" ; & | * ?"],
    ["it's.pdf", "it's.pdf"],
    ["$(rm -rf).pdf", "$(rm -rf).pdf"],
    ["backticks", "`rm -rf /`.pdf"],
    ["several quotes in a row", "''a'''"],
    ["spaces", "Dune  Messiah .pdf"],
    ["a newline", "line1\nline2.pdf"],
    ["accents", "Corazón ñandú.pdf"],
    ["a leading -", "-n.pdf"],
    ["a full remote path", "/mnt/us/documents/books/it's $(x).pdf"],
    ["the empty string", ""],
  ])("%s comes back byte for byte", (_label, value) => {
    expect(throughShell(value)).toBe(value);
  });
});
