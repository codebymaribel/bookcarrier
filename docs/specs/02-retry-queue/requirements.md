# Requirements — Feature 2: Retry Queue

See the [project principles](../_principles.md) and the [feature 1 spec](../01-standalone-send/requirements.md), which this feature extends.

## Goal

A request must not be lost because of a transient failure. If the download fails (AO3 down, 429) or the upload fails (Kindle with sleeping WiFi), the request stays in a persistent queue and is retried with backoff. The bot notifies on enqueue, on delivery and on give-up.

## Decisions made (2026-11-17)

- **The queue covers downloads and uploads**, not just uploads. AO3 going down is as transient as the Kindle sleeping, and given the site's current state it is a real case.
- **The downloaded EPUB is saved to disk** (spool directory). If the download went fine and only scp failed, retries do not hit AO3 again.
- **Exponential backoff, give up at 30 minutes** after the first enqueue.
- **Notifications:** on enqueue, on delivery and on give-up. Silence on the failed attempts in between.

### Note on the 30-minute window

The backoff ladder is **1, 2, 4, 8, 15 minutes** (cumulative: 1, 3, 7, 15, 30), i.e. 5 attempts that end exactly at the edge of the window. It is deliberately sized so there is no unreachable ceiling.

This covers the common case well: the Kindle with sleeping WiFi, which comes back in minutes. It does **not** cover the case of the Kindle being off for hours — there the request is abandoned and the link has to be shared again, which is one tap from the phone. The window is a config value (`giveUpAfterMs`), so lengthening it is a one-line change.

## Requirements (EARS)

### R1 — Enqueueing

- R1.1: When a fic's download fails with a transient error (network failure, AO3 403/429, timeout), the system shall enqueue the request with stage `download` and notify the owner that it is pending retry.
- R1.2: When a fic's download fails with a permanent error (the link does not point to an existing work), the system shall **not** enqueue the request and shall report the error, as in feature 1.
- R1.3: When the upload to the Kindle fails because the Kindle is not reachable, the system shall enqueue the request with stage `upload`, keeping the already-downloaded EPUB, and notify the owner that it is pending retry.
- R1.4: When the upload fails because the configuration is broken (`scp` binary missing from the PATH, SSH key nonexistent or with wrong permissions), the system shall **not** enqueue the request and shall report the error, because retrying will not fix it.

### R2 — Persistence

- R2.1: When an item is added to, modified in or removed from the queue, the system shall persist the full queue state to a JSON file before considering the operation finished.
- R2.2: While the state file is being written, the system shall do so atomically (temp file in the same directory + rename), so that a cut in the middle of a write never leaves the file corrupt or truncated.
- R2.3: When the daemon starts and finds a valid state file, the system shall restore the queue and reschedule the pending retries according to each item's `nextAttemptAt`.
- R2.4: When the daemon starts and the state file does not exist, the system shall start with an empty queue without treating it as an error.
- R2.5: When the daemon starts and the state file exists but cannot be parsed, the system shall start with an empty queue, preserve the unreadable file under another name so it can be inspected, and notify the owner.

### R3 — Retries

- R3.1: When the time for an item's next attempt arrives, the system shall retry only the stage the item is in (`download` or `upload`), not the whole flow.
- R3.2: When a retry of stage `download` succeeds, the system shall move the item to stage `upload`, keeping the EPUB, and continue with the upload.
- R3.3: When a retry fails, the system shall increment the attempt counter and schedule the next one according to the configured backoff ladder (by default 1, 2, 4, 8, 15 minutes).
- R3.4: While there is at least one item in the queue, the system shall keep exactly **one** timer scheduled, pointed at the earliest `nextAttemptAt` among all items.
- R3.5: When the queue becomes empty, the system shall have no active timer and do no periodic work.

### R4 — Giving up

- R4.1: When the time elapsed since an item's first enqueue exceeds the configured window (by default 30 minutes), the system shall give up on the item, remove it from the queue and notify the owner that it was abandoned, stating the last error.
- R4.2: When an item is abandoned and had an EPUB in the spool, the system shall delete that file.

### R5 — File spool

- R5.1: When a fic is downloaded successfully, the system shall save the EPUB in a configurable spool directory, outside the system's temporary directory, so that it survives a restart of the daemon or the Mac.
- R5.2: When an item is delivered successfully, the system shall delete its EPUB from the spool.
- R5.3: When the daemon starts, the system shall delete from the spool every EPUB that is not referenced by any item of the restored queue.

### R6 — Notifications to the owner

- R6.1: When a request is enqueued, the system shall notify the owner exactly once, stating the reason and that it will be retried.
- R6.2: When an enqueued request is delivered successfully, the system shall notify the owner, including the fic's title.
- R6.3: When an intermediate retry fails, the system shall **not** notify the owner.
- R6.4: When a request is abandoned, the system shall notify the owner with the last recorded error.

### R7 — The daemon must come back on its own

R2's persistence promise is useless if the daemon dies and does not come back. That is why this feature includes automatic startup.

- R7.1: The system shall be installed as a macOS LaunchAgent in `~/Library/LaunchAgents/`, starting at login and relaunching automatically on crash.
- R7.2: When the daemon exits cleanly and intentionally, launchd shall **not** relaunch it (`KeepAlive: { SuccessfulExit: false }`).
- R7.3: When the daemon crashes repeatedly at startup, launchd shall space out the retries (`ThrottleInterval`) instead of relaunching it in a loop.
- R7.4: The system shall write stdout and stderr to its own log files under `~/Library/Logs/Bookcarrier/`.
- R7.5: The plist shall declare `EnvironmentVariables.PATH` including Homebrew's prefix (`/opt/homebrew/bin`), because launchd does not build a PATH and child processes inherit it trimmed. Without this, `spawn('fanficfare')` fails with `ENOENT` under launchd and is wrongly classified as a permanent configuration error (see research.md).
- R7.6: The plist shall point to a node binary with an absolute, stable path: `/opt/homebrew/opt/node@24/bin/node` (`brew install node@24`). The nvm path is not used, since it includes the patch version and breaks on update.
- R7.7: When the daemon starts, the system shall verify that the external binaries it needs (`fanficfare`, `scp`) are resolvable, and log which one is missing if any is not — so that a badly built PATH is detected at startup and not as a confusing download failure.

## Out of scope for this feature

- "Follow" button and chapter tracking (feature 3).
- Daily update check (feature 4).
- `/list`, `/drop`, `/status` commands (feature 5) — although `/status` will read the queue we build here.
- Migrating state to SQLite (only if JSON becomes a problem).
- Log rotation.

## Acceptance criteria (Given/When/Then)

1. **Given** a valid link and the Kindle off, **when** scp fails with a connection timeout, **then** the bot reports that it was enqueued and the EPUB stays in the spool.
2. **Given** an item enqueued at stage `upload`, **when** the Kindle becomes reachable again before 30 min, **then** the fic is delivered, the bot notifies with the title and the EPUB is deleted from the spool.
3. **Given** an enqueued item, **when** 30 minutes pass without success, **then** the bot reports it was abandoned with the last error and the EPUB is deleted from the spool.
4. **Given** an enqueued item, **when** the daemon restarts, **then** on return it restores the queue and reschedules the retry without losing the item or the EPUB.
5. **Given** AO3 returns 429, **when** the download fails, **then** the request is enqueued at stage `download` and the retry attempts the download again.
6. **Given** the SSH key is misconfigured, **when** launching scp fails, **then** the request is **not** enqueued and the bot reports the configuration error.
7. **Given** the queue is empty, **when** the daemon is idle, **then** there is no active timer and no periodic work.
