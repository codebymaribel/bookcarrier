# Design — Feature 4: Control Panel

See [requirements.md](./requirements.md) and [research.md](./research.md).

## Shape

```
bin/
  bookcarrierctl                 # bash: the only thing that talks to launchctl
swiftbar/
  bookcarrier.10s.sh.template    # SwiftBar plugin; __REPO__ filled in by `menubar install`
test/
  bookcarrierctl.test.ts         # Vitest, spawns the script with fake binaries
  swiftbar-plugin.test.ts        # Vitest, spawns the plugin with a fake bookcarrierctl
```

Both scripts are Bash (`#!/bin/bash`, `set -euo pipefail`). macOS ships Bash 3.2, so they avoid Bash 4+ features (no associative arrays, no `${var,,}`).

```
SwiftBar ──(every 10 s)──▶ bookcarrier.10s.sh ──▶ bookcarrierctl status --porcelain
   click "Stop"  ─────────▶ bookcarrierctl stop  ──▶ launchctl kill SIGTERM …
                                                     launchctl list <label>
                                                     plutil -extract items raw queue.json
```

## `bin/bookcarrierctl`

### Constants and overridable binaries

```bash
LABEL="com.codebymaribel.bookcarrier"
REPO="$(resolved directory of this script, following symlinks)/.."   # R6.1
DOMAIN="gui/$(/usr/bin/id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Bookcarrier"
NODE="/opt/homebrew/opt/node@24/bin/node"
QUEUE_FILE="${BOOKCARRIER_QUEUE_FILE:-$HOME/.bookcarrier/queue.json}"

LAUNCHCTL="${BOOKCARRIER_LAUNCHCTL:-/bin/launchctl}"     # R6.2 + tests
PLUTIL="${BOOKCARRIER_PLUTIL:-/usr/bin/plutil}"
```

Symlinks are resolved with a small `readlink` loop, because macOS `readlink` has no `-f` on older systems.

`QUEUE_FILE` follows the daemon's default. If the owner set `queuePath` in `config.json`, they also set `BOOKCARRIER_QUEUE_FILE`. Reading the JSON config from Bash is deliberately not attempted (see "Left out").

### `job_state` — the single function every command relies on

```
job_state → prints: "<state> <pid|-> <last_exit|->"
  if ! launchctl list $LABEL           → plist exists ? "not-loaded - -" : "not-installed - -"
  parse "PID" = N;  and  "LastExitStatus" = N;  from its output (grep/sed, line-based)
  PID present                          → "running <pid> <last_exit>"
  else LastExitStatus == 0             → "stopped - 0"
  else                                 → "crashed - <last_exit>"
```

`queue_items` prints `0` when the file is missing, the plutil count when it parses, and `?` when it does not.

### Commands

| Command | Behavior | Exit |
|---|---|---|
| `status [--porcelain]` | Human text: `Bookcarrier: running (PID 30046) · 2 in retry queue`. Porcelain: `state=… pid=… last_exit=… queue_items=…`, one per line (R1) | 0 if running, else 3 |
| `start` | `not-loaded` → `bootstrap`; `stopped`/`crashed` → `kickstart`; `running` → "already running" (R2.1) | 0 / 1 |
| `stop` | `kill SIGTERM`, then poll `job_state` every 0.5 s for up to 15 s (R2.2). Never SIGKILL | 0 / 1 |
| `restart` | `kickstart -k` (R2.3) | 0 / 1 |
| `install` | Preconditions (R3.2) → if loaded, `bootout` → copy `launchd/…plist`, `sed` `__REPO__`/`__HOME__` → `mkdir -p $LOG_DIR` → `plutil -lint` → `bootstrap` (R3.1, R3.3) | 0 / 1 |
| `uninstall` | `bootout` if loaded → `rm $PLIST`. Logs, queue and spool are kept (R3.4) | 0 / 1 |
| `logs [-f]` | `tail -n 50` of both logs; `-f` → `tail -F` (R4) | tail's |
| `menubar install <dir>` | Copy the plugin template to `<dir>/bookcarrier.10s.sh` with `__REPO__` filled in, then `chmod +x` (R5.8) | 0 / 1 |
| `help`, unknown | Usage on stderr (R6.3) | 0 / 2 |

`start`, `stop` and `restart` on `not-installed` exit 1 with "Bookcarrier is not installed. Run: bookcarrierctl install" (R2.4).

After every state-changing command, the script runs `open -g "swiftbar://refreshplugin?name=bookcarrier"` and ignores any error. That way a command typed in the terminal also updates the icon at once. It is skipped when `BOOKCARRIER_NO_SWIFTBAR_REFRESH=1` (tests).

### Messages

Plain English, one line, no `launchctl` jargon. For example: `Stopped. launchd will not restart it until you run: bookcarrierctl start`. Errors go to stderr; everything else goes to stdout.

## `swiftbar/bookcarrier.10s.sh.template`

The plugin runs `bookcarrierctl status --porcelain`, reads the four keys and prints:

| State | Menu bar (`sfimage`) | First menu line |
|---|---|---|
| `running` | `book.fill` | `Running · PID 30046` |
| `stopped` / `not-loaded` | `book` | `Stopped` |
| `crashed` | `exclamationmark.triangle.fill` | `Crashed (last exit 9) — launchd will retry` |
| `not-installed` | `book.closed` | `Not installed` |
| ctl missing / failed | `questionmark.circle` | the error text (R5.7) |

The symbol changes with the state, so the meaning never depends on color alone (R5.1).

Menu below the first line, with actions filtered by state (R5.3):

```
2 in retry queue
---
Stop | bash=__REPO__/bin/bookcarrierctl param0=stop terminal=false refresh=true
Restart | bash=… param0=restart terminal=false refresh=true
---
Open logs | bash=/usr/bin/open param0=-a param1=Console param2=<out.log> terminal=false
Open spool folder | href=file://<spool>
Open queue file | bash=/usr/bin/open param0=<queue.json> terminal=false
```

The metadata hides SwiftBar's own items (`hideAbout`, `hideRunInTerminal`, `hideLastUpdated`, `hideDisablePlugin`) so the menu only shows Bookcarrier.

A 10-second refresh costs two short-lived processes. The daemon does no extra work (R5.6).

## Testing strategy

- **`bookcarrierctl.test.ts`:**
  - A temp `HOME`.
  - A fake `launchctl` that answers `list` from a fixture chosen per test and appends every call's arguments to `calls.log`.
  - A fake `plutil` that delegates to the real one for `-extract`/`-lint`, so the JSON counting is really tested.
  - Each test asserts exit code, exact stdout/stderr and the recorded `launchctl` calls. For example, `stop` sends exactly `kill SIGTERM gui/<uid>/<label>` and never SIGKILL.
- **`swiftbar-plugin.test.ts`:**
  - A fake `bookcarrierctl` that prints a canned porcelain block per state.
  - Each test asserts the exact plugin output: icon line, filtered actions, queue line.
- **Manual checks** (they need the real launchd and SwiftBar): the acceptance criteria in requirements.md.

## Left out on purpose

- **Reading `config.json` from Bash** to find a custom `queuePath`/`spoolDir`. Parsing JSON in Bash without `jq` is fragile, and calling `node` would tie the menu to the Node install. The env override covers the rare custom case.
- **SIGKILL on a stuck stop.** If SIGTERM does not stop it in 15 s, something is wrong, and the owner should look at the logs before forcing it.
- **A `bookcarrierctl` npm bin / `pnpm` script.** The script must work without Node in PATH (SwiftBar). The owner can add `bin/` to their PATH or symlink it into `~/bin`.
