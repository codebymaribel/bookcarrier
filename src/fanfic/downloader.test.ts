import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DownloadFailedError,
  DownloadLaunchError,
  downloadEpub,
} from "./downloader.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const URL_ = "https://archiveofourown.org/works/65164981";
const EPUB = "65164981-Title_ Fooled Around (And Fell in Love).epub";

/** Stand-in for a ChildProcess: the test decides when and how it "finishes". */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

let outDir: string;
let child: FakeChild;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "bookcarrier-dl-"));
  child = new FakeChild();
  spawnMock.mockReturnValue(child);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(outDir, { recursive: true, force: true });
});

const start = (timeoutMs = 60_000) => downloadEpub(URL_, outDir, { timeoutMs });

/** Rejection reason of a promise, so a test can inspect the error object. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err,
  );
}

describe("downloadEpub — how FanFicFare is launched", () => {
  it("passes the output_filename template exactly, with no JS interpolation (R4.1)", () => {
    void start().catch(() => {});
    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args] = spawnMock.mock.calls[0] ?? [];
    expect(bin).toBe("fanficfare");
    expect(args).toContain("-o");
    expect(args).toContain("output_filename=${storyId}-${title}${formatext}");
    expect(args).toEqual([
      URL_,
      "-f",
      "epub",
      "--non-interactive",
      "-o",
      "output_filename=${storyId}-${title}${formatext}",
    ]);
  });

  it("is non-interactive with stdin closed, and runs inside outDir (R3.6)", () => {
    void start().catch(() => {});
    const options = spawnMock.mock.calls[0]?.[2];
    expect(options).toEqual({ cwd: outDir, stdio: ["ignore", "pipe", "pipe"] });
  });

  it("uses spawn and returns a promise without waiting for the process (R3.1)", () => {
    const promise = start();
    expect(promise).toBeInstanceOf(Promise);
    expect(spawnMock).toHaveBeenCalledOnce();
    void promise.catch(() => {});
  });
});

describe("downloadEpub — success and result lookup (R3.2, R3.3)", () => {
  it("exit 0 + a single .epub → resolves with its path and a display title", async () => {
    await writeFile(join(outDir, EPUB), "epub-bytes");
    const promise = start();
    child.emit("close", 0, null);
    expect(await promise).toEqual({
      filePath: join(outDir, EPUB),
      title: "Title_ Fooled Around (And Fell in Love)",
    });
  });

  it("falls back to the whole base name when there is no <storyId>- prefix", async () => {
    await writeFile(join(outDir, "Some Title.epub"), "x");
    const promise = start();
    child.emit("close", 0, null);
    expect((await promise).title).toBe("Some Title");
  });

  it("ignores files that are not .epub", async () => {
    await writeFile(join(outDir, EPUB), "x");
    await writeFile(join(outDir, "debug.log"), "noise");
    const promise = start();
    child.emit("close", 0, null);
    expect((await promise).filePath).toBe(join(outDir, EPUB));
  });

  it("exit 0 but zero .epub → rejects as a failed download", async () => {
    const promise = start();
    child.emit("close", 0, null);
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(DownloadFailedError);
    expect(err).toMatchObject({ reason: "no-file" });
  });

  it("exit 0 but an empty .epub → rejects (size must be > 0)", async () => {
    await writeFile(join(outDir, EPUB), "");
    const promise = start();
    child.emit("close", 0, null);
    expect(await rejection(promise)).toMatchObject({ reason: "no-file" });
  });

  it("exit 0 but more than one .epub → rejects", async () => {
    await writeFile(join(outDir, "1-a.epub"), "x");
    await writeFile(join(outDir, "2-b.epub"), "x");
    const promise = start();
    child.emit("close", 0, null);
    expect(await rejection(promise)).toMatchObject({ reason: "multiple-files" });
  });
});

describe("downloadEpub — failures (R3.3, R3.4)", () => {
  it("non-zero exit → rejects with the code and the stderr tail, even if an .epub exists", async () => {
    await writeFile(join(outDir, EPUB), "partial");
    const promise = start();
    child.stderr.write("HTTP Error 429: Too Many Requests");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 1, null);
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(DownloadFailedError);
    expect(err).toMatchObject({ reason: "exit-code" });
    expect(String(err)).toContain("exited with code 1");
    expect(String(err)).toContain("429");
  });

  it("a Python traceback on stderr → the message carries only its last line; the full tail goes to .stderr", async () => {
    const traceback = [
      "Traceback (most recent call last):",
      '  File "/x/fetcher_requests.py", line 160, in request',
      "    raise exceptions.HTTPErrorFFF(",
      "fanficfare.exceptions.HTTPErrorFFF: HTTP Error in FFF '525 Server Error' (525)",
      "",
    ].join("\n");
    const promise = start();
    child.stderr.write(traceback);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 1, null);
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(DownloadFailedError);
    const message = String(err);
    expect(message).toContain("HTTPErrorFFF: HTTP Error in FFF '525 Server Error' (525)");
    expect(message).not.toContain("Traceback");
    expect(message).not.toContain("fetcher_requests.py");
    expect(err).toMatchObject({ stderr: traceback });
  });

  it("caps a very long last line in the message", async () => {
    const promise = start();
    child.stderr.write("x".repeat(1000));
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 1, null);
    expect(String(await rejection(promise)).length).toBeLessThan(400);
  });

  it("killed by a signal (no exit code) → rejects", async () => {
    const promise = start();
    child.emit("close", null, "SIGTERM");
    const err = await rejection(promise);
    expect(err).toMatchObject({ reason: "exit-code" });
    expect(String(err)).toContain("SIGTERM");
  });

  it("timeout exceeded → rejects and kills the process", async () => {
    vi.useFakeTimers();
    const promise = start(5_000);
    const assertion = expect(rejection(promise)).resolves.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a late 'close' after the timeout does not settle the promise twice", async () => {
    vi.useFakeTimers();
    const promise = start(1_000);
    const assertion = expect(rejection(promise)).resolves.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(() => child.emit("close", 0, null)).not.toThrow();
  });

  it("does not kill the process when it finishes in time", async () => {
    vi.useFakeTimers();
    const promise = start(5_000);
    const assertion = expect(rejection(promise)).resolves.toMatchObject({ reason: "exit-code" });
    child.emit("close", 1, null);
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("downloadEpub — cannot be launched (R3.5)", () => {
  it("'error' ENOENT → DownloadLaunchError, distinct from a failed download, naming fanficfare", async () => {
    const promise = start();
    child.emit("error", Object.assign(new Error("spawn fanficfare ENOENT"), { code: "ENOENT" }));
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(DownloadLaunchError);
    expect(err).not.toBeInstanceOf(DownloadFailedError);
    expect(err).toMatchObject({ binary: "fanficfare" });
    expect(String(err)).toContain("fanficfare");
    expect(String(err)).toContain("ENOENT");
  });

  it("is not confused with a non-zero exit code", async () => {
    const launch = start();
    child.emit("error", new Error("spawn fanficfare ENOENT"));
    expect(await rejection(launch)).toBeInstanceOf(DownloadLaunchError);

    child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const exited = start();
    child.emit("close", 127, null);
    expect(await rejection(exited)).toBeInstanceOf(DownloadFailedError);
  });
});
