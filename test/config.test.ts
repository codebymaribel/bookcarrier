import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_DEFAULTS,
  ConfigError,
  DEFAULT_CONFIG_PATH,
  expandHome,
  loadConfig,
  parseConfig,
} from "../src/config.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_PATH = join(REPO_ROOT, "config.example.json");

const valid = {
  telegramToken: "123:abc",
  ownerId: 42,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  sshKeyPath: "/tmp/key",
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown, name = "config.json"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

async function problemsOf(promise: Promise<unknown>): Promise<readonly string[]> {
  const err: unknown = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConfigError);
  return err instanceof ConfigError ? err.problems : [];
}

describe("loadConfig", () => {
  it("loads a valid config and applies defaults for optional fields", async () => {
    const config = await loadConfig(await writeConfig(valid));
    expect(config).toEqual({ ...valid, ...CONFIG_DEFAULTS });
    expect(config.downloadTimeoutMs).toBe(600_000);
    expect(config.uploadTimeoutMs).toBe(120_000);
    expect(config.sshConnectTimeoutSec).toBe(10);
    expect(config.kindlePort).toBe(2222);
    expect(config.remotePath).toBe("/mnt/us/documents/books/");
  });

  it("respects optional fields when present", async () => {
    const overrides = {
      downloadTimeoutMs: 1000,
      uploadTimeoutMs: 2000,
      sshConnectTimeoutSec: 5,
      kindlePort: 22,
      remotePath: "/mnt/us/documents/",
    };
    expect(await loadConfig(await writeConfig({ ...valid, ...overrides }))).toEqual({
      ...valid,
      ...CONFIG_DEFAULTS,
      ...overrides,
    });
  });

  it.each(["telegramToken", "ownerId", "kindleUser", "kindleHost", "sshKeyPath"] as const)(
    "throws a clear error if %s is missing",
    async (field) => {
      const { [field]: _omitted, ...rest } = valid;
      const problems = await problemsOf(loadConfig(await writeConfig(rest)));
      expect(problems).toEqual([`missing required field "${field}"`]);
    },
  );

  it("reports all invalid fields in a single error", async () => {
    const problems = await problemsOf(
      loadConfig(await writeConfig({ ownerId: "42", kindleHost: "", uploadTimeoutMs: -1 })),
    );
    expect(problems).toEqual([
      'missing required field "telegramToken"',
      'missing required field "kindleUser"',
      '"kindleHost" must be a non-empty string',
      'missing required field "sshKeyPath"',
      '"ownerId" must be a positive integer (the Telegram ID)',
      '"uploadTimeoutMs" is optional, but if present it must be a positive integer',
    ]);
  });

  it("rejects a kindleHost that includes the user", async () => {
    const problems = await problemsOf(
      loadConfig(await writeConfig({ ...valid, kindleHost: "root@192.168.1.50" })),
    );
    expect(problems[0]).toMatch(/"kindleHost" must not include a user/);
  });

  it.each([0, -22, 22.5, "2222"])(
    "rejects kindlePort = %j (must be a positive integer)",
    async (kindlePort) => {
      const problems = await problemsOf(loadConfig(await writeConfig({ ...valid, kindlePort })));
      expect(problems).toEqual([
        '"kindlePort" is optional, but if present it must be a positive integer',
      ]);
    },
  );

  it("rejects an empty remotePath", async () => {
    const problems = await problemsOf(loadConfig(await writeConfig({ ...valid, remotePath: " " })));
    expect(problems[0]).toMatch(/"remotePath"/);
  });

  it("the retry-queue defaults: queue file and spool under ~/.bookcarrier, 30 min, 1-2-4-8-15 (feature 2)", async () => {
    const config = await loadConfig(await writeConfig(valid));
    expect(config.queuePath).toBe(join(homedir(), ".bookcarrier", "queue.json"));
    expect(config.spoolDir).toBe(join(homedir(), ".bookcarrier", "spool"));
    expect(config.giveUpAfterMs).toBe(1_800_000);
    expect(config.retryBackoffMinutes).toEqual([1, 2, 4, 8, 15]);
  });

  it("the rate-limit deferral defaults: retry every 2 h, give up 24 h after the first enqueue (S3, S4)", async () => {
    const config = await loadConfig(await writeConfig(valid));
    expect(config.deferredRetryMs).toBe(7_200_000);
    expect(config.deferredGiveUpAfterMs).toBe(86_400_000);
  });

  it("accepts rate-limit deferral overrides and rejects non-positive ones", async () => {
    const config = await loadConfig(
      await writeConfig({ ...valid, deferredRetryMs: 3_600_000, deferredGiveUpAfterMs: 43_200_000 }),
    );
    expect(config.deferredRetryMs).toBe(3_600_000);
    expect(config.deferredGiveUpAfterMs).toBe(43_200_000);
    const problems = await problemsOf(
      loadConfig(await writeConfig({ ...valid, deferredRetryMs: 0, deferredGiveUpAfterMs: "x" })),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/"deferredRetryMs"/);
    expect(problems[1]).toMatch(/"deferredGiveUpAfterMs"/);
  });

  it("accepts retry-queue overrides and expands ~ in their paths", async () => {
    const config = await loadConfig(
      await writeConfig({
        ...valid,
        queuePath: "~/q/queue.json",
        spoolDir: "/var/spool/bc",
        giveUpAfterMs: 3_600_000,
        retryBackoffMinutes: [5, 10],
      }),
    );
    expect(config.queuePath).toBe(join(homedir(), "q", "queue.json"));
    expect(config.spoolDir).toBe("/var/spool/bc");
    expect(config.giveUpAfterMs).toBe(3_600_000);
    expect(config.retryBackoffMinutes).toEqual([5, 10]);
  });

  it.each([[[]], [[1, 0]], [[1.5]], ["1,2"]])(
    "rejects retryBackoffMinutes = %j (must be a non-empty list of positive integers)",
    async (retryBackoffMinutes) => {
      const problems = await problemsOf(
        loadConfig(await writeConfig({ ...valid, retryBackoffMinutes })),
      );
      expect(problems).toEqual([
        '"retryBackoffMinutes" is optional, but if present it must be a non-empty list of positive integers',
      ]);
    },
  );

  it("rejects empty queuePath / spoolDir", async () => {
    const problems = await problemsOf(
      loadConfig(await writeConfig({ ...valid, queuePath: "", spoolDir: 3 })),
    );
    expect(problems).toEqual([
      '"queuePath" is optional, but if present it must be a non-empty string',
      '"spoolDir" is optional, but if present it must be a non-empty string',
    ]);
  });

  it("throws ConfigError if the file does not exist", async () => {
    const problems = await problemsOf(loadConfig(join(dir, "does-not-exist.json")));
    expect(problems[0]).toMatch(/could not read .*\(ENOENT\)/);
  });

  it("throws ConfigError if the file is not JSON", async () => {
    const problems = await problemsOf(loadConfig(await writeConfig("{ this is not json")));
    expect(problems[0]).toMatch(/is not valid JSON/);
  });

  it("throws ConfigError if the JSON is not an object", async () => {
    expect(() => parseConfig([valid])).toThrow(ConfigError);
  });
});

