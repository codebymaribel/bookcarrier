import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = realpathSync(resolve(import.meta.dirname, ".."));
const SCRIPT = join(REPO, "bin", "bookcarrierctl");
const PLIST_TEMPLATE = join(REPO, "launchd", "com.codebymaribel.bookcarrier.plist");
const FIXTURES = resolve(import.meta.dirname, "fixtures", "bookcarrierctl");
const LABEL = "com.codebymaribel.bookcarrier";
const UID = String(process.getuid?.() ?? "");
const DOMAIN = `gui/${UID}`;
const SERVICE = `${DOMAIN}/${LABEL}`;

const USAGE = `Usage: bookcarrierctl <command>

Commands:
  status [--porcelain]     Show the daemon state and the retry queue size
  start                    Start the daemon
  stop                     Stop the daemon (SIGTERM, waits up to 15 s, never SIGKILL)
  restart                  Restart the daemon (e.g. after pnpm build)
  install                  Install the LaunchAgent and load it
  uninstall                Unload the LaunchAgent and delete its plist (keeps logs, queue and spool)
  logs [-f|--follow]       Show the last lines of bookcarrier.log; -f keeps following it
  menubar install <dir>    Install the SwiftBar plugin into <dir>
  help                     Show this help
`;

const NOT_INSTALLED = "Bookcarrier is not installed. Run: bookcarrierctl install\n";

const FAKE_LAUNCHCTL = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
if [ "$1" = "list" ] && [ -f "$FAKE_DIR/lingers" ]; then
  # After bootout the real launchd keeps listing the job for a moment.
  left="$(/bin/cat "$FAKE_DIR/lingers")"
  if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$FAKE_DIR/lingers"; /bin/cat "$FAKE_DIR/list.out"; exit 0; fi
  /bin/rm -f "$FAKE_DIR/lingers" "$FAKE_DIR/list.out"
fi
if [ "$1" = "bootout" ] && [ ! -f "$FAKE_DIR/exit.bootout" ]; then
  echo "\${LINGER:-0}" > "$FAKE_DIR/lingers"
fi
if [ "$1" = "list" ]; then
  if [ -f "$FAKE_DIR/list.out" ]; then /bin/cat "$FAKE_DIR/list.out"; exit 0; fi
  echo "Could not find service \\"$2\\" in domain for port" >&2
  exit 113
fi
if [ "$1" = "kill" ] && [ -f "$FAKE_DIR/list.after-kill" ]; then
  /bin/mv "$FAKE_DIR/list.after-kill" "$FAKE_DIR/list.out"
fi
if [ -f "$FAKE_DIR/exit.$1" ]; then
  echo "launchctl $1 failed" >&2
  exit "$(/bin/cat "$FAKE_DIR/exit.$1")"
fi
echo "launchctl $1 output"
exit 0
`;

const FAKE_PLUTIL = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/plutil.log"
exec /usr/bin/plutil "$@"
`;

const FAKE_RECORDER = (name: string): string => `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/${name}.log"
if [ -f "$FAKE_DIR/exit.${name}" ]; then exit "$(/bin/cat "$FAKE_DIR/exit.${name}")"; fi
exit 0
`;

type Result = { code: number | null; stdout: string; stderr: string };

let root: string;
let home: string;
let fake: string;
let plist: string;
let logDir: string;

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function baseEnv(): Record<string, string> {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    FAKE_DIR: fake,
    BOOKCARRIER_LAUNCHCTL: join(fake, "launchctl"),
    BOOKCARRIER_PLUTIL: join(fake, "plutil"),
    BOOKCARRIER_NO_SWIFTBAR_REFRESH: "1",
  };
}

