import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot, createRequestHandler, type RequestConfig, type RequestDeps } from "../src/bot.js";
import type { ResolvedConfig } from "../src/config.js";
import {
  DownloadFailedError,
  DownloadLaunchError,
  type DownloadResult,
} from "../src/downloader.js";
import type { Logger } from "../src/logger.js";
import { messages } from "../src/messages.js";
import { UploadConfigError, UploadFailedError } from "../src/uploader.js";

const config: RequestConfig = {
  downloadTimeoutMs: 123_000,
  uploadTimeoutMs: 45_000,
  sshConnectTimeoutSec: 7,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/AO3/",
  sshKeyPath: "/keys/kindle",
  kindleUser: "root",
  kindleHost: "192.168.1.50",
};

const LINK = "https://archiveofourown.org/works/65164981";
const RESULT: DownloadResult = { filePath: "/tmp/bookcarrier-x/65164981-Title.epub", title: "Title" };

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Fake deps that record the order of everything that happens, in one shared `events` list. */
function setup(overrides: Partial<RequestDeps> = {}) {
  const events: string[] = [];
  const replies: string[] = [];
  const logger = silentLogger();
  const deps: RequestDeps = {
    download: vi.fn(async (url: string) => {
      events.push(`download ${url}`);
      return RESULT;
    }),
    upload: vi.fn(async (path: string) => {
      events.push(`upload ${path}`);
    }),
    makeTempDir: vi.fn(async () => {
      events.push("mkdir");
      return "/tmp/bookcarrier-x";
    }),
    removeDir: vi.fn(async (dir: string) => {
      events.push(`rmdir ${dir}`);
    }),
    logger,
    ...overrides,
  };
  const handle = createRequestHandler(config, deps);
  const reply = async (text: string) => {
    replies.push(text);
    events.push(`reply ${text}`);
  };
  return { deps, handle, reply, events, replies, logger };
}

describe("request flow — success (R2.1, R5.4)", () => {
  it("acknowledges, then calls downloader → uploader in order, then confirms with the title", async () => {
    const { handle, reply, events } = setup();
    await handle(LINK, reply);
    expect(events).toEqual([
      `reply ${messages.ack}`,
      "mkdir",
      `download ${LINK}`,
      `upload ${RESULT.filePath}`,
      `reply ${messages.delivered("Title")}`,
      "rmdir /tmp/bookcarrier-x",
    ]);
  });

  it("the delivery message includes the fic's title (R5.4)", async () => {
    const { handle, reply, replies } = setup();
    await handle(LINK, reply);
    expect(replies.at(-1)).toContain("Title");
  });

  it("works with the real Android share text (title line + URL)", async () => {
    const { handle, reply, deps } = setup();
    await handle(
      "Rio, Rio - carsynmerrill (onthepitch) - Agatha All Along (TV) [Archive of Our Own]\n" +
        "https://archiveofourown.org/works/61265059",
      reply,
    );
    expect(deps.download).toHaveBeenCalledWith(
      "https://archiveofourown.org/works/61265059",
      expect.any(String),
      expect.anything(),
    );
  });
});

describe("request flow — what each step receives", () => {
  it("the downloader gets the CANONICAL url, not the text the user sent (R2.6)", async () => {
    const { handle, reply, deps } = setup();
    await handle(`look: https://www.archiveofourown.org/works/65164981/chapters/9?view_adult=true#top`, reply);
    expect(deps.download).toHaveBeenCalledWith(LINK, "/tmp/bookcarrier-x", {
      timeoutMs: 123_000,
    });
  });

  it("the uploader gets the downloaded file and the options mapped from config", async () => {
    const { handle, reply, deps } = setup();
    await handle(LINK, reply);
    expect(deps.upload).toHaveBeenCalledWith(RESULT.filePath, {
      sshKeyPath: "/keys/kindle",
      kindleUser: "root",
      kindleHost: "192.168.1.50",
      port: 2222,
      remotePath: "/mnt/us/documents/books/AO3/",
      connectTimeoutSec: 7,
      timeoutMs: 45_000,
    });
  });
});

