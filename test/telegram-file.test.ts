import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLine } from "../src/logger.js";
import {
  downloadTelegramFile,
  TelegramDownloadError,
  TelegramFileTooBigError,
  type TelegramFileDeps,
} from "../src/telegram-file.js";

const TOKEN = "123456789:AAFakeSecretTokenValue_ABCdef-ghi";
const FILE_PATH = "documents/file_0.pdf";
const URL_FRAGMENT = "api.telegram.org/file/bot";

let dir: string;
let dest: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-tgfile-"));
  dest = join(dir, "Libro.pdf");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okGetFile: TelegramFileDeps["getFile"] = async () => ({ file_path: FILE_PATH });

function deps(overrides: Partial<TelegramFileDeps> = {}): TelegramFileDeps {
  return {
    getFile: okGetFile,
    fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
    ...overrides,
  };
}

const opts = { token: TOKEN, timeoutMs: 2_000 };

/** Runs the download and returns what it rejected with (fails the test if it resolved). */
async function failure(d: TelegramFileDeps, timeoutMs = opts.timeoutMs): Promise<unknown> {
  try {
    await downloadTelegramFile("FILE_ID", dest, { token: TOKEN, timeoutMs }, d);
  } catch (err) {
    return err;
  }
  throw new Error("expected downloadTelegramFile to reject");
}

/** A body that sends one chunk and then never ends. */
function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([9]));
    },
  });
}

/** A fetch error whose message (and cause) carries the full URL, as some real ones do. */
function leakyFetchError(url: string): Error {
  const cause = Object.assign(new Error(`connect ECONNRESET ${url}`), { code: "ECONNRESET" });
  return new TypeError(`fetch failed for ${url}`, { cause });
}

describe("downloadTelegramFile — success (R6.1)", () => {
  it("writes exactly the bytes the response carries, from the file endpoint URL", async () => {
    const bytes = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 251));
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(bytes));
    const getFile = vi.fn(okGetFile);

    await downloadTelegramFile("FILE_ID", dest, opts, deps({ getFile, fetch: fetchMock as unknown as typeof fetch }));

    expect(getFile).toHaveBeenCalledWith("FILE_ID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://api.telegram.org/file/bot${TOKEN}/${FILE_PATH}`);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("does not overwrite an existing file at destPath ('wx')", async () => {
    await writeFile(dest, "already here");
    await expect(downloadTelegramFile("FILE_ID", dest, opts, deps())).rejects.toBeDefined();
    expect(await readFile(dest, "utf8")).toBe("already here");
  });
});

/** Every failure case, with the reason it must produce. Each one is also checked for the token. */
const failures: Array<{
  name: string;
  reason: TelegramDownloadError["reason"];
  deps: () => TelegramFileDeps;
  timeoutMs?: number;
}> = [
  {
    name: "getFile rejects",
    reason: "get-file",
    deps: () =>
      deps({
        getFile: async () => {
          throw new Error(`boom https://${URL_FRAGMENT}${TOKEN}/x token=${TOKEN}`);
        },
      }),
  },
  { name: "getFile returns no file_path", reason: "no-path", deps: () => deps({ getFile: async () => ({}) }) },
  {
    name: "the download answers 404",
    reason: "http",
    deps: () => deps({ fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch }),
  },
  {
    name: "fetch throws (its message and cause carry the URL)",
    reason: "network",
    deps: () =>
      deps({
        fetch: (async (url: string | URL | Request) => {
          throw leakyFetchError(String(url));
        }) as typeof fetch,
      }),
  },
  {
    name: "the body errors mid-transfer",
    reason: "network",
    deps: () =>
      deps({
        fetch: (async (url: string | URL | Request) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
                controller.error(leakyFetchError(String(url)));
              },
            }),
          )) as typeof fetch,
      }),
  },
  {
    name: "the response is zero bytes",
    reason: "empty",
    deps: () => deps({ fetch: (async () => new Response(new Uint8Array(0))) as typeof fetch }),
  },
  {
    name: "fetch never finishes (and ignores the signal)",
    reason: "timeout",
    timeoutMs: 60,
    deps: () => deps({ fetch: (() => new Promise<Response>(() => {})) as typeof fetch }),
  },
  {
    name: "the body never ends",
    reason: "timeout",
    timeoutMs: 60,
    deps: () => deps({ fetch: (async () => new Response(hangingBody())) as typeof fetch }),
  },
  {
    name: "getFile never finishes",
    reason: "timeout",
    timeoutMs: 60,
    deps: () => deps({ getFile: () => new Promise(() => {}) }),
  },
];

