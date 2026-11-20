# Research — Feature 2: Retry Queue

Date: 2026-11-17

## Atomic writes of the state file

- Node's `fs.writeFile` **is not atomic**: if the process dies halfway through the write, a reader may find truncated JSON, an empty file or a broken config. For a state file that is the queue's only source of truth, this is unacceptable.
- The correct pattern is *write-to-temp-then-rename*: write the full content to a temporary file **in the same directory** (rename is only atomic within the same mount), optionally `fsync` to force it to disk, and only then rename over the destination. If the process dies midway, the half-written bytes stay in the temp file and the real file remains intact with the last good version.
- Available libraries:
  - `write-file-atomic` (npm, v8, maintained by npm and used by npm itself): drop-in replacement for `fs.writeFile`, does temp + `fsync` (on by default) + rename, with a per-file queue and temp-file cleanup in `try/finally`.
  - `atomically`: no dependencies, somewhat faster, with `fsyncWait: false` for ~10x speed in exchange for slightly weaker guarantees.
- Concurrency note: with the temp+rename pattern, two simultaneous writers do not corrupt the file but **the last rename wins** — the earlier one is silently lost. In our case the daemon is a single process, so serializing writes within the process is enough; no inter-process lock is needed.

**Decision:** use `write-file-atomic` (with `fsync` by default) and serialize state writes within the daemon. We add no inter-process locks: the design assumes a single running daemon, and launchd guarantees that.

## launchd: making the daemon come back on its own

- The base pattern is two keys in the plist: `RunAtLoad` (starts when launchd loads the job, i.e. at login/boot) and `KeepAlive` (relaunches it if it dies). Together they give "automatic startup + crash recovery" in one step.
- `KeepAlive` has two safe forms:
  - `<true/>`: always relaunches, unconditionally.
  - `{ SuccessfulExit = false }`: relaunches if it crashed, but respects a clean exit. This allows a `bookcarrier stop` that actually takes it down, instead of launchd resurrecting it.
- `ThrottleInterval` (seconds) prevents the fast-restart loop if the daemon crashes at startup (for example, broken config). Without this, launchd may relaunch it in a loop.
- Logs: `StandardOutPath` and `StandardErrorPath` point to their own files — no need to dig through syslog. `~/Library/Logs/Bookcarrier/` is convenient.
- **LaunchAgent vs LaunchDaemon:** it goes in `~/Library/LaunchAgents/` (LaunchAgent, runs as the user at login), not in `/Library/LaunchDaemons/` (LaunchDaemon, runs as root at boot). We need a LaunchAgent because the daemon uses the user's SSH key and their `$HOME`.
- Modern `launchctl` (macOS 12+) uses `bootstrap` / `bootout`, not the old `load` / `unload`:
  ```
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist
  launchctl print "gui/$(id -u)/com.codebymaribel.bookcarrier"
  ```
- `plutil -lint <plist>` validates the plist before loading it.

**Decision:** LaunchAgent in `~/Library/LaunchAgents/`, with `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false }`, `ThrottleInterval: 10`, and logs in `~/Library/Logs/Bookcarrier/`.

## The launchd environment: PATH and the node binary (2026-11-17)

Finding when closing Step 0, when it turned out that Homebrew's `node` is v26 and the project's `.nvmrc` asks for 24.

### launchd builds no environment

launchd does not give its jobs a useful PATH by default (unlike systemd, which at least gives a documented minimal one). Two consequences:

1. **A bare `node` cannot be put in `ProgramArguments`.** Version managers (nvm, nodenv, volta, fnm) live in the shell's init files (`.zshrc`, `.bashrc`), which launchd does not load. An absolute path is required.
2. **The reduced PATH is inherited by child processes.** Even if `node` starts via an absolute path, whatever it spawns ends up with a PATH trimmed to `/usr/bin:/bin:/usr/sbin:/sbin`.

### Why this breaks our download (and not the upload)

The daemon spawns two external binaries:

