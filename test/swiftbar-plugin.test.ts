import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Feature 4, T5: the SwiftBar plugin template, run unfilled against a fake bookcarrierctl.
const TEMPLATE = resolve(import.meta.dirname, "..", "swiftbar", "bookcarrier.10s.sh.template");

type Run = { status: number | null; stdout: string; stderr: string };

let dir: string;
let home: string;
let emptyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-swiftbar-"));
  home = join(dir, "home");
  emptyPath = join(dir, "empty-path");
  await mkdir(home);
  await mkdir(emptyPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a fake bookcarrierctl that records its arguments, prints `output` and exits with `code`. */
async function fakeCtl(output: string, code = 0, path = join(dir, "bookcarrierctl")): Promise<string> {
  const quoted = output.replaceAll("'", `'"'"'`);
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "calls.log")}'\nprintf '%s' '${quoted}'\nexit ${code}\n`,
  );
  await chmod(path, 0o755);
  return path;
}

function porcelain(state: string, pid: string, lastExit: string, queueItems: string, download: string, send: string): string {
  return `state=${state}\npid=${pid}\nlast_exit=${lastExit}\nqueue_items=${queueItems}\nqueue_download=${download}\nqueue_send=${send}\n`;
}

/** Runs a plugin script with a minimal environment: temp HOME and a PATH with no binaries in it (R6.2). */
function runPlugin(script: string, env: Record<string, string> = {}): Run {
  const result = spawnSync(script, [], {
    env: { HOME: home, PATH: emptyPath, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function lines(...all: string[]): string {
  return `${all.join("\n")}\n`;
}

function openLines(queueFile = join(home, ".bookcarrier", "queue.json")): string[] {
  return [
    `Open logs | bash=/usr/bin/open param0=-a param1=Console param2=${home}/Library/Logs/Bookcarrier/bookcarrier.out.log terminal=false`,
    `Open spool folder | bash=/usr/bin/open param0=${home}/.bookcarrier/spool terminal=false`,
    `Open queue file | bash=/usr/bin/open param0=${queueFile} terminal=false`,
  ];
}

function action(title: string, ctl: string, command: string): string {
  return `${title} | bash=${ctl} param0=${command} terminal=false refresh=true`;
}

async function calls(): Promise<string> {
  return readFile(join(dir, "calls.log"), "utf8");
}

describe("SwiftBar plugin: output per state (R5.1–R5.3)", () => {
  it("running → book.fill, PID, queue split by stage (1 + 1), Stop and Restart only", async () => {
    const ctl = await fakeCtl(porcelain("running", "30046", "0", "2", "1", "1"), 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.fill",
        "---",
        "Running · PID 30046",
        "Retry queue: 1 to download · 1 to send",
        "---",
        action("Stop", ctl, "stop"),
        action("Restart", ctl, "restart"),
        "---",
        ...openLines(),
      ),
    );
    expect(await calls()).toBe("status --porcelain\n");
  });

  it("stopped (status exits 3, not a failure) → book, Stopped, empty queue, Start only", async () => {
    const ctl = await fakeCtl(porcelain("stopped", "-", "0", "0", "0", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      lines("| sfimage=book", "---", "Stopped", "Retry queue: empty", "---", action("Start", ctl, "start"), "---", ...openLines()),
    );
  });

  it("not-loaded → same look as stopped, Start only", async () => {
    const ctl = await fakeCtl(porcelain("not-loaded", "-", "-", "1", "1", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines("| sfimage=book", "---", "Stopped", "Retry queue: 1 to download · 0 to send", "---", action("Start", ctl, "start"), "---", ...openLines()),
    );
  });

  it("crashed → warning triangle with the last exit status, Start only", async () => {
    const ctl = await fakeCtl(porcelain("crashed", "-", "9", "0", "0", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=exclamationmark.triangle.fill",
        "---",
        "Crashed (last exit 9) — launchd will retry",
        "Retry queue: empty",
        "---",
        action("Start", ctl, "start"),
        "---",
        ...openLines(),
      ),
    );
  });

  it("not-installed → book.closed, Not installed, Install only", async () => {
    const ctl = await fakeCtl(porcelain("not-installed", "-", "-", "0", "0", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.closed",
        "---",
        "Not installed",
        "Retry queue: empty",
        "---",
        action("Install", ctl, "install"),
        "---",
        ...openLines(),
      ),
    );
  });

  it("an unreadable queue (queue_items=?) → 'Retry queue unreadable'", async () => {
    const ctl = await fakeCtl(porcelain("running", "12", "0", "?", "?", "?"), 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.fill",
        "---",
        "Running · PID 12",
        "Retry queue unreadable",
        "---",
        action("Stop", ctl, "stop"),
        action("Restart", ctl, "restart"),
        "---",
        ...openLines(),
      ),
    );
  });

  it("two items waiting to download, none to send → both parts, the 0 included", async () => {
    const ctl = await fakeCtl(porcelain("running", "30046", "0", "2", "2", "0"), 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.fill",
        "---",
        "Running · PID 30046",
        "Retry queue: 2 to download · 0 to send",
        "---",
        action("Stop", ctl, "stop"),
        action("Restart", ctl, "restart"),
        "---",
        ...openLines(),
      ),
    );
  });

  it.each([
    { name: "the stage keys missing (older bookcarrierctl)", output: "state=running\npid=12\nlast_exit=0\nqueue_items=2\n" },
    { name: "queue_download=?", output: porcelain("running", "12", "0", "2", "?", "1") },
    { name: "queue_send=?", output: porcelain("running", "12", "0", "2", "1", "?") },
  ])("$name → 'Retry queue unreadable'", async ({ output }) => {
    const ctl = await fakeCtl(output, 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.fill",
        "---",
        "Running · PID 12",
        "Retry queue unreadable",
        "---",
        action("Stop", ctl, "stop"),
        action("Restart", ctl, "restart"),
        "---",
        ...openLines(),
      ),
    );
  });

  it("Open queue file follows BOOKCARRIER_QUEUE_FILE, like bookcarrierctl", async () => {
    const ctl = await fakeCtl(porcelain("stopped", "-", "0", "0", "0", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl, BOOKCARRIER_QUEUE_FILE: "/data/custom/queue.json" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book",
        "---",
        "Stopped",
        "Retry queue: empty",
        "---",
        action("Start", ctl, "start"),
        "---",
        ...openLines("/data/custom/queue.json"),
      ),
    );
  });
});

describe("SwiftBar plugin: actions and paths (R5.4, R5.5, R6.2)", () => {
  it("every clickable line uses an absolute bash= path and terminal=false; ctl actions also refresh=true", async () => {
    const ctl = await fakeCtl(porcelain("running", "1", "0", "0", "0", "0"), 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    const clickable = run.stdout.split("\n").filter((line) => line.includes("bash="));
    expect(clickable).toHaveLength(5);
    for (const line of clickable) {
      expect(line).toMatch(/ bash=\/\S+ /);
      expect(line).toContain(" terminal=false");
    }
    expect(clickable.filter((line) => line.includes(`bash=${ctl} `))).toEqual([
      action("Stop", ctl, "stop"),
      action("Restart", ctl, "restart"),
    ]);
  });

  it("without an override it calls __REPO__/bin/bookcarrierctl once the placeholder is filled", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, "bin"), { recursive: true });
    const ctl = await fakeCtl(porcelain("running", "7", "0", "3", "1", "2"), 0, join(repo, "bin", "bookcarrierctl"));
    const filled = join(dir, "bookcarrier.10s.sh");
    await writeFile(filled, (await readFile(TEMPLATE, "utf8")).replaceAll("__REPO__", repo));
    await chmod(filled, 0o755);

    const run = runPlugin(filled);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=book.fill",
        "---",
        "Running · PID 7",
        "Retry queue: 1 to download · 2 to send",
        "---",
        action("Stop", ctl, "stop"),
        action("Restart", ctl, "restart"),
        "---",
        ...openLines(),
      ),
    );
    expect(await calls()).toBe("status --porcelain\n");
  });

  it("the template is an executable Bash script that hides SwiftBar's own menu items", async () => {
    const source = await readFile(TEMPLATE, "utf8");
    const mode = (await stat(TEMPLATE)).mode;

    expect(source.startsWith("#!/bin/bash\n")).toBe(true);
    expect(mode & 0o111).not.toBe(0);
    for (const tag of ["hideAbout", "hideRunInTerminal", "hideLastUpdated", "hideDisablePlugin"]) {
      expect(source).toContain(`<swiftbar.${tag}>true</swiftbar.${tag}>`);
    }
    expect(source).toContain("__REPO__/bin/bookcarrierctl");
  });
});

