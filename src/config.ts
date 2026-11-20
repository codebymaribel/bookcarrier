import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Shape of the config file as written by the owner (design.md). */
export type Config = {
  // required
  telegramToken: string;
  ownerId: number;
  kindleUser: string;
  kindleHost: string;
  sshKeyPath: string;

  // optional, with defaults in code
  downloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
  sshConnectTimeoutSec?: number;
  kindlePort?: number;
  remotePath?: string;

  // retry queue (feature 2)
  /** Queue state file. `~` is expanded. */
  queuePath?: string;
  /** Directory where downloaded EPUBs wait for delivery; never the system temp dir. */
  spoolDir?: string;
  /** Give up on a queued request this long after it was first enqueued. */
  giveUpAfterMs?: number;
  /** Backoff ladder, one delay per retry, in minutes. */
  retryBackoffMinutes?: number[];
};

/** Config with optional fields already resolved: what the rest of the daemon uses. */
export type ResolvedConfig = Required<Config>;

export const CONFIG_DEFAULTS = {
  downloadTimeoutMs: 600_000,
  uploadTimeoutMs: 120_000,
  sshConnectTimeoutSec: 10,
  kindlePort: 2222,
  remotePath: "/mnt/us/documents/books/",
  queuePath: join(homedir(), ".bookcarrier", "queue.json"),
  spoolDir: join(homedir(), ".bookcarrier", "spool"),
  giveUpAfterMs: 1_800_000,
  retryBackoffMinutes: [1, 2, 4, 8, 15],
} as const satisfies Required<Pick<Config, Exclude<OptionalKey, "retryBackoffMinutes">>> &
  Pick<Config, "retryBackoffMinutes">;

type OptionalKey =
  | "downloadTimeoutMs"
  | "uploadTimeoutMs"
  | "sshConnectTimeoutSec"
  | "kindlePort"
  | "remotePath"
  | "queuePath"
  | "spoolDir"
  | "giveUpAfterMs"
  | "retryBackoffMinutes";

/** Fixed path of the real config, outside the repo (R6.1). */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".bookcarrier", "config.json");

/** Filename of the repo's example file (R6.2); never accepted as the real config. */
export const EXAMPLE_CONFIG_FILENAME = "config.example.json";

/** Config error carrying the list of problems found, to log which field is wrong (R6.4). */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Expands a leading `~` (alone or as `~/…`) to the user's home directory.
 * Neither `fs` nor `spawn` do it, so an unexpanded `~/.ssh/key` would be reported as a missing key.
 * `~other/x` (another user's home) is left untouched.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a required non-empty string; adds the problem to the list if it is not valid. */
function requireString(raw: Record<string, unknown>, key: string, problems: string[]): string {
  const value = raw[key];
  if (value === undefined) problems.push(`missing required field "${key}"`);
  else if (typeof value !== "string" || value.trim() === "")
    problems.push(`"${key}" must be a non-empty string`);
  return typeof value === "string" ? value : "";
}

/** Validates an optional non-empty string; returns the default if it is missing. */
function optionalString(
  raw: Record<string, unknown>,
  key: OptionalKey,
  fallback: string,
  problems: string[],
): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`"${key}" is optional, but if present it must be a non-empty string`);
    return fallback;
  }
  return value;
}

/** Validates the optional backoff ladder: a non-empty list of positive integers (minutes). */
function optionalLadder(raw: Record<string, unknown>, problems: string[]): number[] {
  const value = raw["retryBackoffMinutes"];
  if (value === undefined) return [...CONFIG_DEFAULTS.retryBackoffMinutes];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)
  ) {
    problems.push(
      `"retryBackoffMinutes" is optional, but if present it must be a non-empty list of positive integers`,
    );
    return [...CONFIG_DEFAULTS.retryBackoffMinutes];
  }
  return value as number[];
}

/** Validates an optional positive integer; returns the default if it is missing. */
function optionalPositiveInt(
  raw: Record<string, unknown>,
  key: OptionalKey,
  fallback: number,
  problems: string[],
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    problems.push(`"${key}" is optional, but if present it must be a positive integer`);
    return fallback;
  }
  return value;
}

