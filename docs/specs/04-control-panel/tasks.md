# Tasks — Feature 4: Control Panel

Each task ships with its test (Vitest, spawning the script with fake binaries). See [design.md](./design.md).

Prerequisite: feature 2 merged and its manual verification done (this feature controls its LaunchAgent).

## Tasks

- [ ] **T1 — `bookcarrierctl` skeleton + `job_state` + `status`.**
  - Test: each `launchctl list` fixture maps to its state: not-installed, not-loaded, running (with PID), stopped, crashed with its exit status (R1.1, R1.2).
  - Test: `--porcelain` prints exactly the four `key=value` lines (R1.4).
  - Test: `status` exits 0 when running and 3 otherwise (R1.5).
  - Test: queue count is `2` for two items, `0` for `[]`, `0` for a missing file and `?` for a corrupt file (R1.3).
  - Test: works when called through a symlink from another directory (R6.1).
  - Manual: confirm how `LastExitStatus` reads after `kill -9` (research.md).

- [ ] **T2 — `start`, `stop`, `restart`.**
  - Test: `start` on not-loaded → `bootstrap`; on stopped/crashed → `kickstart`; on running → no launchctl call, exit 0 (R2.1).
  - Test: `stop` sends `kill SIGTERM` exactly once and never SIGKILL. When the fake reports no PID afterwards → exit 0 with the "Stopped" message. When the PID stays → exit 1 after the wait, which is shortened in tests by an env override (R2.2).
  - Test: `restart` → `kickstart -k` (R2.3).
  - Test: all three on not-installed → exit 1 with the "Run: bookcarrierctl install" message (R2.4).

- [ ] **T3 — `install` and `uninstall`.** With a temp `HOME`.
  - Test: `install` writes the plist with no `__REPO__`/`__HOME__` left and absolute paths in their place. It creates the log dir, lints and bootstraps (R3.1).
  - Test: missing node binary or missing `dist/index.js` → exit 1 naming the fix, and nothing is written (R3.2).
  - Test: `install` over an existing install → `bootout` then `bootstrap` (R3.3).
  - Test: `uninstall` → `bootout` + plist removed. Logs, queue and spool are untouched (R3.4).

- [ ] **T4 — `logs`, usage, errors.**
  - Test: `logs` prints the tail of both files (R4.1). `-f` uses `tail -F`, checked with a fake `tail` (R4.2).
  - Test: unknown command/option → usage on stderr and exit 2 (R6.3).

- [ ] **T5 — SwiftBar plugin template + `menubar install`.**
  - Test: for each state, the exact plugin output: icon symbol, first line, queue line, and only the allowed actions (R5.1–R5.3).
  - Test: actions use `terminal=false refresh=true` and absolute paths (R5.4, R6.2).
  - Test: ctl missing or exiting with an error → warning icon and the error in the menu (R5.7).
  - Test: `menubar install <dir>` writes `bookcarrier.10s.sh`, executable, with no `__REPO__` left (R5.8).
  - Manual: confirm the `--` submenu syntax and the look in light and dark mode (research.md).

- [ ] **T6 — Docs.** README (English and Spanish): replace the hand-editing steps of the LaunchAgent section with `bookcarrierctl install`; add a "Control panel" section with the commands table and the SwiftBar setup (`brew install swiftbar`, choose a plugin folder, `bookcarrierctl menubar install <folder>`). Roadmap row for feature 7.

## Manual verification (before closing the feature)

- [ ] On a machine with the LaunchAgent not installed: `bookcarrierctl install` → running, no file edited by hand (acceptance 1).
- [ ] Menu bar *Stop* → icon changes to stopped within 10 s, and `launchctl list` shows `LastExitStatus = 0` and no relaunch (acceptance 2).
- [ ] Menu bar *Start* → running again (acceptance 3).
- [ ] `kill -9` the daemon and open the menu right away → "Crashed", then "Running" after launchd relaunches it (acceptance 4).
- [ ] With the Kindle off, share two fics → the menu shows "2 in retry queue" (acceptance 5).
- [ ] `bookcarrierctl uninstall` → menu shows "Not installed" with only *Install* (acceptance 6).
- [ ] `bookcarrierctl foo` → usage, exit 2 (acceptance 7).
