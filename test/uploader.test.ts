import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadConfigError,
  UploadFailedError,
  type UploadOptions,
  uploadToKindle,
} from "../src/uploader.js";

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
  dir = await mkdtemp(join(tmpdir(), "bookcarrier-up-"));
  keyPath = join(dir, "kindle_key");
  await writeFile(keyPath, "fake-private-key");
  await chmod(keyPath, 0o600);
  child = new FakeChild();
  spawnMock.mockReturnValue(child);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const opts = (overrides: Partial<UploadOptions> = {}): UploadOptions => ({
  sshKeyPath: keyPath,
  kindleUser: "root",
  kindleHost: "192.168.1.50",
  port: 2222,
  remotePath: "/mnt/us/documents/books/AO3/",
  connectTimeoutSec: 10,
  timeoutMs: 60_000,
  ...overrides,
});

const FILE = "/tmp/work/65164981-Title_ Fooled Around (And Fell in Love).epub";

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

describe("uploadToKindle — key check before launching (R5.2)", () => {
  it("missing key → UploadConfigError and spawn is NOT called", async () => {
    const err = await rejection(
      uploadToKindle(FILE, opts({ sshKeyPath: join(dir, "nope") })),
    );
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ problem: "key-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a directory instead of a file → key-missing, spawn NOT called", async () => {
    const sub = join(dir, "adir");
    await mkdir(sub);
    expect(
      await rejection(uploadToKindle(FILE, opts({ sshKeyPath: sub }))),
    ).toMatchObject({
      problem: "key-missing",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([0o600, 0o400, 0o700])(
    "mode %o is accepted and scp is launched",
    async (mode) => {
      await chmod(keyPath, mode);
      const promise = uploadToKindle(FILE, opts());
      await spawned();
      child.emit("close", 0, null);
      await expect(promise).resolves.toBeUndefined();
    },
  );

  it("644 → open permissions, names them, spawn NOT called", async () => {
    await chmod(keyPath, 0o644);
    const err = await rejection(uploadToKindle(FILE, opts()));
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ problem: "key-permissions-open" });
    expect(String(err)).toContain("644");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("640 → fails (the group can read it)", async () => {
    await chmod(keyPath, 0o640);
    expect(await rejection(uploadToKindle(FILE, opts()))).toMatchObject({
      problem: "key-permissions-open",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("000 → fails (the owner cannot read it)", async () => {
    await chmod(keyPath, 0o000);
    const err = await rejection(uploadToKindle(FILE, opts()));
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).toMatchObject({ problem: "key-unreadable" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("uploadToKindle — how scp is launched (R5.1, R5.6, R5.8)", () => {
  it("builds the exact command: -P port, ConnectTimeout, BatchMode, key, file, user@host:path", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    const [bin, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(bin).toBe("scp");
    expect(args).toEqual([
      "-P",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-i",
      keyPath,
      FILE,
      "root@192.168.1.50:/mnt/us/documents/books/AO3/",
    ]);
    expect(options).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
    child.emit("close", 0, null);
    await promise;
  });

  it("includes -o BatchMode=yes (R5.6)", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    const args: string[] = spawnMock.mock.calls[0]?.[1];
    expect(args.join(" ")).toContain("-o BatchMode=yes");
    child.emit("close", 0, null);
    await promise;
  });

  it("uses UPPERCASE -P with opts.port and never lowercase -p (R5.8)", async () => {
    const promise = uploadToKindle(FILE, opts({ port: 22 }));
    await spawned();
    const args: string[] = spawnMock.mock.calls[0]?.[1];
    expect(args[args.indexOf("-P") + 1]).toBe("22");
    expect(args).toContain("-P");
    expect(args).not.toContain("-p");
    child.emit("close", 0, null);
    await promise;
  });

  it("takes ConnectTimeout, user, host and remote path from opts", async () => {
    const promise = uploadToKindle(
      FILE,
      opts({
        connectTimeoutSec: 3,
        kindleUser: "me",
        kindleHost: "kindle.lan",
        remotePath: "/x/",
      }),
    );
    await spawned();
    const args: string[] = spawnMock.mock.calls[0]?.[1];
    expect(args).toContain("ConnectTimeout=3");
    expect(args.at(-1)).toBe("me@kindle.lan:/x/");
    child.emit("close", 0, null);
    await promise;
  });
});

describe("uploadToKindle — outcomes", () => {
  it("exit 0 → resolves", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    child.emit("close", 0, null);
    await expect(promise).resolves.toBeUndefined();
  });

  it("'error' ENOENT → UploadConfigError naming scp, not a send failure (R5.5)", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    child.emit(
      "error",
      Object.assign(new Error("spawn scp ENOENT"), { code: "ENOENT" }),
    );
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(UploadConfigError);
    expect(err).not.toBeInstanceOf(UploadFailedError);
    expect(err).toMatchObject({ problem: "binary-not-found" });
    expect(String(err)).toContain("scp");
    expect(String(err)).toContain("ENOENT");
  });

  it("'error' EACCES is a config error too", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    child.emit(
      "error",
      Object.assign(new Error("spawn scp EACCES"), { code: "EACCES" }),
    );
    expect(await rejection(promise)).toBeInstanceOf(UploadConfigError);
  });

  // R5.3, R5.7: every non-zero exit is the same kind of failure; the code's value is never inspected.
  it.each([1, 2, 127, 255])(
    "exit %i → UploadFailedError, same class and reason",
    async (code) => {
      const promise = uploadToKindle(FILE, opts());
      await spawned();
      child.emit("close", code, null);
      const err = await rejection(promise);
      expect(err).toBeInstanceOf(UploadFailedError);
      expect(err).not.toBeInstanceOf(UploadConfigError);
      expect(err).toMatchObject({ reason: "exit-code" });
    },
  );

  it("killed by a signal (no exit code) → send failure", async () => {
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    child.emit("close", null, "SIGTERM");
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(UploadFailedError);
    expect(String(err)).toContain("SIGTERM");
  });

  it("puts only the last two stderr lines in the message (cause + scp's generic line), the full tail in .stderr", async () => {
    // Real output captured from scp against an unreachable Kindle, with extra noise in front.
    const stderr =
      "debug1: lots of ssh noise\r\nssh: connect to host 192.168.1.50 port 2222: Host is down\r\nscp: Connection closed\r\n";
    const promise = uploadToKindle(FILE, opts());
    await spawned();
    child.stderr.write(stderr);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 255, null);
    const err = await rejection(promise);
    expect(String(err)).toContain("Host is down");
    expect(String(err)).toContain("scp: Connection closed");
    expect(String(err)).not.toContain("debug1");
    expect(err).toMatchObject({ stderr });
  });
});

describe("uploadToKindle — own timeout", () => {
  it("timeout exceeded → UploadFailedError('timeout') and the process is killed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = uploadToKindle(FILE, opts({ timeoutMs: 5_000 }));
    const assertion = expect(rejection(promise)).resolves.toMatchObject({
      reason: "timeout",
    });
    await spawned();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a late 'close' after the timeout does not settle twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = uploadToKindle(FILE, opts({ timeoutMs: 1_000 }));
    const assertion = expect(rejection(promise)).resolves.toBeInstanceOf(
      UploadFailedError,
    );
    await spawned();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(() => child.emit("close", 0, null)).not.toThrow();
  });

  it("finishing in time kills nothing and leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = uploadToKindle(FILE, opts({ timeoutMs: 5_000 }));
    await spawned();
    child.emit("close", 0, null);
    await promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
