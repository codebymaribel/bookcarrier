# Requirements — Feature 4: Control Panel (CLI + menu bar)

See the [project principles](../_principles.md) and the [feature 2 spec](../02-retry-queue/requirements.md), whose LaunchAgent this feature controls.

## Goal

Starting, stopping and checking the daemon today means typing `launchctl` commands with `gui/$(id -u)/com.codebymaribel.bookcarrier` in them, and installing it means hand-editing placeholders in a plist. The goal is to make that one click (menu bar) or one readable command (terminal), without touching the daemon itself.

## Decisions made (2026-11-20)

- **Two layers, one source of truth.** A shell script, `bookcarrierctl`, owns every `launchctl` call. The menu bar is a [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin that only calls `bookcarrierctl`. Neither the plugin nor the user ever calls `launchctl` directly.
- **SwiftBar, not a native app.** A plugin is a shell script that lives in the repo; a native Swift app would be another language, another build and another thing to sign. SwiftBar is free and installs with `brew install swiftbar`.
- **The daemon is not modified.** Everything here reads what already exists: launchd's job state, `queue.json`, the spool and the log files.
- **Telegram is not a control channel for this feature.** A stopped bot cannot receive a "start" message. `/status` stays in feature 7.

## Requirements (EARS)

### R1 — `bookcarrierctl status`

- R1.1: When the owner runs `bookcarrierctl status`, the system shall report exactly one of these states: `not-installed` (no plist in `~/Library/LaunchAgents/`), `not-loaded` (plist present, job not known to launchd), `running` (job has a PID), `stopped` (loaded, no PID, last exit status 0), `crashed` (loaded, no PID, last exit status ≠ 0).
- R1.2: When the state is `running`, the system shall also show the PID.
- R1.3: The system shall show the number of items in the retry queue, read from the configured `queue.json` (0 when the file does not exist), split by stage: items waiting to be downloaded (`stage: "download"`) and items waiting to be sent to the Kindle (`stage: "upload"`). (Added 2026-11-22, owner request L12.)
- R1.4: When run with `--porcelain`, the system shall print stable `key=value` lines (`state=`, `pid=`, `last_exit=`, `queue_items=`, `queue_download=`, `queue_send=`) meant for scripts, and nothing else.
- R1.5: `bookcarrierctl status` shall exit 0 when `running` and 3 otherwise, so scripts can test it.

### R2 — Start, stop, restart

- R2.1: When the owner runs `bookcarrierctl start` and the job is `not-loaded`, the system shall load it (`bootstrap`); when it is `stopped` or `crashed`, it shall start it (`kickstart`); when it is already `running`, it shall say so and exit 0 without doing anything.
- R2.2: When the owner runs `bookcarrierctl stop`, the system shall send SIGTERM (so the daemon exits 0 and launchd does **not** relaunch it, per feature 2 R7.2), wait up to 15 seconds for the PID to disappear, and report the result. If it is still running after the wait, it shall say so and exit 1 without escalating to SIGKILL.
- R2.3: When the owner runs `bookcarrierctl restart`, the system shall restart the job (`kickstart -k`), so a fresh `pnpm build` takes effect.
- R2.4: When the job is `not-installed`, `start`, `stop` and `restart` shall fail with a message that points to `bookcarrierctl install`.

### R3 — Install and uninstall

- R3.1: When the owner runs `bookcarrierctl install`, the system shall: copy the plist template to `~/Library/LaunchAgents/`, replace `__REPO__` and `__HOME__` with absolute paths, create `~/Library/Logs/Bookcarrier/`, validate it with `plutil -lint`, and load it. No manual editing.
- R3.2: Before installing, the system shall check that `/opt/homebrew/opt/node@24/bin/node` and `dist/index.js` exist, and refuse with a message naming what is missing (`brew install node@24` / `pnpm build`).
- R3.3: When a plist is already installed, `install` shall replace it and reload the job, so it is also the way to apply template changes.
- R3.4: When the owner runs `bookcarrierctl uninstall`, the system shall unload the job and delete the plist. It shall **not** delete the logs, the queue or the spool.

### R4 — Logs

- R4.1: When the owner runs `bookcarrierctl logs`, the system shall show the last lines of both log files.
- R4.2: With `-f`/`--follow`, it shall keep following both files until Ctrl+C.

### R5 — Menu bar (SwiftBar plugin)

- R5.1: The plugin shall show an icon whose look reflects the state from R1.1: running, stopped/not-loaded, crashed, not-installed. The meaning shall not depend on color alone (different symbol per state), for accessibility.
- R5.2: The menu shall show the state in words, the PID when running, and the retry queue in one line split by stage: `Retry queue: 1 to download · 1 to send` (`Retry queue: empty` when it has no items). (Changed 2026-11-22, owner request L12.)
- R5.3: The menu shall offer only the actions that make sense in the current state: *Start* when not running, *Stop* and *Restart* when running, *Install* when not installed.
- R5.4: Clicking an action shall run the matching `bookcarrierctl` command in the background (no Terminal window) and refresh the plugin right after.
- R5.5: The menu shall offer *Open logs* (opens the log in Console.app), *Open spool folder* and *Open queue file* (in Finder / the default editor).
- R5.6: The plugin shall refresh on its own every 10 seconds, and shall cost nothing measurable while idle: one `launchctl list` call and one `plutil` call per refresh plus one per queued item (to read its stage), no polling inside the daemon.
- R5.7: When `bookcarrierctl` is not found or fails, the plugin shall show a warning icon and the error in the menu instead of an empty or frozen menu bar item.
- R5.8: `bookcarrierctl menubar install <plugins-folder>` shall install the plugin into SwiftBar's plugin folder with the repo's absolute path filled in.

### R6 — Robustness

- R6.1: `bookcarrierctl` shall work when run from any directory and through a symlink, resolving the repo from its own location.
- R6.2: `bookcarrierctl` shall use absolute paths for the system binaries it calls (`/bin/launchctl`, `/usr/bin/plutil`, …), because SwiftBar, like launchd, does not run it with the owner's interactive PATH.
- R6.3: Unknown commands or options shall print the usage and exit 2.

## Out of scope for this feature

- A native macOS app, Electron or Tauri.
- Controlling the bot from Telegram (`/status` is feature 7).
- Starting SwiftBar at login (SwiftBar has its own "Launch at login" setting).
- Showing the queue's items one by one or acting on them (feature 7, `/list` and `/drop`).
- Supporting Intel Macs (paths assume Homebrew on Apple Silicon, `/opt/homebrew`).

## Acceptance criteria (Given/When/Then)

1. **Given** a fresh clone with `pnpm build` done and `node@24` installed, **when** the owner runs `bookcarrierctl install`, **then** the job is loaded and running without editing any file by hand.
2. **Given** the daemon is running, **when** the owner clicks *Stop* in the menu bar, **then** the daemon exits 0, launchd does not relaunch it, and the icon changes to "stopped" within one refresh.
3. **Given** the daemon is stopped, **when** the owner clicks *Start*, **then** it runs again and the icon shows "running".
4. **Given** the daemon was killed with `kill -9`, **when** the menu is opened before launchd relaunches it, **then** it shows "crashed" with the last exit status; after the relaunch it shows "running" again.
5. **Given** two items in the retry queue, **when** the menu is opened, **then** it shows "2 in retry queue"; with one waiting to download and one waiting to send, it shows `Retry queue: 1 to download · 1 to send`.
6. **Given** no plist installed, **when** the menu is opened, **then** it shows "not installed" and only the *Install* action.
7. **Given** `bookcarrierctl` is run with an unknown command, **then** it prints the usage and exits 2.
