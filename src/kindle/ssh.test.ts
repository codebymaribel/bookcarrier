import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertKeyUsable,
  commonSshArgs,
  existsOnKindle,
  type SshTarget,
  UploadConfigError,
  UploadFailedError,
} from "./ssh.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

/** Stand-in for a ChildProcess: the test decides when and how it "finishes". */
class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

let dir: string;
let keyPath: string;
let child: FakeChild;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-ssh-"));
  keyPath = join(dir, "kindle_key");
  await writeFile(keyPath, "fake-private-key");
  await chmod(keyPath, 0o600);
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const target = (overrides: Partial<SshTarget> = {}): SshTarget => ({
  sshKeyPath: keyPath,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  port: 2222,
  connectTimeoutSec: 10,
  timeoutMs: 60_000,
  ...overrides,
});

const REMOTE = "/mnt/us/documents/books/it's $(reboot).pdf";

/** Waits (real I/O, not timers) until `spawn` has been called: the key check is async. */
async function spawned(): Promise<void> {
  for (let i = 0; i < 200 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(spawnMock).toHaveBeenCalled();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err,
  );
}

describe("commonSshArgs", () => {
  it("returns ConnectTimeout, BatchMode=yes and -i <key>, and no port flag", () => {
    const args = commonSshArgs(target({ connectTimeoutSec: 7 }));
    expect(args).toEqual(["-o", "ConnectTimeout=7", "-o", "BatchMode=yes", "-i", keyPath]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-P");
    expect(args).not.toContain("2222");
  });
});

describe("assertKeyUsable (feature 1's R5.2, moved from uploader.ts)", () => {
  it.each([0o600, 0o400, 0o700])("mode %o is accepted", async (mode) => {
    await chmod(keyPath, mode);
    await expect(assertKeyUsable(keyPath)).resolves.toBeUndefined();
  });

  it("missing key → key-missing", async () => {
    const err = await rejection(assertKeyUsable(join(dir, "nope")));
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ problem: "key-missing" });
  });

  it("a directory instead of a file → key-missing", async () => {
    const sub = join(dir, "adir");
    await mkdir(sub);
    expect(await rejection(assertKeyUsable(sub))).toMatchObject({ problem: "key-missing" });
  });

  it.each([0o644, 0o640])("mode %o → key-permissions-open, naming the mode", async (mode) => {
    await chmod(keyPath, mode);
    const err = await rejection(assertKeyUsable(keyPath));
    expect(err).toMatchObject({ problem: "key-permissions-open" });
    expect(String(err)).toContain(mode.toString(8));
  });

  it("000 → key-unreadable", async () => {
    await chmod(keyPath, 0o000);
    expect(await rejection(assertKeyUsable(keyPath))).toMatchObject({ problem: "key-unreadable" });
  });
});

describe("existsOnKindle — how ssh is launched (R4.1–R4.3)", () => {
  it("exact arguments: -p port, common options, user@host and ONE quoted `test -e` argument", async () => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    const [bin, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(bin).toBe("ssh");
    expect(args).toEqual([
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-i",
      keyPath,
      "root@192.168.1.50",
      "test -e '/mnt/us/documents/books/it'\\''s $(reboot).pdf'",
    ]);
    expect(options).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
    child.emit("close", 1, null);
    await promise;
  });

  it("uses LOWERCASE -p with the port and never uppercase -P (R4.3)", async () => {
    const promise = existsOnKindle(REMOTE, target({ port: 22 }));
    await spawned();
    const args: string[] = spawnMock.mock.calls[0]?.[1];
    expect(args[args.indexOf("-p") + 1]).toBe("22");
    expect(args).not.toContain("-P");
    child.emit("close", 1, null);
    await promise;
  });

  it("takes ConnectTimeout, user and host from the target", async () => {
    const promise = existsOnKindle(
      "/x/a.pdf",
      target({ connectTimeoutSec: 3, kindleUser: "me", kindleHost: "kindle.lan" }),
    );
    await spawned();
    const args: string[] = spawnMock.mock.calls[0]?.[1];
    expect(args).toContain("ConnectTimeout=3");
    expect(args.at(-2)).toBe("me@kindle.lan");
    expect(args.at(-1)).toBe("test -e '/x/a.pdf'");
    child.emit("close", 1, null);
    await promise;
  });
});

describe("existsOnKindle — outcomes (R4.5–R4.8)", () => {
  it("exit 0 → true (R4.5)", async () => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.emit("close", 0, null);
    await expect(promise).resolves.toBe(true);
  });

  it("exit 1 → false (R4.6)", async () => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.emit("close", 1, null);
    await expect(promise).resolves.toBe(false);
  });

  it.each([255, 2, 127])("exit %i → UploadFailedError('exit-code') (R4.7)", async (code) => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.emit("close", code, null);
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(UploadFailedError);
    expect(err).not.toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ reason: "exit-code" });
    expect(String(err)).toContain(String(code));
  });

  it("killed by a signal → UploadFailedError('exit-code') naming the signal (R4.7)", async () => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.emit("close", null, "SIGTERM");
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(UploadFailedError);
    expect(err).toMatchObject({ reason: "exit-code" });
    expect(String(err)).toContain("SIGTERM");
  });

  it("exit 255 puts ssh's last stderr lines in the message and the full tail in .stderr", async () => {
    const stderr =
      "debug1: noise\r\nssh: connect to host 192.168.1.50 port 2222: Host is down\r\n";
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.stderr.write(stderr);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 255, null);
    const err = await rejection(promise);
    expect(String(err)).toContain("Host is down");
    expect(err).toMatchObject({ stderr });
  });

  it("'error' event → UploadConfigError('binary-not-found') naming ssh (R4.8)", async () => {
    const promise = existsOnKindle(REMOTE, target());
    await spawned();
    child.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).not.toBeInstanceOf(UploadFailedError);
    expect(err).toMatchObject({ problem: "binary-not-found" });
    expect(String(err)).toContain('"ssh"');
    expect(String(err)).toContain("ENOENT");
  });

  it("unusable key → UploadConfigError and spawn is NOT called (R4.4)", async () => {
    await chmod(keyPath, 0o644);
    const err = await rejection(existsOnKindle(REMOTE, target()));
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ problem: "key-permissions-open" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("missing key → UploadConfigError('key-missing'), spawn NOT called (R4.4)", async () => {
    const err = await rejection(existsOnKindle(REMOTE, target({ sshKeyPath: join(dir, "nope") })));
    expect(err).toMatchObject({ problem: "key-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("existsOnKindle — own timeout (R4.7)", () => {
  it("no close before timeoutMs → UploadFailedError('timeout') and the child is killed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = existsOnKindle(REMOTE, target({ timeoutMs: 5_000 }));
    const assertion = expect(rejection(promise)).resolves.toMatchObject({ reason: "timeout" });
    await spawned();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a late 'close' after the timeout does not settle twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = existsOnKindle(REMOTE, target({ timeoutMs: 1_000 }));
    const assertion = expect(rejection(promise)).resolves.toBeInstanceOf(UploadFailedError);
    await spawned();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(() => child.emit("close", 0, null)).not.toThrow();
  });

  it("finishing in time kills nothing and leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = existsOnKindle(REMOTE, target({ timeoutMs: 5_000 }));
    await spawned();
    child.emit("close", 1, null);
    await promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