describe("request flow — links that are not accepted (R2.2, R2.3)", () => {
  it.each(["hello", "https://example.com/works/1", ""])(
    "%j → 'not recognized', no acknowledgement, nothing is run",
    async (text) => {
      const { handle, reply, replies, deps } = setup();
      await handle(text, reply);
      expect(replies).toEqual([messages.noLink]);
      expect(deps.makeTempDir).not.toHaveBeenCalled();
      expect(deps.download).not.toHaveBeenCalled();
      expect(deps.upload).not.toHaveBeenCalled();
    },
  );

  it("an AO3 link that is not a work → 'not supported yet', nothing is run", async () => {
    const { handle, reply, replies, deps } = setup();
    await handle("https://archiveofourown.org/series/456", reply);
    expect(replies).toEqual([messages.unsupportedLink]);
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe("request flow — failures: the right message, and the next step is not called", () => {
  it("download failed (R3.3) → download-failed message, uploader NOT called", async () => {
    const { handle, reply, replies, deps } = setup({
      download: vi.fn().mockRejectedValue(new DownloadFailedError("exit-code", "fanficfare exited with code 1: HTTP 525")),
    });
    await handle(LINK, reply);
    expect(replies.at(-1)).toBe(messages.downloadFailed("fanficfare exited with code 1: HTTP 525"));
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("FanFicFare cannot be launched (R3.5) → its own message, naming the binary", async () => {
    const { handle, reply, replies, deps } = setup({
      download: vi.fn().mockRejectedValue(new DownloadLaunchError("fanficfare", new Error("spawn fanficfare ENOENT"))),
    });
    await handle(LINK, reply);
    const last = replies.at(-1) ?? "";
    expect(last).toContain("couldn't start FanFicFare");
    expect(last).toContain('"fanficfare"');
    expect(last).not.toBe(messages.downloadFailed("x"));
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("Kindle unreachable (R5.3, R5.7) → send-failed message with the title", async () => {
    const { handle, reply, replies } = setup({
      upload: vi.fn().mockRejectedValue(new UploadFailedError("exit-code", "scp exited with code 255: Host is down")),
    });
    await handle(LINK, reply);
    expect(replies.at(-1)).toBe(messages.sendFailed("Title", "scp exited with code 255: Host is down"));
    expect(replies.at(-1)).toContain("Title");
  });

  it("broken config (R5.2, R5.5) → configuration message, different from 'unreachable'", async () => {
    const { handle, reply, replies } = setup({
      upload: vi.fn().mockRejectedValue(new UploadConfigError("key-missing", "SSH key not found: /keys/kindle")),
    });
    await handle(LINK, reply);
    expect(replies.at(-1)).toBe(messages.uploadConfig("SSH key not found: /keys/kindle"));
    expect(replies.at(-1)).not.toContain("Wi-Fi");
  });

  it("an unexpected error → generic message with no details, and the real error is logged", async () => {
    const boom = new TypeError("secret internal detail at /Users/x/y.ts:12");
    const { handle, reply, replies, logger } = setup({ download: vi.fn().mockRejectedValue(boom) });
    await handle(LINK, reply);
    expect(replies.at(-1)).toBe(messages.unexpected);
    expect(replies.at(-1)).not.toContain("secret");
    expect(logger.error).toHaveBeenCalledWith("request failed", expect.objectContaining({ error: boom }));
  });

  it("a failing temp-dir creation → generic message, nothing downloaded", async () => {
    const { handle, reply, replies, deps } = setup({
      makeTempDir: vi.fn().mockRejectedValue(new Error("EACCES")),
    });
    await handle(LINK, reply);
    expect(replies.at(-1)).toBe(messages.unexpected);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.removeDir).not.toHaveBeenCalled();
  });

  it("the subprocess's stderr goes to the log, never to the owner", async () => {
    const err = new DownloadFailedError("exit-code", "fanficfare exited with code 1: last line", "Traceback...\nlast line");
    const { handle, reply, replies, logger } = setup({ download: vi.fn().mockRejectedValue(err) });
    await handle(LINK, reply);
    expect(replies.join("\n")).not.toContain("Traceback");
    expect(logger.error).toHaveBeenCalledWith(
      "request failed",
      expect.objectContaining({ stderr: "Traceback...\nlast line" }),
    );
  });
});

describe("request flow — temporary directory", () => {
  it("is created BEFORE the download and removed after a success", async () => {
    const { handle, reply, events } = setup();
    await handle(LINK, reply);
    expect(events.indexOf("mkdir")).toBeLessThan(events.indexOf(`download ${LINK}`));
    expect(events.at(-1)).toBe("rmdir /tmp/bookcarrier-x");
  });

  it("is removed after a failure in the download", async () => {
    const { handle, reply, deps } = setup({
      download: vi.fn().mockRejectedValue(new DownloadFailedError("timeout", "timed out")),
    });
    await handle(LINK, reply);
    expect(deps.removeDir).toHaveBeenCalledWith("/tmp/bookcarrier-x");
  });

  it("is removed after a failure in the upload", async () => {
    const { handle, reply, deps } = setup({
      upload: vi.fn().mockRejectedValue(new UploadFailedError("timeout", "timed out")),
    });
    await handle(LINK, reply);
    expect(deps.removeDir).toHaveBeenCalledWith("/tmp/bookcarrier-x");
  });

  it("is removed even after an unexpected error", async () => {
    const { handle, reply, deps } = setup({ upload: vi.fn().mockRejectedValue(new Error("bug")) });
    await handle(LINK, reply);
    expect(deps.removeDir).toHaveBeenCalledWith("/tmp/bookcarrier-x");
  });

  it("is removed only after the reply was sent", async () => {
    const { handle, reply, events } = setup();
    await handle(LINK, reply);
    expect(events.indexOf(`reply ${messages.delivered("Title")}`)).toBeLessThan(
      events.indexOf("rmdir /tmp/bookcarrier-x"),
    );
  });

  it("a failure removing it is logged and does not change the outcome", async () => {
    const { handle, reply, replies, logger } = setup({
      removeDir: vi.fn().mockRejectedValue(new Error("EBUSY")),
    });
    await expect(handle(LINK, reply)).resolves.toBeUndefined();
    expect(replies.at(-1)).toBe(messages.delivered("Title"));
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is not created when the link is rejected", async () => {
    const { handle, reply, deps } = setup();
    await handle("no link here", reply);
    expect(deps.makeTempDir).not.toHaveBeenCalled();
    expect(deps.removeDir).not.toHaveBeenCalled();
  });
});

describe("request flow — Telegram failures", () => {
  it("if sending a message fails, it is logged and the fic is still delivered", async () => {
    const { handle, deps, logger } = setup();
    const failingReply = vi.fn().mockRejectedValue(new Error("Telegram is down"));
    await expect(handle(LINK, failingReply)).resolves.toBeUndefined();
    expect(deps.upload).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The whole bot, fed with fake updates. No network: every Telegram API call is intercepted.
// ---------------------------------------------------------------------------------------------

const OWNER = 42;
const botConfig: ResolvedConfig = {
  telegramToken: "123:fake",
  ownerId: OWNER,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  sshKeyPath: "/keys/kindle",
  downloadTimeoutMs: 600_000,
  uploadTimeoutMs: 120_000,
  sshConnectTimeoutSec: 10,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/",
};

const botInfo = {
  id: 1,
  is_bot: true as const,
  first_name: "Bookcarrier",
  username: "bookcarrier_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function textUpdate(updateId: number, fromId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
    },
  };
}

/** Result of every fake API call; `never` is justified: the real type depends on the method and is never read. */
const ok = () => ({ ok: true as const, result: true as never });

describe("createBot — wiring", () => {
  function botWith(deps: Partial<RequestDeps>) {
    const bot = createBot(botConfig, { logger: silentLogger(), ...deps }, { botInfo });
    const sent: string[] = [];
    bot.api.config.use((_prev, method, payload) => {
      if (method === "sendMessage" && "text" in payload) sent.push(String(payload.text));
      return Promise.resolve(ok());
    });
    return { bot, sent };
  }

  const fakeDeps = (): Partial<RequestDeps> => ({
    download: vi.fn(async () => RESULT),
    upload: vi.fn(async () => {}),
    makeTempDir: vi.fn(async () => "/tmp/bookcarrier-x"),
    removeDir: vi.fn(async () => {}),
  });

  it("a message from someone else gets no reply and runs nothing (R1.1, acceptance 5)", async () => {
    const deps = fakeDeps();
    const { bot, sent } = botWith(deps);
    await bot.handleUpdate(textUpdate(1, 99, LINK));
    expect(sent).toEqual([]);
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("a link from the owner is acknowledged and delivered (acceptance 1)", async () => {
    const deps = fakeDeps();
    const { bot, sent } = botWith(deps);
    await bot.handleUpdate(textUpdate(1, OWNER, LINK));
    expect(sent).toEqual([messages.ack, messages.delivered("Title")]);
  });

  it("text that is not an AO3 link → 'not recognized', FanFicFare not invoked (acceptance 2)", async () => {
    const deps = fakeDeps();
    const { bot, sent } = botWith(deps);
    await bot.handleUpdate(textUpdate(1, OWNER, "hola"));
    expect(sent).toEqual([messages.noLink]);
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("a failed download is reported and scp is not attempted (acceptance 3)", async () => {
    const deps = fakeDeps();
    deps.download = vi.fn().mockRejectedValue(new DownloadFailedError("exit-code", "HTTP 525"));
    const { bot, sent } = botWith(deps);
    await bot.handleUpdate(textUpdate(1, OWNER, LINK));
    expect(sent.at(-1)).toBe(messages.downloadFailed("HTTP 525"));
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("an unreachable Kindle is reported (acceptance 4)", async () => {
    const deps = fakeDeps();
    deps.upload = vi.fn().mockRejectedValue(new UploadFailedError("exit-code", "Host is down"));
    const { bot, sent } = botWith(deps);
    await bot.handleUpdate(textUpdate(1, OWNER, LINK));
    expect(sent.at(-1)).toBe(messages.sendFailed("Title", "Host is down"));
  });
});

describe("createBot — sequential processing (grammY long polling)", () => {
  it("a second message waits until the first one has finished", async () => {
    const events: string[] = [];
    let releaseFirst: (result: DownloadResult) => void = () => {};
    const firstGate = new Promise<DownloadResult>((resolve) => {
      releaseFirst = resolve;
    });
    const download = vi.fn(async (url: string) => {
      const id = url.split("/").at(-1);
      events.push(`download:start ${id}`);
      const result = id === "111" ? await firstGate : RESULT;
      events.push(`download:end ${id}`);
      return result;
    });
    const upload = vi.fn(async (path: string) => {
      events.push(`upload ${path === RESULT.filePath ? "done" : "first"}`);
    });

    const bot = createBot(
      botConfig,
      {
        download,
        upload,
        makeTempDir: async () => "/tmp/bookcarrier-x",
        removeDir: async () => {},
        logger: silentLogger(),
      },
      { botInfo },
    );

    // Both messages arrive in the SAME getUpdates batch, exactly as when you share two links quickly.
    let delivered = false;
    bot.api.config.use(async (_prev, method) => {
      if (method === "getUpdates") {
        if (!delivered) {
          delivered = true;
          return {
            ok: true as const,
            result: [
              textUpdate(1, OWNER, "https://archiveofourown.org/works/111"),
              textUpdate(2, OWNER, "https://archiveofourown.org/works/222"),
            ] as never,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true as const, result: [] as never };
      }
      return ok();
    });

    const polling = bot.start();
    await vi.waitFor(() => expect(events).toContain("download:start 111"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The first download is still running: the second message has NOT started.
    expect(events).toEqual(["download:start 111"]);

    releaseFirst({ filePath: "/tmp/bookcarrier-x/111-First.epub", title: "First" });
    await vi.waitFor(() => expect(events).toContain("upload done"));
    await bot.stop();
    await polling;

    expect(events).toEqual([
      "download:start 111",
      "download:end 111",
      "upload first",
      "download:start 222",
      "download:end 222",
      "upload done",
    ]);
  });
});