describe("downloadTelegramFile — failures (R6.2, R6.3)", () => {
  for (const f of failures) {
    it(`${f.name} → TelegramDownloadError("${f.reason}")`, async () => {
      const started = Date.now();
      const err = await failure(f.deps(), f.timeoutMs);
      expect(err).toBeInstanceOf(TelegramDownloadError);
      expect((err as TelegramDownloadError).reason).toBe(f.reason);
      if (f.timeoutMs !== undefined) expect(Date.now() - started).toBeLessThan(1_500);
    });
  }

  it("the HTTP error names the status code and the file_path", async () => {
    const err = await failure(failures.find((f) => f.reason === "http")!.deps());
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).toContain(FILE_PATH);
  });

  it("the network error names the error code, not the URL", async () => {
    const err = await failure(failures.find((f) => f.reason === "network")!.deps());
    expect((err as Error).message).toContain("ECONNRESET");
  });
});

describe("downloadTelegramFile — too big (R6.4)", () => {
  it('getFile rejecting with a "file is too big" GrammyError → TelegramFileTooBigError', async () => {
    const tooBig = new GrammyError(
      "Call to 'getFile' failed!",
      { ok: false, error_code: 400, description: "Bad Request: file is too big" },
      "getFile",
      { file_id: "FILE_ID" },
    );
    const err = await failure(
      deps({
        getFile: async () => {
          throw tooBig;
        },
      }),
    );
    expect(err).toBeInstanceOf(TelegramFileTooBigError);
  });

  it("another GrammyError from getFile is a plain get-file failure", async () => {
    const other = new GrammyError(
      "Call to 'getFile' failed!",
      { ok: false, error_code: 400, description: "Bad Request: invalid file_id" },
      "getFile",
      {},
    );
    const err = await failure(
      deps({
        getFile: async () => {
          throw other;
        },
      }),
    );
    expect(err).toBeInstanceOf(TelegramDownloadError);
    expect((err as TelegramDownloadError).reason).toBe("get-file");
  });
});

describe("downloadTelegramFile — the token never leaks (R6.5, acceptance criterion 15)", () => {
  for (const f of failures) {
    it(`${f.name}: no message, cause, stack or log line contains the token or the URL`, async () => {
      const err = await failure(f.deps(), f.timeoutMs);
      const e = err as Error;
      const line = formatLine(new Date(0), "error", "document download failed", { err: e });
      const texts = [
        e.message,
        String(e),
        e.stack ?? "",
        JSON.stringify(e.cause ?? null),
        String(e.cause ?? ""),
        line,
      ];
      for (const text of texts) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(URL_FRAGMENT);
      }
      expect(e.cause).toBeUndefined();
    });
  }
});

describe("downloadTelegramFile — read-side errors are never rethrown raw (R6.5)", () => {
  it("a body error carrying a syscall and the URL becomes a clean network failure", async () => {
    const d = deps({
      fetch: (async (url: string | URL | Request) =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(
                Object.assign(new Error(`read ECONNRESET ${String(url)}`), { syscall: "read", code: "ECONNRESET" }),
              );
            },
          }),
        )) as typeof fetch,
    });
    const e = (await failure(d)) as Error;
    expect(e).toBeInstanceOf(TelegramDownloadError);
    expect((e as TelegramDownloadError).reason).toBe("network");
    expect(e.message).toContain("ECONNRESET");
    const line = formatLine(new Date(0), "error", "document download failed", { err: e });
    for (const text of [e.message, String(e), e.stack ?? "", line]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(URL_FRAGMENT);
    }
  });
});
