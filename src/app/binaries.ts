import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { FANFICFARE_BIN } from "../fanfic/index.js";
import type { Logger } from "../shared/index.js";
import { SCP_BIN, SSH_BIN } from "../kindle/index.js";

/**
 * External binaries the daemon spawns; all must be resolvable on the PATH (R7.7). `ssh` runs the
 * documents' existence check (feature 3, R4.1).
 */
export const REQUIRED_BINARIES: readonly string[] = [FANFICFARE_BIN, SCP_BIN, SSH_BIN];

/** True when `path` is a regular file the current user may execute. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `name` resolves to an executable file in some entry of `pathEnv`. */
async function resolvesOnPath(name: string, pathEnv: string): Promise<boolean> {
  // Empty entries are skipped: they would mean "the current directory", which is not where a
  // daemon's binaries live.
  const dirs = pathEnv.split(delimiter).filter((dir) => dir !== "");
  for (const dir of dirs) {
    if (await isExecutableFile(join(dir, name))) return true;
  }
  return false;
}

/**
 * Returns the names in `names` that do not resolve to an executable file on `pathEnv`
 * (default: the process PATH), in the order given.
 */
export async function findMissingBinaries(
  names: readonly string[],
  pathEnv: string = process.env["PATH"] ?? "",
): Promise<string[]> {
  const found = await Promise.all(names.map((name) => resolvesOnPath(name, pathEnv)));
  return names.filter((_name, i) => found[i] !== true);
}

/**
 * Startup check (R7.7): logs one error naming every missing binary and the PATH searched, so a
 * PATH badly built by launchd shows up at startup instead of as a misleading download failure.
 * Logs nothing when every binary is present. It only logs: the daemon still starts.
 */
export async function checkRequiredBinaries(
  logger: Logger,
  pathEnv: string = process.env["PATH"] ?? "",
  names: readonly string[] = REQUIRED_BINARIES,
): Promise<void> {
  const missing = await findMissingBinaries(names, pathEnv);
  if (missing.length === 0) return;
  logger.error(
    `required binaries not found on the PATH: ${missing.join(", ")} (check EnvironmentVariables.PATH in the LaunchAgent plist)`,
    { missing, path: pathEnv },
  );
}
