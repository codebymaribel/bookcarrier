import { describe, expect, it } from "vitest";
import { DownloadFailedError, DownloadLaunchError } from "./downloader.js";
import { classifyFailure, isRateLimited } from "./failure.js";
import { UploadConfigError, UploadFailedError } from "../kindle/index.js";

const fff = (stderr: string) =>
  new DownloadFailedError("exit-code", `fanficfare exited with code 1: ${stderr}`, stderr);

describe("classifyFailure — downloads (R1.1, R1.2)", () => {
  it("a network timeout (the download was killed) → transient", () => {
    expect(classifyFailure(new DownloadFailedError("timeout", "timed out after 600s"))).toBe(
      "transient",
    );
  });

  it("AO3 429 → transient", () => {
    expect(classifyFailure(fff("urllib.error.HTTPError: HTTP Error 429: Too Many Requests"))).toBe(
      "transient",
    );
  });

  it("AO3 403 → transient", () => {
    expect(classifyFailure(fff("HTTPErrorFFF: HTTP Error in FFF '403 Forbidden'(403)"))).toBe(
      "transient",
    );
  });

  it("AO3 5xx (e.g. Cloudflare 525) → transient", () => {
    expect(classifyFailure(fff("HTTPErrorFFF: HTTP Error in FFF 'error'(525)"))).toBe("transient");
  });

  it("a network failure (DNS, connection refused) → transient", () => {
    expect(classifyFailure(fff("URLError: <urlopen error [Errno 8] nodename nor servname provided>"))).toBe(
      "transient",
    );
  });

  it("a nonexistent work → permanent", () => {
    expect(
      classifyFailure(fff("StoryDoesNotExist: Story does not exist: https://archiveofourown.org/works/1")),
    ).toBe("permanent");
  });

  it("a 404 from AO3 → permanent", () => {
    expect(classifyFailure(fff("HTTPErrorFFF: HTTP Error in FFF 'Not Found'(404)"))).toBe(
      "permanent",
    );
  });

  it("FanFicFare missing from the PATH (spawn 'error') → permanent", () => {
    expect(
      classifyFailure(new DownloadLaunchError("fanficfare", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))),
    ).toBe("permanent");
  });

  it("an exit 0 without a usable EPUB → permanent (retrying would produce the same)", () => {
    expect(classifyFailure(new DownloadFailedError("no-file", "left no EPUB"))).toBe("permanent");
    expect(classifyFailure(new DownloadFailedError("multiple-files", "left 2 EPUBs"))).toBe(
      "permanent",
    );
  });

  it("an exit code with an unrecognized error → transient (the window bounds the retries)", () => {
    expect(classifyFailure(fff("something odd happened"))).toBe("transient");
  });
});

describe("classifyFailure — uploads (R1.3, R1.4)", () => {
  it("scp launched but exited non-zero (Kindle unreachable) → transient", () => {
    expect(classifyFailure(new UploadFailedError("exit-code", "Operation timed out"))).toBe(
      "transient",
    );
  });

  it("scp killed by our timeout → transient", () => {
    expect(classifyFailure(new UploadFailedError("timeout", "timed out"))).toBe("transient");
  });

  it("scp missing from the PATH (spawn 'error') → permanent", () => {
    expect(classifyFailure(new UploadConfigError("binary-not-found", "scp not found"))).toBe(
      "permanent",
    );
  });

  it("SSH key missing or with open permissions → permanent", () => {
    expect(classifyFailure(new UploadConfigError("key-missing", "no key"))).toBe("permanent");
    expect(classifyFailure(new UploadConfigError("key-permissions-open", "0644"))).toBe("permanent");
  });
});

describe("classifyFailure — anything else", () => {
  it("an unexpected error (a bug, an I/O error) → permanent: it is reported, never retried", () => {
    expect(classifyFailure(new Error("boom"))).toBe("permanent");
    expect(classifyFailure("not even an error")).toBe("permanent");
  });
});

describe("isRateLimited (S2)", () => {
  it.each([
    "urllib.error.HTTPError: HTTP Error 429: Too Many Requests",
    "requests.exceptions.HTTPError: 429 Client Error: Too Many Requests for url: https://archiveofourown.org/works/1",
    "HTTPErrorFFF: HTTP Error in FFF 'Too Many Requests'(429)",
  ])("a FanFicFare 429 → true: %s", (stderr) => {
    expect(isRateLimited(fff(stderr))).toBe(true);
  });

  it("matches the message when the stderr is empty", () => {
    expect(isRateLimited(new DownloadFailedError("exit-code", "429 Client Error: Too Many Requests"))).toBe(true);
  });

  it.each([
    ["AO3 403", fff("HTTPErrorFFF: HTTP Error in FFF '403 Forbidden'(403)")],
    ["AO3 525", fff("HTTPErrorFFF: HTTP Error in FFF 'error'(525)")],
    ["a timeout", new DownloadFailedError("timeout", "timed out after 600s")],
    ["a work id containing 429", fff("StoryDoesNotExist: https://archiveofourown.org/works/14290")],
    ["an upload failure", new UploadFailedError("exit-code", "scp: Too Many Requests 429")],
    ["a plain error", new Error("429 Too Many Requests")],
  ])("%s → false", (_name, err) => {
    expect(isRateLimited(err)).toBe(false);
  });
});