describe("documentFolders (feature 3, R8)", () => {
  const BOOKS = "/mnt/us/documents/books/";

  it("absent → epub, mobi and pdf all go to /mnt/us/documents/books/ (R8.2)", async () => {
    const config = await loadConfig(await writeConfig(valid));
    expect(config.documentFolders).toBeInstanceOf(Map);
    expect([...config.documentFolders]).toEqual([
      ["epub", BOOKS],
      ["mobi", BOOKS],
      ["pdf", BOOKS],
    ]);
    // the fics keep going to remotePath (acceptance criterion 17)
    expect(config.remotePath).toBe(CONFIG_DEFAULTS.remotePath);
  });

  it("present → replaces the default as a whole, never merged (R8.3)", async () => {
    const config = await loadConfig(await writeConfig({ ...valid, documentFolders: { pdf: "/x/" } }));
    expect([...config.documentFolders]).toEqual([["pdf", "/x/"]]);
  });

  it("adds a missing trailing / (R8.5, acceptance criterion 18)", async () => {
    const config = await loadConfig(
      await writeConfig({
        ...valid,
        documentFolders: { epub: BOOKS, pdf: "/mnt/us/documents/pdfs" },
      }),
    );
    expect([...config.documentFolders]).toEqual([
      ["epub", BOOKS],
      ["pdf", "/mnt/us/documents/pdfs/"],
    ]);
  });

  it("the resolved value is a Map: a 'constructor' extension is never accepted", async () => {
    const config = await loadConfig(await writeConfig(valid));
    expect(config.documentFolders).toBeInstanceOf(Map);
    expect(config.documentFolders.has("constructor")).toBe(false);
    expect(config.documentFolders.has("__proto__")).toBe(false);
  });

  it("each load gets its own Map (the default is never shared)", async () => {
    const a = await loadConfig(await writeConfig(valid));
    const b = await loadConfig(await writeConfig(valid));
    expect(a.documentFolders).not.toBe(b.documentFolders);
  });

  const NOT_OBJECT =
    '"documentFolders" is optional, but if present it must be a non-empty object mapping extensions to Kindle folders';

  it.each([["a string", "pdf"], ["a number", 42], ["null", null], ["an array", []], ["an empty object", {}]])(
    "rejects documentFolders = %s (R8.4, acceptance criterion 19)",
    async (_label, documentFolders) => {
      const problems = await problemsOf(loadConfig(await writeConfig({ ...valid, documentFolders })));
      expect(problems).toEqual([NOT_OBJECT]);
    },
  );

  it.each(["PDF", ".pdf", "p df"])(
    "rejects the key %j, naming it (R8.4, acceptance criterion 19)",
    async (key) => {
      const problems = await problemsOf(
        loadConfig(await writeConfig({ ...valid, documentFolders: { epub: BOOKS, [key]: BOOKS } })),
      );
      expect(problems).toEqual([
        `documentFolders: key "${key}" must be a lower-case extension without a dot (only a-z and 0-9)`,
      ]);
    },
  );

  it.each([[""], ["  "], [42], [null]])(
    "rejects the value %j, naming its key (R8.4)",
    async (value) => {
      const problems = await problemsOf(
        loadConfig(await writeConfig({ ...valid, documentFolders: { pdf: value } })),
      );
      expect(problems).toEqual(['documentFolders: the folder for "pdf" must be a non-empty string']);
    },
  );

  it("rejects a relative folder like \"books/\", naming its key (R8.4, acceptance criterion 19)", async () => {
    const problems = await problemsOf(
      loadConfig(await writeConfig({ ...valid, documentFolders: { pdf: "books/" } })),
    );
    expect(problems).toEqual([
      'documentFolders: the folder for "pdf" must be an absolute path (starting with "/"), got "books/"',
    ]);
  });

  it("reports every documentFolders problem in one ConfigError, together with the other fields' problems (R8.4)", async () => {
    const { ownerId: _omitted, ...rest } = valid;
    const problems = await problemsOf(
      loadConfig(
        await writeConfig({
          ...rest,
          kindlePort: 0,
          documentFolders: { PDF: BOOKS, mobi: "books/", epub: 42 },
        }),
      ),
    );
    expect(problems).toEqual([
      'missing required field "ownerId"',
      '"kindlePort" is optional, but if present it must be a positive integer',
      'documentFolders: key "PDF" must be a lower-case extension without a dot (only a-z and 0-9)',
      'documentFolders: the folder for "mobi" must be an absolute path (starting with "/"), got "books/"',
      'documentFolders: the folder for "epub" must be a non-empty string',
    ]);
  });

  it("existing fields keep loading exactly as before when documentFolders is present", async () => {
    const config = await loadConfig(
      await writeConfig({ ...valid, remotePath: "/mnt/us/documents/books/AO3/", documentFolders: { pdf: "/p" } }),
    );
    expect(config).toEqual({
      ...valid,
      ...CONFIG_DEFAULTS,
      remotePath: "/mnt/us/documents/books/AO3/",
      documentFolders: new Map([["pdf", "/p/"]]),
    });
  });
});

