# Research — Feature 4: Control Panel

Date: 2026-11-20

## SwiftBar plugins

Source: [SwiftBar README](https://github.com/swiftbar/SwiftBar/blob/main/README.md), read 2026-11-20.

- **Install:** `brew install swiftbar` (or the GitHub release). Requires macOS 12+. On first launch it asks for a *Plugin Folder* and imports every file in it. Nested folders and symlinks are followed; hidden folders are ignored. SwiftBar makes plugin files executable on its own.
- **File name = refresh interval:** `{name}.{time}.{ext}`, e.g. `bookcarrier.10s.sh` refreshes every 10 seconds. Units: `ms`, `s`, `m`, `h`, `d`.
- **Output format:** everything before the first `---` is the menu bar item; each later `---` is a separator. Each line is `Title | key=value key=value`.
- **Line parameters we need:**
  - `bash=<absolute path>` plus `param0=`, `param1=`, …: run a script on click.
  - `terminal=false`: run it in the background instead of opening Terminal.
  - `refresh=true`: re-run the plugin after the click.
  - `sfimage=<SF Symbol>` and `sfcolor=`: an icon instead of text. `color=light,dark` for text.
  - `href=<url>`: open a URL (e.g. `file://` for folders).
  - `tooltip=`.
- **Metadata tags:** `<swiftbar.hideAbout>true</swiftbar.hideAbout>`, `<swiftbar.hideRunInTerminal>`, `<swiftbar.hideLastUpdated>`, `<swiftbar.hideDisablePlugin>` and `<swiftbar.hideSwiftBar>` keep the menu short. Option+click still shows the hidden items. xbar tags (`xbar.title`, `xbar.author`) are also accepted.
- **Environment:** plugins are wrapped in Bash by default. SwiftBar exports `SWIFTBAR=1`, `SWIFTBAR_PLUGIN_PATH`, `SWIFTBAR_PLUGINS_PATH`, `SWIFTBAR_PLUGIN_DATA_PATH`, `OS_APPEARANCE`, and others. The README does **not** document the PATH plugins get, so we assume a minimal one, like launchd's. Hence R6.2: absolute paths for every binary.
- **Refresh from outside:** `open -g "swiftbar://refreshplugin?name=bookcarrier"` refreshes the plugin without stealing focus. Useful after a `bookcarrierctl` command run from the terminal, so the icon does not wait for the next 10 s tick.
- **To confirm by hand during T5:**
  - that `--` submenus (xbar syntax) render in SwiftBar;
  - the default plugin folder. `defaults read com.ameba.SwiftBar` fails until SwiftBar has run at least once, so `menubar install` takes the folder as an argument instead of guessing it.

## launchd job state, read without parsing `launchctl print`

Checked on the owner's Mac (macOS, Apple Silicon) on 2026-11-20, with the feature 2 LaunchAgent loaded.

- `launchctl print` is documented by Apple as **not** a stable interface for scripts.
- `launchctl list <label>` prints one dict for the job, with `"PID" = 30046;` (only while running) and `"LastExitStatus" = 0;`. It exits non-zero when the job is not loaded. That is all R1.1 needs:

  | `launchctl list <label>` | `PID` | `LastExitStatus` | State |
  |---|---|---|---|
  | fails, plist absent | — | — | `not-installed` |
  | fails, plist present | — | — | `not-loaded` |
  | succeeds | present | any | `running` |
  | succeeds | absent | 0 | `stopped` |
  | succeeds | absent | ≠ 0 | `crashed` |

- **To confirm by hand during T1:** how `LastExitStatus` encodes a death by signal (e.g. `kill -9`). launchd usually reports it as the raw wait status, not 137. Any non-zero value is `crashed`, so the exact number only matters for the message.
- Commands, modern syntax (macOS 12+):
  - `launchctl bootstrap gui/$UID <plist>`: load. Starts at once because of `RunAtLoad`.
  - `launchctl bootout gui/$UID/<label>`: unload.
  - `launchctl kickstart gui/$UID/<label>`: start a loaded job. `-k` kills it first (restart).
  - `launchctl kill SIGTERM gui/$UID/<label>`: clean stop. The daemon exits 0, so `KeepAlive: { SuccessfulExit: false }` does not relaunch it. Verified in feature 2: `exit code: 0` on SIGTERM.

## Counting queue items without extra dependencies

Checked on 2026-11-20:

- `/usr/bin/plutil -extract items raw -o - queue.json` reads **JSON** as well as plists. On an array it prints its **count**: `2` for two items, `0` for `[]`, exit 0.
- So no `jq`, `python3` or `node` is needed in the script. When the file does not exist we report 0, since that is what the daemon does too (feature 2 R2.4). When the file is corrupt, plutil exits non-zero and we report `queue_items=?`.

## Testing shell scripts with Vitest

- The project's rule is that every feature ships with Vitest tests. The script is tested from the outside: Vitest spawns `bin/bookcarrierctl` with fake binaries.
- To make that possible, every system binary is resolved through an overridable variable, e.g. `LAUNCHCTL="${BOOKCARRIER_LAUNCHCTL:-/bin/launchctl}"`. In production the defaults are the absolute paths of R6.2.
- The fakes are tiny scripts written into a temp dir. They print canned `launchctl list` output and record their arguments in a file, so tests assert both what the user sees and which `launchctl` call was made.
- `HOME` is also overridden per test (temp dir), so `install` / `uninstall` never touch the real `~/Library`.