function run(
  args: string[],
  options: { script?: string; cwd?: string; env?: Record<string, string | undefined> } = {},
): Result {
  const env: Record<string, string> = baseEnv();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(options.script ?? SCRIPT, args, {
    cwd: options.cwd ?? root,
    env,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function loaded(state: "running" | "stopped" | "crashed"): void {
  copyFileSync(join(FIXTURES, `list-${state}.txt`), join(fake, "list.out"));
}

function afterKill(state: "running" | "stopped" | "crashed"): void {
  copyFileSync(join(FIXTURES, `list-${state}.txt`), join(fake, "list.after-kill"));
}

function failing(command: string, code = 5): void {
  writeFileSync(join(fake, `exit.${command}`), String(code));
}

function lines(file: string): string[] {
  const path = join(fake, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

const calls = (): string[] => lines("calls.log");

function installPlist(content = "existing plist\n"): void {
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, content);
}

/** A copy of the repo layout the script needs, so REPO resolves to a temp dir. */
function tempRepo(options: { dist?: boolean; plugin?: string; name?: string } = {}): string {
  const repo = join(root, options.name ?? "repo");
  mkdirSync(join(repo, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "bin", "bookcarrierctl"));
  chmodSync(join(repo, "bin", "bookcarrierctl"), 0o755);
  mkdirSync(join(repo, "launchd"), { recursive: true });
  copyFileSync(PLIST_TEMPLATE, join(repo, "launchd", `${LABEL}.plist`));
  if (options.dist ?? true) {
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "index.js"), "// built\n");
  }
  if (options.plugin !== undefined) {
    mkdirSync(join(repo, "swiftbar"), { recursive: true });
    writeFileSync(join(repo, "swiftbar", "bookcarrier.10s.sh.template"), options.plugin);
  }
  return repo;
}

/** Every file under `dir` with its content, to prove a command left it untouched. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    out[entry] = statSync(path).isDirectory() ? "<dir>" : readFileSync(path, "utf8");
  }
  return out;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bookcarrierctl-")));
  home = join(root, "home");
  fake = join(root, "fake");
  mkdirSync(home, { recursive: true });
  writeExecutable(join(fake, "launchctl"), FAKE_LAUNCHCTL);
  writeExecutable(join(fake, "plutil"), FAKE_PLUTIL);
  writeExecutable(join(fake, "tail"), FAKE_RECORDER("tail"));
  writeExecutable(join(fake, "open"), FAKE_RECORDER("open"));
  writeExecutable(join(fake, "node"), "#!/bin/bash\nexit 0\n");
  plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  logDir = join(home, "Library", "Logs", "Bookcarrier");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("T1 — status (R1, R6.1)", () => {
  it.each([
    { name: "not-installed", setup: (): void => {}, text: "Bookcarrier: not-installed · 0 in retry queue\n", porcelain: "state=not-installed\npid=-\nlast_exit=-\nqueue_items=0\nqueue_download=0\nqueue_send=0\n", code: 3 },
    { name: "not-loaded", setup: (): void => installPlist(), text: "Bookcarrier: not-loaded · 0 in retry queue\n", porcelain: "state=not-loaded\npid=-\nlast_exit=-\nqueue_items=0\nqueue_download=0\nqueue_send=0\n", code: 3 },
    { name: "running", setup: (): void => { installPlist(); loaded("running"); }, text: "Bookcarrier: running (PID 30046) · 0 in retry queue\n", porcelain: "state=running\npid=30046\nlast_exit=0\nqueue_items=0\nqueue_download=0\nqueue_send=0\n", code: 0 },
    { name: "stopped", setup: (): void => { installPlist(); loaded("stopped"); }, text: "Bookcarrier: stopped · 0 in retry queue\n", porcelain: "state=stopped\npid=-\nlast_exit=0\nqueue_items=0\nqueue_download=0\nqueue_send=0\n", code: 3 },
    { name: "crashed", setup: (): void => { installPlist(); loaded("crashed"); }, text: "Bookcarrier: crashed (last exit 9) · 0 in retry queue\n", porcelain: "state=crashed\npid=-\nlast_exit=9\nqueue_items=0\nqueue_download=0\nqueue_send=0\n", code: 3 },
  ])("$name: human text, --porcelain lines and exit code (R1.1, R1.2, R1.4, R1.5)", ({ setup, text, porcelain, code }) => {
    setup();
    const before = snapshot(home);

    expect(run(["status"])).toEqual({ code, stdout: text, stderr: "" });
    expect(run(["status", "--porcelain"])).toEqual({ code, stdout: porcelain, stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`, `list ${LABEL}`]);
    expect(snapshot(home)).toEqual(before);
  });

  describe("queue count (R1.3)", () => {
    function queueAt(content: string | undefined): string {
      const path = join(root, "custom", "queue.json");
      if (content !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      return path;
    }

    const stageRead = (path: string, index: number): string => `-extract items.${index}.stage raw -o - ${path}`;

    it("two items, one per stage → 2, 1 to download, 1 to send; one plutil call per item; also in the human text", () => {
      installPlist();
      loaded("running");
      const path = queueAt(
        '{"version":1,"items":[{"id":"a","stage":"download"},{"id":"b","stage":"upload"}]}',
      );

      expect(run(["status", "--porcelain"], { env: { BOOKCARRIER_QUEUE_FILE: path } })).toEqual({
        code: 0,
        stdout: "state=running\npid=30046\nlast_exit=0\nqueue_items=2\nqueue_download=1\nqueue_send=1\n",
        stderr: "",
      });
      expect(lines("plutil.log")).toEqual([`-extract items raw -o - ${path}`, stageRead(path, 0), stageRead(path, 1)]);
      expect(run(["status"], { env: { BOOKCARRIER_QUEUE_FILE: path } })).toEqual({
        code: 0,
        stdout: "Bookcarrier: running (PID 30046) · 2 in retry queue (1 to download, 1 to send)\n",
        stderr: "",
      });
    });

    it("empty items [] → 0, 0, 0 with a single plutil call", () => {
      const path = queueAt('{"version":1,"items":[]}');

      const result = run(["status", "--porcelain"], { env: { BOOKCARRIER_QUEUE_FILE: path } });

      expect(result).toEqual({
        code: 3,
        stdout: "state=not-installed\npid=-\nlast_exit=-\nqueue_items=0\nqueue_download=0\nqueue_send=0\n",
        stderr: "",
      });
      expect(lines("plutil.log")).toEqual([`-extract items raw -o - ${path}`]);
    });

    it("missing file → 0, 0, 0 without calling plutil", () => {
      const path = queueAt(undefined);

      const result = run(["status", "--porcelain"], { env: { BOOKCARRIER_QUEUE_FILE: path } });

      expect(result).toEqual({
        code: 3,
        stdout: "state=not-installed\npid=-\nlast_exit=-\nqueue_items=0\nqueue_download=0\nqueue_send=0\n",
        stderr: "",
      });
      expect(lines("plutil.log")).toEqual([]);
    });

    it("corrupt file → ?, ?, ? (and the file is left as it was); human text unchanged", () => {
      const path = queueAt('{"version":1,');

      const result = run(["status", "--porcelain"], { env: { BOOKCARRIER_QUEUE_FILE: path } });

      expect(result).toEqual({
        code: 3,
        stdout: "state=not-installed\npid=-\nlast_exit=-\nqueue_items=?\nqueue_download=?\nqueue_send=?\n",
        stderr: "",
      });
      expect(run(["status"], { env: { BOOKCARRIER_QUEUE_FILE: path } })).toEqual({
        code: 3,
        stdout: "Bookcarrier: not-installed · ? in retry queue\n",
        stderr: "",
      });
      expect(readFileSync(path, "utf8")).toBe('{"version":1,');
    });

    it("an item with no stage (or a null or unknown one) counts in the total but in neither stage", () => {
      const path = queueAt(
        '{"version":1,"items":[{"id":"a","stage":"upload"},{"id":"b"},{"id":"c","stage":null},{"id":"d","stage":"other"}]}',
      );

      const result = run(["status", "--porcelain"], { env: { BOOKCARRIER_QUEUE_FILE: path } });

      expect(result).toEqual({
        code: 3,
        stdout: "state=not-installed\npid=-\nlast_exit=-\nqueue_items=4\nqueue_download=0\nqueue_send=1\n",
        stderr: "",
      });
      expect(lines("plutil.log")).toEqual([
        `-extract items raw -o - ${path}`,
        stageRead(path, 0),
        stageRead(path, 1),
        stageRead(path, 2),
        stageRead(path, 3),
      ]);
    });

    it("defaults to ~/.bookcarrier/queue.json, like the daemon", () => {
      const path = join(home, ".bookcarrier", "queue.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"version":1,"items":[{"id":"a","stage":"download"}]}');

      const result = run(["status"]);

      expect(result).toEqual({
        code: 3,
        stdout: "Bookcarrier: not-installed · 1 in retry queue (1 to download, 0 to send)\n",
        stderr: "",
      });
      expect(lines("plutil.log")).toEqual([`-extract items raw -o - ${path}`, stageRead(path, 0)]);
    });
  });

  it("works through a relative symlink chain, from another directory, with no PATH (R6.1, R6.2)", () => {
    const repo = tempRepo({ plugin: "repo=__REPO__\n" });
    const links = join(root, "links");
    const elsewhere = join(root, "elsewhere");
    const plugins = join(root, "plugins");
    mkdirSync(links, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(plugins, { recursive: true });
    symlinkSync("../repo/bin/bookcarrierctl", join(links, "first"));
    symlinkSync("first", join(links, "ctl"));
    installPlist();
    loaded("running");
    const env = { PATH: "/var/empty" };

    expect(run(["status"], { script: join(links, "ctl"), cwd: elsewhere, env })).toEqual({
      code: 0,
      stdout: "Bookcarrier: running (PID 30046) · 0 in retry queue\n",
      stderr: "",
    });
    expect(run(["menubar", "install", plugins], { script: join(links, "ctl"), cwd: elsewhere, env }).code).toBe(0);
    expect(readFileSync(join(plugins, "bookcarrier.10s.sh"), "utf8")).toBe(`repo=${repo}\n`);
  });
});

describe("T2 — start, stop, restart (R2)", () => {
  it("start on not-loaded → bootstrap the plist", () => {
    installPlist();

    expect(run(["start"])).toEqual({ code: 0, stdout: "Started.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
    expect(readFileSync(plist, "utf8")).toBe("existing plist\n");
  });

  it.each(["stopped", "crashed"] as const)("start on %s → kickstart", (state) => {
    installPlist();
    loaded(state);

    expect(run(["start"])).toEqual({ code: 0, stdout: "Started.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`, `kickstart ${SERVICE}`]);
  });

  it("start on running → says so, no launchctl action, exit 0", () => {
    installPlist();
    loaded("running");

    expect(run(["start"])).toEqual({ code: 0, stdout: "Bookcarrier is already running (PID 30046).\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`]);
  });

  it("start when launchctl fails → exit 1 with a plain message", () => {
    installPlist();
    loaded("stopped");
    failing("kickstart");

    expect(run(["start"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not start Bookcarrier. Check: bookcarrierctl logs\n",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `kickstart ${SERVICE}`]);
  });

  it("stop sends SIGTERM once; PID gone → exit 0 with the Stopped message", () => {
    installPlist();
    loaded("running");
    afterKill("stopped");

    expect(run(["stop"])).toEqual({
      code: 0,
      stdout: "Stopped. launchd will not restart it until you run: bookcarrierctl start\n",
      stderr: "",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `kill SIGTERM ${SERVICE}`, `list ${LABEL}`]);
  });

  it("stop: the daemon exits with an error → exit 1, says launchd will relaunch it", () => {
    installPlist();
    loaded("running");
    afterKill("crashed");

    expect(run(["stop"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Bookcarrier exited with an error (last exit 9), so launchd will restart it. Check: bookcarrierctl logs\n",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `kill SIGTERM ${SERVICE}`, `list ${LABEL}`]);
  });

  it("stop: PID stays → exit 1 after the (shortened) wait, never SIGKILL", () => {
    installPlist();
    loaded("running");

    const started = Date.now();
    const result = run(["stop"], { env: { BOOKCARRIER_STOP_TIMEOUT: "1", BOOKCARRIER_STOP_POLL: "0.1" } });
    const elapsed = Date.now() - started;

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "Bookcarrier is still running after 1 seconds (PID 30046). It was not force-killed; check: bookcarrierctl logs\n",
    });
    const recorded = calls();
    expect(recorded.filter((call) => call.startsWith("kill"))).toEqual([`kill SIGTERM ${SERVICE}`]);
    expect(recorded.join("\n")).not.toContain("SIGKILL");
    expect(recorded[0]).toBe(`list ${LABEL}`);
    expect(recorded[1]).toBe(`kill SIGTERM ${SERVICE}`);
    expect(recorded.slice(2).length).toBeGreaterThanOrEqual(2);
    expect(recorded.slice(2).every((call) => call === `list ${LABEL}`)).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("stop when not running → says so, no kill, exit 0", () => {
    installPlist();
    loaded("stopped");

    expect(run(["stop"])).toEqual({ code: 0, stdout: "Bookcarrier is not running.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`]);
  });

  it("restart → kickstart -k", () => {
    installPlist();
    loaded("running");

    expect(run(["restart"])).toEqual({ code: 0, stdout: "Restarted.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`, `kickstart -k ${SERVICE}`]);
  });

  it("restart on not-loaded → bootstrap the plist (nothing to kickstart)", () => {
    installPlist();

    expect(run(["restart"])).toEqual({ code: 0, stdout: "Restarted.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
  });

  it("restart when kickstart -k fails → exit 1", () => {
    installPlist();
    loaded("running");
    failing("kickstart");

    expect(run(["restart"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not restart Bookcarrier. Check: bookcarrierctl logs\n",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `kickstart -k ${SERVICE}`]);
  });

  it("restart on not-loaded when bootstrap fails → exit 1", () => {
    installPlist();
    failing("bootstrap");

    expect(run(["restart"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not restart Bookcarrier. Check: bookcarrierctl logs\n",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
  });

  it("start on not-loaded when bootstrap fails → exit 1", () => {
    installPlist();
    failing("bootstrap");

    expect(run(["start"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not start Bookcarrier. Check: bookcarrierctl logs\n",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
  });

  it.each(["start", "stop", "restart"])("%s on not-installed → exit 1 pointing to install (R2.4)", (command) => {
    expect(run([command])).toEqual({ code: 1, stdout: "", stderr: NOT_INSTALLED });
    expect(calls()).toEqual([`list ${LABEL}`]);
    expect(existsSync(join(home, "Library"))).toBe(false);
  });

  it("refreshes SwiftBar after a state change and ignores a failing open", () => {
    installPlist();
    loaded("stopped");
    failing("open", 1);

    const result = run(["start"], {
      env: { BOOKCARRIER_NO_SWIFTBAR_REFRESH: undefined, BOOKCARRIER_OPEN: join(fake, "open") },
    });

    expect(result).toEqual({ code: 0, stdout: "Started.\n", stderr: "" });
    expect(lines("open.log")).toEqual(["-g swiftbar://refreshplugin?name=bookcarrier"]);
  });
});

describe("T3 — install, uninstall (R3)", () => {
  const nodeEnv = (): Record<string, string> => ({ BOOKCARRIER_NODE: join(fake, "node") });

  it("install writes the plist with absolute paths, creates the log dir, lints and bootstraps (R3.1)", () => {
    const repo = tempRepo();
    const template = readFileSync(PLIST_TEMPLATE, "utf8");

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result).toEqual({
      code: 0,
      stdout: `Installed ${plist} and loaded it. Check it with: bookcarrierctl status\n`,
      stderr: "",
    });
    const written = readFileSync(plist, "utf8");
    expect(written).toBe(template.replaceAll("__REPO__", repo).replaceAll("__HOME__", home));
    expect(written).not.toMatch(/__REPO__|__HOME__/);
    expect(written).toContain(`<string>${repo}/dist/index.js</string>`);
    expect(written).toContain(
      `<key>StandardOutPath</key>\n  <string>${home}/Library/Logs/Bookcarrier/bookcarrier.log</string>`,
    );
    expect(written).toContain(
      `<key>StandardErrorPath</key>\n  <string>${home}/Library/Logs/Bookcarrier/bookcarrier.log</string>`,
    );
    expect(written).not.toMatch(/bookcarrier\.(out|err)\.log/);
    expect(statSync(logDir).isDirectory()).toBe(true);
    expect(lines("plutil.log")).toEqual([expect.stringMatching(new RegExp(`^-lint ${dirname(plist)}/\\.${LABEL}\\.\\w{6}$`))]);
    expect(calls()).toEqual([`list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
  });

  it("install leaves the logs of an earlier install where they are (R3.5)", () => {
    const repo = tempRepo();
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "bookcarrier.out.log"), "old out\n");
    writeFileSync(join(logDir, "bookcarrier.err.log"), "old err\n");
    const before = snapshot(logDir);

    expect(run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() }).code).toBe(0);
    expect(snapshot(logDir)).toEqual(before);
  });

  it("reinstall with an invalid template leaves the old plist and the running job alone (R3.3)", () => {
    const repo = tempRepo();
    const template = join(repo, "launchd", `${LABEL}.plist`);
    writeFileSync(template, readFileSync(template, "utf8").replace("<key>RunAtLoad</key>", "<key>RunAtLoad</key><oops>"));
    installPlist("old plist\n");
    loaded("running");

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Cannot install: the generated plist is not valid: .+ Nothing was changed\.\n$/s);
    expect(readFileSync(plist, "utf8")).toBe("old plist\n");
    expect(readdirSync(dirname(plist))).toEqual([`${LABEL}.plist`]);
    expect(calls()).toEqual([]);
  });

  it("install escapes XML and keeps spaces, & and | in the repo path (R3.1)", () => {
    const repo = tempRepo({ name: "my repo & R|D <x>" });

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result).toEqual({
      code: 0,
      stdout: `Installed ${plist} and loaded it. Check it with: bookcarrierctl status\n`,
      stderr: "",
    });
    const argument = spawnSync("/usr/bin/plutil", ["-extract", "ProgramArguments.1", "raw", "-o", "-", plist], {
      encoding: "utf8",
    });
    expect(argument.stdout.trim()).toBe(`${repo}/dist/index.js`);
    expect(readdirSync(dirname(plist))).toEqual([`${LABEL}.plist`]);
  });

  it("install over an existing install → bootout, then bootstrap the new plist (R3.3)", () => {
    const repo = tempRepo();
    installPlist("old plist\n");
    loaded("running");

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(plist, "utf8")).not.toBe("old plist\n");
    expect(readFileSync(plist, "utf8")).not.toMatch(/__REPO__|__HOME__/);
    expect(calls()).toEqual([`list ${LABEL}`, `bootout ${SERVICE}`, `list ${LABEL}`, `bootstrap ${DOMAIN} ${plist}`]);
  });

  it("reinstall waits until launchd has unloaded the old job before bootstrap (R3.3)", () => {
    const repo = tempRepo();
    installPlist("old plist\n");
    loaded("running");

    const result = run(["install"], {
      script: join(repo, "bin", "bookcarrierctl"),
      env: { ...nodeEnv(), LINGER: "2", BOOKCARRIER_STOP_POLL: "0.05" },
    });

    expect(result).toEqual({
      code: 0,
      stdout: `Installed ${plist} and loaded it. Check it with: bookcarrierctl status\n`,
      stderr: "",
    });
    expect(calls()).toEqual([
      `list ${LABEL}`,
      `bootout ${SERVICE}`,
      `list ${LABEL}`,
      `list ${LABEL}`,
      `list ${LABEL}`,
      `bootstrap ${DOMAIN} ${plist}`,
    ]);
  });

  it("reinstall: launchd never unloads the old job → exit 1, old plist kept, no bootstrap (R3.3)", () => {
    const repo = tempRepo();
    installPlist("old plist\n");
    loaded("running");

    const result = run(["install"], {
      script: join(repo, "bin", "bookcarrierctl"),
      env: { ...nodeEnv(), LINGER: "100000", BOOKCARRIER_UNLOAD_TIMEOUT: "1", BOOKCARRIER_STOP_POLL: "0.05" },
    });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "launchd did not unload Bookcarrier within 1 seconds. Check: bookcarrierctl status, then run install again\n",
    });
    expect(readFileSync(plist, "utf8")).toBe("old plist\n");
    expect(readdirSync(dirname(plist))).toEqual([`${LABEL}.plist`]);
    expect(calls()).not.toContain(`bootstrap ${DOMAIN} ${plist}`);
  });

  it("install: bootstrap fails → exit 1 and shows launchctl's error (R3.1)", () => {
    const repo = tempRepo();
    failing("bootstrap");

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `Installed ${plist} but could not load it (launchctl: launchctl bootstrap failed). Check: bookcarrierctl logs\n`,
    });
  });

  it.each([
    {
      name: "missing node",
      dist: true,
      node: "missing",
      stderr: (_repo: string, node: string): string =>
        `Cannot install: Node 24 not found at ${node}. Run: brew install node@24\n`,
    },
    {
      name: "missing dist/index.js",
      dist: false,
      node: "present",
      stderr: (repo: string): string => `Cannot install: ${repo}/dist/index.js not found. Run: pnpm build\n`,
    },
    {
      name: "both missing",
      dist: false,
      node: "missing",
      stderr: (repo: string, node: string): string =>
        `Cannot install: Node 24 not found at ${node}. Run: brew install node@24\n` +
        `Cannot install: ${repo}/dist/index.js not found. Run: pnpm build\n`,
    },
  ])("$name → exit 1 naming the fix, nothing written, no launchctl call (R3.2)", ({ dist, node, stderr }) => {
    const repo = tempRepo({ dist });
    const nodePath = node === "present" ? join(fake, "node") : join(root, "no-node", "node");

    const result = run(["install"], {
      script: join(repo, "bin", "bookcarrierctl"),
      env: { BOOKCARRIER_NODE: nodePath },
    });

    expect(result).toEqual({ code: 1, stdout: "", stderr: stderr(repo, nodePath) });
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(calls()).toEqual([]);
    expect(lines("plutil.log")).toEqual([]);
  });

  it("a refused install leaves an existing plist untouched (R3.2)", () => {
    const repo = tempRepo({ dist: false });
    installPlist("old plist\n");
    const before = snapshot(home);

    const result = run(["install"], { script: join(repo, "bin", "bookcarrierctl"), env: nodeEnv() });

    expect(result.code).toBe(1);
    expect(snapshot(home)).toEqual(before);
    expect(calls()).toEqual([]);
  });

  it("uninstall → bootout + plist removed; logs, queue and spool untouched (R3.4)", () => {
    installPlist();
    loaded("running");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "bookcarrier.log"), "log\n");
    mkdirSync(join(home, ".bookcarrier", "spool"), { recursive: true });
    writeFileSync(join(home, ".bookcarrier", "queue.json"), '{"version":1,"items":[]}');
    writeFileSync(join(home, ".bookcarrier", "spool", "a.epub"), "epub");
    const logsBefore = snapshot(logDir);
    const dataBefore = snapshot(join(home, ".bookcarrier"));

    expect(run(["uninstall"])).toEqual({
      code: 0,
      stdout: "Uninstalled. Logs, queue and spool were kept.\n",
      stderr: "",
    });
    expect(calls()).toEqual([`list ${LABEL}`, `bootout ${SERVICE}`]);
    expect(existsSync(plist)).toBe(false);
    expect(snapshot(logDir)).toEqual(logsBefore);
    expect(snapshot(join(home, ".bookcarrier"))).toEqual(dataBefore);
  });

  it("uninstall on not-loaded → no bootout, plist removed", () => {
    installPlist();

    expect(run(["uninstall"])).toEqual({
      code: 0,
      stdout: "Uninstalled. Logs, queue and spool were kept.\n",
      stderr: "",
    });
    expect(calls()).toEqual([`list ${LABEL}`]);
    expect(existsSync(plist)).toBe(false);
  });

  it("uninstall when bootout fails → exit 1, plist kept", () => {
    installPlist();
    loaded("running");
    failing("bootout");

    expect(run(["uninstall"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not unload Bookcarrier; the plist was kept.\n",
    });
    expect(readFileSync(plist, "utf8")).toBe("existing plist\n");
  });

  it("uninstall on not-installed → nothing to do, exit 0", () => {
    expect(run(["uninstall"])).toEqual({ code: 0, stdout: "Bookcarrier is not installed.\n", stderr: "" });
    expect(calls()).toEqual([`list ${LABEL}`]);
  });
});

describe("T4 — logs, usage, errors (R4, R6.3)", () => {
  it("usage works with no binaries in PATH (R6.2)", () => {
    expect(run(["foo"], { env: { PATH: "/var/empty" } })).toEqual({
      code: 2,
      stdout: "",
      stderr: "Unknown command: foo\n" + USAGE,
    });
  });

  it("logs prints the last 50 lines of bookcarrier.log only (R4.1)", () => {
    mkdirSync(logDir, { recursive: true });
    const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(logDir, "bookcarrier.log"), `${log.join("\n")}\n`);
    // Files from installs before R3.5 are left alone and not shown.
    writeFileSync(join(logDir, "bookcarrier.out.log"), "old out\n");
    writeFileSync(join(logDir, "bookcarrier.err.log"), "old err\n");
    const before = snapshot(logDir);

    expect(run(["logs"])).toEqual({ code: 0, stdout: `${log.slice(10).join("\n")}\n`, stderr: "" });
    expect(calls()).toEqual([]);
    expect(snapshot(logDir)).toEqual(before);
  });

  it.each(["-f", "--follow"])("logs %s follows bookcarrier.log with tail -F (R4.2)", (flag) => {
    expect(run(["logs", flag], { env: { BOOKCARRIER_TAIL: join(fake, "tail") } })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(lines("tail.log")).toEqual([`-F -n 50 ${logDir}/bookcarrier.log`]);
  });

  it.each([
    { args: ["foo"], message: "Unknown command: foo\n" },
    { args: ["status", "--json"], message: "Unknown option: --json\n" },
    { args: ["start", "now"], message: "Unknown option: now\n" },
    { args: ["logs", "-x"], message: "Unknown option: -x\n" },
    { args: ["menubar"], message: "Unknown command: menubar\n" },
    { args: ["menubar", "install"], message: "Missing the SwiftBar plugin folder.\n" },
    { args: ["menubar", "install", "a", "b"], message: "Unknown option: b\n" },
    { args: [], message: "" },
  ])("$args → usage on stderr, exit 2, nothing done (R6.3)", ({ args, message }) => {
    expect(run(args)).toEqual({ code: 2, stdout: "", stderr: message + USAGE });
    expect(calls()).toEqual([]);
    expect(snapshot(home)).toEqual({});
  });

  it("help → usage on stderr, exit 0", () => {
    expect(run(["help"])).toEqual({ code: 0, stdout: "", stderr: USAGE });
  });
});

describe("T5 — menubar install (R5.8)", () => {
  const template = "#!/bin/bash\nCTL=__REPO__/bin/bookcarrierctl\necho __REPO__\n";

  it("writes <dir>/bookcarrier.10s.sh, executable, with the repo's absolute path filled in", () => {
    const repo = tempRepo({ plugin: template });
    const plugins = join(root, "plugins");
    mkdirSync(plugins, { recursive: true });
    const target = join(plugins, "bookcarrier.10s.sh");

    const result = run(["menubar", "install", plugins], { script: join(repo, "bin", "bookcarrierctl") });

    expect(result).toEqual({ code: 0, stdout: `Installed the menu bar plugin: ${target}\n`, stderr: "" });
    expect(readFileSync(target, "utf8")).toBe(`#!/bin/bash\nCTL=${repo}/bin/bookcarrierctl\necho ${repo}\n`);
    expect(statSync(target).mode & 0o111).toBe(0o111);
    expect(calls()).toEqual([]);
  });

  it("replaces an existing plugin atomically: executable, filled in, no temp files left", () => {
    const repo = tempRepo({ plugin: template });
    const plugins = join(root, "plugins");
    mkdirSync(plugins, { recursive: true });
    const target = join(plugins, "bookcarrier.10s.sh");
    writeFileSync(target, "old plugin\n");
    chmodSync(target, 0o644);

    const result = run(["menubar", "install", plugins], { script: join(repo, "bin", "bookcarrierctl") });

    expect(result).toEqual({ code: 0, stdout: `Installed the menu bar plugin: ${target}\n`, stderr: "" });
    const content = readFileSync(target, "utf8");
    expect(content).toBe(`#!/bin/bash\nCTL=${repo}/bin/bookcarrierctl\necho ${repo}\n`);
    expect(content).not.toContain("__REPO__");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(plugins)).toEqual(["bookcarrier.10s.sh"]);
  });

  it("a failing fill step → exit 1, the previous plugin untouched and executable, no temp file", () => {
    const repo = tempRepo({ plugin: template });
    const plugins = join(root, "plugins");
    mkdirSync(plugins, { recursive: true });
    const target = join(plugins, "bookcarrier.10s.sh");
    writeExecutable(target, "#!/bin/bash\necho old\n");
    chmodSync(join(repo, "swiftbar", "bookcarrier.10s.sh.template"), 0o000);

    const result = run(["menubar", "install", plugins], { script: join(repo, "bin", "bookcarrierctl") });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Could not write the menu bar plugin; the existing plugin was kept.\n",
    });
    expect(readFileSync(target, "utf8")).toBe("#!/bin/bash\necho old\n");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(plugins)).toEqual(["bookcarrier.10s.sh"]);
  });

  it("a missing folder → exit 1, nothing written", () => {
    const repo = tempRepo({ plugin: template });
    const missing = join(root, "no-such-folder");

    const result = run(["menubar", "install", missing], { script: join(repo, "bin", "bookcarrierctl") });

    expect(result).toEqual({ code: 1, stdout: "", stderr: `Plugin folder not found: ${missing}\n` });
    expect(existsSync(missing)).toBe(false);
  });

  it("a missing template → exit 1, nothing written", () => {
    const repo = tempRepo();
    const plugins = join(root, "plugins");
    mkdirSync(plugins, { recursive: true });

    const result = run(["menubar", "install", plugins], { script: join(repo, "bin", "bookcarrierctl") });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `Plugin template not found: ${repo}/swiftbar/bookcarrier.10s.sh.template\n`,
    });
    expect(readdirSync(plugins)).toEqual([]);
  });
});