describe("sshKeyPath home expansion (R6.5)", () => {
  it("expands ~/ to the home directory", () => {
    expect(expandHome("~/.ssh/k", "/home/u")).toBe("/home/u/.ssh/k");
  });

  it("expands a lone ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });

  it("leaves absolute and relative paths untouched", () => {
    expect(expandHome("/etc/k", "/home/u")).toBe("/etc/k");
    expect(expandHome("keys/k", "/home/u")).toBe("keys/k");
  });

  it("leaves another user's ~other/x untouched", () => {
    expect(expandHome("~other/x", "/home/u")).toBe("~other/x");
  });

  it("is applied by loadConfig", async () => {
    const config = await loadConfig(await writeConfig({ ...valid, sshKeyPath: "~/.ssh/kindle" }));
    expect(config.sshKeyPath).toBe(join(homedir(), ".ssh", "kindle"));
  });
});

describe("config.example.json", () => {
  it("is never read as the real config, even if its path is passed", async () => {
    const problems = await problemsOf(loadConfig(EXAMPLE_PATH));
    expect(problems[0]).toMatch(/repo's example file/);
  });

  it("is not accepted from another directory either", async () => {
    const copy = await writeConfig(valid, "config.example.json");
    await expect(loadConfig(copy)).rejects.toBeInstanceOf(ConfigError);
  });

  it("the default path is outside the repo", () => {
    expect(DEFAULT_CONFIG_PATH.startsWith(REPO_ROOT)).toBe(false);
    expect(DEFAULT_CONFIG_PATH).toMatch(/\.bookcarrier[/\\]config\.json$/);
  });

  it("has the correct shape (stays in sync with the Config type)", async () => {
    const raw: unknown = JSON.parse(await readFile(EXAMPLE_PATH, "utf8"));
    expect(() => parseConfig(raw)).not.toThrow();
  });
});