| Binary | Location | In launchd's PATH? |
|---|---|---|
| `scp` | `/usr/bin/scp` | **Yes** |
| `fanficfare` | `/opt/homebrew/bin/fanficfare` | **No** |

So, under launchd and without fixing anything: `spawn('fanficfare')` fails with `ENOENT`, which arrives as `spawn`'s `'error'` event, which `errors.ts` classifies as **permanent / broken config** (R1.4 of this feature). The daemon would work perfectly launched by hand from the terminal and fail instantly under launchd, with a message pointing at the wrong place. The upload would work; the download would not.

It is exactly the class of bug that costs hours because the symptom lies.

### Decision: explicit PATH in the plist

The plist declares `EnvironmentVariables` with a PATH that includes Homebrew's prefix:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key>
  <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
```

This resolves both binaries at once, and also covers whatever FanFicFare needs for itself (it is a Python package installed by Homebrew, so it may want its own interpreter in the PATH).

### Decision: which node binary

Three options, with their problems:

| Option | Path | Problem |
|---|---|---|
| nvm | `~/.nvm/versions/node/v24.22.1/bin/node` | Includes the **patch** version. An `nvm uninstall` of that patch breaks the daemon; an `nvm install` of a new one does not update it. It is the classic complaint: the path "changes when you update node with nvm". |
| Unversioned Homebrew | `/opt/homebrew/bin/node` | Today it is v26, and `brew upgrade` repoints it. The daemon may jump major versions **silently**. |
| **Versioned Homebrew** | `/opt/homebrew/opt/node@24/bin/node` | Neither. Stable path, fixed major, patches updated by brew. |

**We choose the third:** `brew install node@24`, and the plist points to `/opt/homebrew/opt/node@24/bin/node`.

`.nvmrc` stays at 24 for development: same major as the service, so there is no real skew between what is tested and what runs. nvm stays out of the service's way, which is where it gets in the way.

Note: `ThrottleInterval` (already in the spec) covers precisely the case where this path is wrong — without it, launchd would relaunch in a loop a daemon that cannot even start.

### Escape hatch (deferred, not needed now)

If at some point the plist's PATH is not enough, optional config fields `fanficfareBin` and `scpBin` (default: the bare names) can be added to force absolute paths. **We do not do it now**: the plist's PATH solves the case and adding fields would mean going back to `config.ts`, which is already closed in Step 0.

## The Kindle and its WiFi: how often is "unreachable"

- SSH over WiFi on a jailbroken Kindle is not active by default: it has to be explicitly enabled from USBNetwork in KUAL ("Allow SSH over WiFi"). It has been done since KindleMOD already, but it is worth knowing that it is a state that can be lost (for example, after a firmware update or a restart that disables usbnet).
- The Kindle's WiFi sleeps aggressively to save battery. This is precisely the queue's scenario: the Kindle is not "off", just has its WiFi asleep, and comes back in minutes when used.
- **Useful side finding (applies to feature 1):** after copying books by a non-USB method (like `scp`), the native Kindle does not refresh its library on its own. The command to force it is:
  ```
  dbus-send --system /default com.lab126.powerd.resuming int32:1
  ```
  **But** this is for the native Kindle reader. Since we read with **KOReader**, which walks the filesystem directly, it is probably not needed. Noted to test: if a freshly copied fic does not show up in KOReader without restarting it, this command is the first place to look.

**Decision:** the retry window (30 min) is sized for the common case, which is sleeping WiFi, not the Kindle being off for hours. See the note on the window in requirements.md.

## Timer strategy: no unnecessary polling

The project principle says "no unnecessary polling or blocking work on the main loop". A `setInterval` every 30 seconds that checks the queue violates that when the queue is empty, which will be most of the time.

**Decision:** a single, computed timer. When the queue changes, the earliest `nextAttemptAt` among all items is computed and **one** `setTimeout` is scheduled for that moment. If the queue becomes empty, no timer is active. When the daemon starts, it is recalculated from the persisted state. This gives zero work at rest and exact wake-ups, instead of a blind tick.