describe("SwiftBar plugin: bookcarrierctl missing or failing (R5.7)", () => {
  it("ctl missing → question mark icon and the error, no actions", () => {
    const missing = join(dir, "nope", "bookcarrierctl");

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: missing });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines("| sfimage=questionmark.circle", "---", `bookcarrierctl not found or not executable: ${missing}`, "---", ...openLines()),
    );
  });

  it("unfilled template without override → the error names the __REPO__ path", () => {
    const run = runPlugin(TEMPLATE);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=questionmark.circle",
        "---",
        "bookcarrierctl not found or not executable: __REPO__/bin/bookcarrierctl",
        "---",
        ...openLines(),
      ),
    );
  });

  it("ctl present but not executable → same error", async () => {
    const ctl = await fakeCtl(porcelain("running", "1", "0", "0", "0", "0"), 0);
    await chmod(ctl, 0o644);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.stdout).toBe(
      lines("| sfimage=questionmark.circle", "---", `bookcarrierctl not found or not executable: ${ctl}`, "---", ...openLines()),
    );
  });

  it("ctl exits with an error code → the exit code and its first output line", async () => {
    const ctl = await fakeCtl("Something broke | badly\nsecond line\n", 1);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "| sfimage=questionmark.circle",
        "---",
        "bookcarrierctl status failed (exit 1): Something broke / badly",
        "---",
        ...openLines(),
      ),
    );
  });

  it("ctl exits with an error code and prints nothing → the exit code alone", async () => {
    const ctl = await fakeCtl("", 2);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.stdout).toBe(
      lines("| sfimage=questionmark.circle", "---", "bookcarrierctl status failed (exit 2)", "---", ...openLines()),
    );
  });

  it("ctl exits 0 but prints no state= line → error", async () => {
    const ctl = await fakeCtl("pid=1\nqueue_items=0\n", 0);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.stdout).toBe(
      lines("| sfimage=questionmark.circle", "---", "bookcarrierctl status gave no state", "---", ...openLines()),
    );
  });

  it("ctl prints an unknown state → error naming it", async () => {
    const ctl = await fakeCtl(porcelain("sleeping", "-", "-", "0", "0", "0"), 3);

    const run = runPlugin(TEMPLATE, { BOOKCARRIER_CTL: ctl });

    expect(run.stdout).toBe(
      lines("| sfimage=questionmark.circle", "---", "bookcarrierctl status gave an unknown state: sleeping", "---", ...openLines()),
    );
  });
});
