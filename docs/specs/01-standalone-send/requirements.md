# Requirements — Feature 1: Standalone Send

See the [project principles](../_principles.md) for the stack, conventions and non-functional requirements that apply to all features.

## Goal

An AO3 link shared with the Telegram bot ends up as an EPUB on the Kindle, with a stable name, and the bot confirms delivery or reports the error. No queue yet (that is feature 2): if the Kindle is unreachable, the error is reported and there is no automatic retry.

## Scope

- One link per message.
- Messages are processed **one at a time**, in arrival order (grammY's default with long polling). A second link sent while the first is downloading is acknowledged only when the first finishes. Feature 2's queue lifts this limit. (Decided 2026-11-18; it also gives, for free, the pause between requests to AO3 that the principles ask for.)
- A single recipient (the owner's Telegram ID).
- No tracking of new chapters (feature 5) and no retry queue (feature 2).

## Requirements (EARS)

### R1 — Owner filtering

- R1.1: When the daemon receives a Telegram message from a `chat_id`/`from.id` different from the one configured as owner, the system shall ignore the message without replying.

### R2 — Link reception and validation

- R2.1: When the owner shares a message containing an `archiveofourown.org` URL, the system shall accept the request and reply with an acknowledgement.
- R2.2: When the owner sends a text message that contains no `archiveofourown.org` URL, the system shall reply saying it does not recognize a valid AO3 link.
- R2.3: When the AO3 link received does not point to an individual work (for example, it points to a series, a collection or a user page), the system shall reply saying that this type of link is not supported yet.
- R2.4: The system shall find URLs by parsing them (not by pattern-matching the whole text) and shall accept only the exact hostnames `archiveofourown.org` and `www.archiveofourown.org`. A URL is an individual work when its path is `/works/<id>`, `/works/<id>/chapters/<n>` or `/collections/<name>/works/<id>`; the query string and fragment are ignored. (A `/collections/<name>` page without `/works/<id>` is still R2.3.)
  - _Added 2026-11-18. Why: a bare pattern over `archiveofourown.org/works/<id>` would accept `evil.example/archiveofourown.org/works/1` and would reject a work reached through a collection. Test 3 also showed that Android's share menu sends two lines — the title, then the URL — so the URL has to be found inside the text._
- R2.5: When the text contains more than one AO3 URL, the system shall use the first one and ignore the rest.
- R2.6: The system shall pass to the downloader the canonical URL `https://archiveofourown.org/works/<id>`, rebuilt from the extracted id, never the URL as the user sent it. (Same id is used for the queue in feature 2.)

### R3 — Download with FanFicFare

- R3.1: While a fic is being downloaded, the system shall run FanFicFare as a subprocess without blocking the daemon's main loop.
- R3.2: When FanFicFare finishes the download successfully (exit code 0 and a resulting EPUB file with size greater than zero), the system shall continue to the step of sending to the Kindle.
- R3.3: When FanFicFare finishes with an error, or the expected file does not exist or is zero bytes, the system shall consider the download failed and notify the owner of the error via Telegram, without attempting to send to the Kindle.
- R3.4: When FanFicFare does not respond within a configured maximum time, the system shall cancel the subprocess and treat it as a failed download.
- R3.6: The system shall invoke FanFicFare with `--non-interactive` and with stdin closed, so that a prompt (login, adult-content check) fails fast instead of waiting for input nobody will type until the timeout.
- R3.5: When the FanFicFare subprocess cannot be launched (`error` event from `spawn`, typically `ENOENT` because the binary is not installed or not resolvable in the PATH), the system shall distinguish it from a failed download and report it, naming the binary it did not find. (Added 2026-11-17: R3.3 used to lump it in with download failures. The distinction matters because it is an installation problem, and because in feature 2 it decides whether the request is queued or not — see R7.5 of that feature, where launchd's trimmed PATH produces exactly this error.)

### R4 — Stable file name

- R4.1: When generating the name of the EPUB file to send, the system shall build it as `<fic-id>-<title>.epub`, deterministically from the AO3 work id and its title.
- R4.2: When the fic title contains characters that are not valid in a file name, the system shall sanitize them before building the name.

### R5 — Sending to the Kindle

- R5.1: While the EPUB is being copied to the Kindle, the system shall run `scp` as a subprocess without blocking the daemon's main loop, targeting the configured SSH port and remote path.

- R5.2: **Before** launching `scp`, the system shall verify that the SSH key file exists and that its permissions are usable by SSH, using the same criterion SSH uses: neither group nor others have any permission (`(mode & 0o077) === 0`) **and** the owner can read it (`(mode & 0o400) !== 0`). Otherwise, it shall reject the send without launching the subprocess and report a configuration error naming the specific problem (missing, open permissions, or unreadable by the owner).
  - _2026-11-17: it used to require exactly `600`, which rejected a `400` key — read-only for the owner, perfectly valid for SSH. The check exists to catch keys that SSH would silently ignore, not to impose a stricter criterion than its own: a check harsher than SSH invents failures in configurations that work. The owner-read condition covers the `000` edge case, which passes the mask but cannot be read either._

- R5.3: When the Kindle does not respond within the configured `ConnectTimeout` (because it is off, asleep or off the network), the system shall treat it as a send failure and notify the owner, without retrying automatically (feature 2 adds the queue).

- R5.4: When the copy to the Kindle finishes successfully, the system shall notify the owner of the successful delivery, including the fic's title.

- R5.5: When the `scp` subprocess cannot be launched (`error` event from `spawn`: `ENOENT` because the binary is not resolvable, or `EACCES`), the system shall report a configuration error naming the binary.

- R5.6: The system shall invoke `scp` with `BatchMode=yes`, so that an authentication failure ends immediately instead of waiting for a password nobody will type.

- R5.7: The distinction between a configuration error and a send failure **must not depend on `scp`'s exit code**. What is permanent is determined before launching the process (R5.2) or by the `error` event (R5.5); any non-zero exit of the already-launched process is treated as a send failure.
  - _Added 2026-11-17: OpenSSH exit codes are generic — the same value covers unreachable host and rejected authentication — and may change between versions. We do not build logic on them._

- R5.8: The system shall invoke `scp` with the configured port using the `-P` option (uppercase).
  - _2026-11-18, verified against the real Kindle:_
    _The SSH server is KOReader's and listens on **2222**; 22 does not respond. The spec assumed the default port, so `scp` would never have connected, and since R5.7 treats any non-zero exit as a send failure, the bot would have reported "Kindle unreachable" on every attempt with no clue why. Watch the option: in `scp` the port is `-P`; lowercase `-p` preserves file timestamps and would leave the port at 22._

- R5.9: The configured remote path must exist on the Kindle: `scp` does not create directories. If it does not exist, the send fails and — per R5.7 — is treated as a send failure, so in feature 2 it would be retried for 30 minutes in vain before notifying.

### R6 — Configuration

- R6.1: The system shall read, from a configuration file outside the repository, the following **required** fields: bot token, owner's Telegram ID, Kindle SSH user, Kindle host/IP and SSH key path.
- R6.2: The repository shall include only an example configuration file with generic values.
- R6.3: The system shall accept the following **optional** fields, applying its own default when they are absent: download timeout, upload timeout, SSH `ConnectTimeout`, **Kindle SSH port** and remote destination path on the Kindle.
- R6.5: When `sshKeyPath` starts with `~` (alone or as `~/…`), the system shall expand it to the user's home directory when loading the config. (Added 2026-11-18: neither Node's `fs` nor `spawn` expands `~`, so a literal `~/.ssh/key` would be reported as a missing key by R5.2.)
- R6.4: When a required field is missing or has an unexpected type, the system shall not start and shall log which field is wrong.

## Out of scope for this feature

- Automatic retries if the Kindle is unreachable (feature 2).
- "Follow" button and chapter tracking (feature 5).
- `/list`, `/drop`, `/status` commands (feature 7).
- Automatic startup with launchd (project non-functional requirement, solved at the end or together with the queue).

## Acceptance criteria (Given/When/Then)

1. **Given** the owner shares a valid link to an AO3 work, **when** FanFicFare downloads it successfully and `scp` copies it to the Kindle, **then** the bot confirms delivery with the fic's title.
2. **Given** the owner shares a link that is not from AO3, **when** the bot receives it, **then** it replies saying it does not recognize a valid link, without invoking FanFicFare.
3. **Given** FanFicFare fails to download (site down, 403, timeout), **when** the daemon detects it, **then** the bot reports the error without attempting `scp`.
4. **Given** the Kindle is off or off the network, **when** `scp` fails to connect within the timeout, **then** the bot reports the delivery error.
5. **Given** someone who is not the owner writes to the bot, **when** the daemon receives that message, **then** it does not reply at all.
