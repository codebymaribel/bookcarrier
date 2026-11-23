import { describe, expect, it } from "vitest";
import { createLogger, formatLine, type LogLevel } from "./logger.js";

const FIXED = new Date("2026-11-17T12:00:00.000Z");

function capture() {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const log = createLogger({ write: (level, line) => lines.push({ level, line }), now: () => FIXED });
  return { log, lines };
}

describe("logger", () => {
  it("prepends an ISO timestamp and level to every line", () => {
    const { log, lines } = capture();
    log.info("daemon started");
    expect(lines).toEqual([{ level: "info", line: "2026-11-17T12:00:00.000Z INFO  daemon started" }]);
  });

  it("distinguishes the three levels", () => {
    const { log, lines } = capture();
    log.info("a");
    log.warn("b");
    log.error("c");
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
    expect(lines[1]?.line).toContain(" WARN  b");
    expect(lines[2]?.line).toContain(" ERROR c");
  });

  it("appends meta as JSON and serializes Errors without stack", () => {
    const line = formatLine(FIXED, "error", "failed", { err: new Error("boom"), code: 1 });
    expect(line).toBe(
      '2026-11-17T12:00:00.000Z ERROR failed {"err":{"name":"Error","message":"boom"},"code":1}',
    );
  });

  it("omits empty meta", () => {
    expect(formatLine(FIXED, "info", "x", {})).toBe("2026-11-17T12:00:00.000Z INFO  x");
  });
});