/**
 * Validates an already-parsed object and applies defaults for optional fields.
 * Collects all problems before throwing, so a single failed startup
 * shows everything that needs fixing.
 */
export function parseConfig(raw: unknown): ResolvedConfig {
  if (!isPlainObject(raw)) throw new ConfigError(["the config must be a JSON object"]);
  const problems: string[] = [];

  const telegramToken = requireString(raw, "telegramToken", problems);
  const kindleUser = requireString(raw, "kindleUser", problems);
  const kindleHost = requireString(raw, "kindleHost", problems);
  const sshKeyPath = requireString(raw, "sshKeyPath", problems);

  const ownerIdRaw = raw["ownerId"];
  if (ownerIdRaw === undefined) problems.push(`missing required field "ownerId"`);
  else if (typeof ownerIdRaw !== "number" || !Number.isSafeInteger(ownerIdRaw) || ownerIdRaw <= 0)
    problems.push(`"ownerId" must be a positive integer (the Telegram ID)`);
  const ownerId = typeof ownerIdRaw === "number" ? ownerIdRaw : 0;

  if (kindleHost.includes("@"))
    problems.push(`"kindleHost" must not include a user (IP or hostname only); the user goes in "kindleUser"`);

  const downloadTimeoutMs = optionalPositiveInt(
    raw,
    "downloadTimeoutMs",
    CONFIG_DEFAULTS.downloadTimeoutMs,
    problems,
  );
  const uploadTimeoutMs = optionalPositiveInt(
    raw,
    "uploadTimeoutMs",
    CONFIG_DEFAULTS.uploadTimeoutMs,
    problems,
  );
  const sshConnectTimeoutSec = optionalPositiveInt(
    raw,
    "sshConnectTimeoutSec",
    CONFIG_DEFAULTS.sshConnectTimeoutSec,
    problems,
  );
  const kindlePort = optionalPositiveInt(raw, "kindlePort", CONFIG_DEFAULTS.kindlePort, problems);

  let remotePath: string = CONFIG_DEFAULTS.remotePath;
  const remotePathRaw = raw["remotePath"];
  if (remotePathRaw !== undefined) {
    if (typeof remotePathRaw !== "string" || remotePathRaw.trim() === "")
      problems.push(`"remotePath" is optional, but if present it must be a non-empty string`);
    else remotePath = remotePathRaw;
  }

  const queuePath = optionalString(raw, "queuePath", CONFIG_DEFAULTS.queuePath, problems);
  const spoolDir = optionalString(raw, "spoolDir", CONFIG_DEFAULTS.spoolDir, problems);
  const giveUpAfterMs = optionalPositiveInt(
    raw,
    "giveUpAfterMs",
    CONFIG_DEFAULTS.giveUpAfterMs,
    problems,
  );
  const retryBackoffMinutes = optionalLadder(raw, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    telegramToken,
    ownerId,
    kindleUser,
    kindleHost,
    sshKeyPath: expandHome(sshKeyPath),
    downloadTimeoutMs,
    uploadTimeoutMs,
    sshConnectTimeoutSec,
    kindlePort,
    remotePath,
    queuePath: expandHome(queuePath),
    spoolDir: expandHome(spoolDir),
    giveUpAfterMs,
    retryBackoffMinutes,
  };
}

/**
 * Reads and validates the config from disk (async, does not block the loop).
 * Explicitly rejects `config.example.json`: that file is only a
 * repo template and is never used as the real config (R6.2).
 */
export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<ResolvedConfig> {
  if (basename(path) === EXAMPLE_CONFIG_FILENAME) {
    throw new ConfigError([
      `"${path}" is the repo's example file; copy it to ${DEFAULT_CONFIG_PATH} and fill it in`,
    ]);
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = isPlainObject(err) && typeof err["code"] === "string" ? err["code"] : "unknown";
    throw new ConfigError([`could not read "${path}" (${code})`]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError([`"${path}" is not valid JSON`]);
  }
  return parseConfig(raw);
}
