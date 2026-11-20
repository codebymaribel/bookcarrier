# Bookcarrier

🇬🇧 English · [🇪🇸 Español](./README.es.md)

A small personal daemon that carries books to your Kindle from your phone, through a private Telegram bot. Today it handles fanfics from [Archive of Our Own](https://archiveofourown.org) (AO3): share an AO3 link with the bot, and a few moments later the EPUB is on the Kindle, ready to read in KOReader. Next it will also take ebooks and PDFs sent to the bot as files (see [Roadmap](#roadmap)).

```
phone ──share link──▶ Telegram bot ──▶ Bookcarrier (on your Mac) ──FanFicFare──▶ EPUB ──scp──▶ Kindle
                           ◀──────────── "Delivered “Title” to your Kindle." ◀──────────────┘
```

> **Status:** Feature 1 (send an AO3 fic) is done and verified end to end. Feature 2 (retry queue + start at login with launchd) is built and covered by tests; its manual verification on the real Kindle is still pending. Sending ebooks and PDFs as files (feature 3) is specified but not built yet.
>
> The project was called **Ficarrier** while it only handled fanfics; it was renamed when its scope grew to books in general.

## What it does today

- Accepts an AO3 work link shared to the bot, even when the share menu sends the title and the URL together.
- Downloads the fic as an EPUB with [FanFicFare](https://github.com/JimmXinu/FanFicFare), named `<work-id>-<title>.epub` so the name is stable.
- Copies it to the Kindle with `scp`.
- Tells you, in the chat, whether it was delivered or exactly what failed.
- If the failure is transient (AO3 down or rate-limiting, the Kindle's Wi-Fi asleep), it **keeps the request in a persistent queue and retries it on its own** for up to 30 minutes (see [Retry queue](#retry-queue)).
- Can run as a macOS LaunchAgent: it starts at login and comes back on its own if it crashes (see [Run as a LaunchAgent](#4-run-as-a-launchagent)).
- Only answers **you**: messages from any other Telegram account are ignored without a reply.

## Requirements

| What                                                 | Notes                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                                                | Developed and tested on macOS (Apple Silicon).                                                                                                    |
| Node 24                                              | `nvm use` reads `.nvmrc` for development; the LaunchAgent uses Homebrew's `node@24` (`brew install node@24`).                                     |
| [pnpm](https://pnpm.io)                              |                                                                                                                                                   |
| [FanFicFare](https://github.com/JimmXinu/FanFicFare) | `brew install fanficfare`                                                                                                                         |
| A Telegram bot                                       | Create one with [@BotFather](https://t.me/BotFather) and keep its token.                                                                          |
| A Kindle with SSH access                             | A jailbroken Kindle running an SSH server, for example KOReader's (listens on port **2222**). The Mac and the Kindle must be on the same network. |
| A dedicated SSH key                                  | Already authorized on the Kindle, with permissions `600` or `400`.                                                                                |

## Setup

```bash
nvm use
pnpm install
pnpm build
```

### 1. Find your Telegram ID

The bot only answers the owner, so it needs your numeric Telegram ID (not your @username). A quick way is to write a few lines with [grammY](https://grammy.dev) that reply with `ctx.from.id`, or to use any "what is my ID" bot.

### 2. Create the config file

The real config lives **outside** the repository, in `~/.bookcarrier/config.json`. The repo only ships `config.example.json`, with placeholders.

```bash
mkdir -p ~/.bookcarrier
cp config.example.json ~/.bookcarrier/config.json
chmod 600 ~/.bookcarrier/config.json
```

Then edit it:

| Field                  | Required | Default                    | Meaning                                                                                     |
| ---------------------- | :------: | -------------------------- | ------------------------------------------------------------------------------------------- |
| `telegramToken`        |    ✔     |                            | Token from @BotFather. **Never commit it.**                                                 |
| `ownerId`              |    ✔     |                            | Your numeric Telegram ID.                                                                   |
| `kindleUser`           |    ✔     |                            | SSH user on the Kindle (usually `root`).                                                    |
| `kindleHost`           |    ✔     |                            | IP or hostname only, **without** the user.                                                  |
| `sshKeyPath`           |    ✔     |                            | Path to the private key. A leading `~` is expanded.                                         |
| `kindlePort`           |          | `2222`                     | SSH port on the Kindle (`22` if you use USBNetwork's sshd).                                 |
| `remotePath`           |          | `/mnt/us/documents/books/` | Destination folder on the Kindle. **It must already exist**: `scp` does not create folders. |
| `downloadTimeoutMs`    |          | `600000`                   | Maximum time for a download (10 min).                                                       |
| `uploadTimeoutMs`      |          | `120000`                   | Maximum time for the copy (2 min).                                                          |
| `sshConnectTimeoutSec` |          | `10`                       | SSH `ConnectTimeout`.                                                                       |
| `queuePath`            |          | `~/.bookcarrier/queue.json` | Retry queue state file. A leading `~` is expanded.                                         |
| `spoolDir`             |          | `~/.bookcarrier/spool`     | Where downloaded EPUBs wait for delivery. Never the system temp folder. `~` is expanded.     |
| `giveUpAfterMs`        |          | `1800000`                  | Give up on a queued request this long after it was first enqueued (30 min).                 |
| `retryBackoffMinutes`  |          | `[1, 2, 4, 8, 15]`         | Wait before each retry, in minutes. A non-empty list of positive integers.                  |

If a required field is missing or has the wrong type, the daemon does not start and the log says which field is wrong.

### 3. Run it

```bash
pnpm start        # node dist/index.js
```

Run `pnpm build` again after changing the code. Stop it with `Ctrl+C` (a clean exit). Only **one** instance can poll a given bot at a time; a second one gets a Telegram `409 Conflict`.

At startup the daemon checks that `fanficfare` and `scp` can be found on the `PATH`. If one is missing it logs an error naming it (and the `PATH` it searched), but it still starts.

To keep it running in the background, install it as a LaunchAgent (next section) instead of using `pnpm start`.

### 4. Run as a LaunchAgent

The repo ships a template plist, [`launchd/com.codebymaribel.bookcarrier.plist`](./launchd/com.codebymaribel.bookcarrier.plist). It starts the daemon at login (`RunAtLoad`), relaunches it if it crashes but not after a clean exit (`KeepAlive: { SuccessfulExit: false }`), waits 10 s between relaunches (`ThrottleInterval`) and writes its logs to `~/Library/Logs/Bookcarrier/`.

```bash
brew install node@24                      # stable path: /opt/homebrew/opt/node@24/bin/node
pnpm build
mkdir -p ~/Library/Logs/Bookcarrier
cp launchd/com.codebymaribel.bookcarrier.plist ~/Library/LaunchAgents/
```

Edit `~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist` and replace the placeholders with absolute paths (launchd does not expand `~` or `$HOME`):

- `__REPO__` → the absolute path of this repository (`pwd` at its root).
- `__HOME__` → your home directory (`echo $HOME`).

Then validate it and load it:

```bash
plutil -lint ~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist
launchctl print gui/$(id -u)/com.codebymaribel.bookcarrier     # state, PID, last exit code
```

To stop it and unload it (for example before editing the plist):

```bash
launchctl bootout gui/$(id -u)/com.codebymaribel.bookcarrier
```

A few things worth knowing:

- **Keep the `EnvironmentVariables.PATH` entry.** launchd gives its jobs almost no `PATH`, and child processes inherit it. Without Homebrew's prefix, `fanficfare` cannot be found and every download fails as if the configuration were broken. The startup check above logs it if that happens.
- **The node path is the versioned Homebrew one** (`/opt/homebrew/opt/node@24/bin/node`): it survives patch upgrades and does not jump major versions. The nvm path includes the patch version and breaks on update.
- Only one instance can poll the bot: stop any `pnpm start` before loading the LaunchAgent.
- Logs: `~/Library/Logs/Bookcarrier/bookcarrier.out.log` and `bookcarrier.err.log` (no rotation).

## Using it

Share (or paste) an AO3 work link to the bot. It replies right away and again when it is done.

| You send                                                                        | The bot answers                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A link to a work (also `…/works/123/chapters/456`, `…/collections/x/works/123`) | `Got it, downloading…`, then `Delivered “Title” to your Kindle.`                           |
| Text with no AO3 link                                                           | It does not recognize a valid AO3 link.                                                    |
| A link to a series, a user page, a collection page…                             | That type of link is not supported yet.                                                    |
| A link, but AO3 is down, rate-limiting (429/403) or times out                   | It could not download it right now and will keep retrying for up to 30 minutes.            |
| A link to a work that does not exist                                            | The cause; it is **not** retried.                                                          |
| A link, but the Kindle is off or asleep                                         | The fic was downloaded but could not be sent; it will keep retrying for up to 30 minutes.  |
| (later) a queued request gets through                                           | `Delivered “Title” to your Kindle.`                                                        |
| (later) 30 minutes pass without success                                         | It gave up, with the last error. Share the link again to try once more.                    |
| A link, but the SSH key or `scp` is misconfigured                               | A configuration error naming the problem (missing key, open permissions, `scp` not found). |

If a message contains several AO3 links, only the first one is used.

## Retry queue

Every failure is classified as **transient** or **permanent**:

- **Transient** — network failure, AO3 `429`/`403`, a timeout, the Kindle not answering. Retrying can fix it, so the request goes into the queue.
- **Permanent** — the work does not exist, `fanficfare` or `scp` cannot be launched, the SSH key is missing or has open permissions. Retrying will not fix it, so the bot reports it right away and nothing is queued.

A queued request remembers its **stage**. If the download failed, the retry downloads again; if only the copy to the Kindle failed, the EPUB is already in the spool and the retry only runs `scp` — AO3 is not hit again.

- **Backoff:** retries happen 1, 2, 4, 8 and 15 minutes apart (cumulative 1, 3, 7, 15, 30).
- **Give up:** 30 minutes after it was first enqueued, the request is abandoned and its EPUB deleted from the spool.
- **Notifications:** one message when it is enqueued, one when it is delivered (with the title), one when it is given up (with the last error). Failed attempts in between are silent.
- **Persistence:** the queue lives in `~/.bookcarrier/queue.json` (written atomically) and the EPUBs in `~/.bookcarrier/spool/`. After a restart the daemon restores the queue, reschedules the retries and deletes spool files no queued item refers to. If the queue file is unreadable, it is kept aside as `queue.json.corrupt-<timestamp>`, the daemon starts with an empty queue and tells you.
- **No idle work:** with an empty queue there is no timer at all; otherwise a single timer points at the next due retry.

The window and the ladder are configurable (`giveUpAfterMs`, `retryBackoffMinutes`).

## How it works

1. `ownerOnly` drops every update that is not from the owner, without replying.
2. `extractWorkLink` finds the AO3 URL inside the text (checking the exact hostname) and rebuilds the canonical URL `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` runs `fanficfare` as a subprocess in an empty folder of the spool and picks up the single `.epub` it leaves there. FanFicFare itself names and sanitizes the file.
4. `uploadToKindle` checks the SSH key first (the same criterion SSH uses), then runs `scp`.
5. The bot replies. On success the EPUB is deleted from the spool; on a transient failure the request goes into the retry queue; on a permanent one the error is reported and the EPUB deleted.

A few deliberate choices:

- **Subprocesses use `spawn`, never `exec`**, and everything is async: nothing blocks the event loop.
- **Configuration problems and delivery failures are told apart without reading `scp`'s exit code**: a bad key is detected _before_ launching `scp`, a missing binary by the `error` event, and any other failure is a delivery failure.
- **Messages are processed one at a time**, in arrival order (grammY's long polling). A second link is acknowledged when the first one finishes. New requests and retries share the same line, so AO3 and the Kindle only ever see one operation at a time.
- Error messages show only the last useful line of a subprocess's stderr, never a stack trace. The full detail goes to the log.

## Project layout

```
src/
  index.ts        entrypoint: loads the config, checks binaries, starts long polling
  daemon.ts       startup: restores the queue, reconciles the spool, arms the retry timer
  bot.ts          owner filter + the request flow (orchestration)
  errors.ts       transient vs permanent failure classification
  binaries.ts     startup check that fanficfare and scp are on the PATH
  queue/          retry queue: state file, backoff, spool, single timer
  messages.ts     every text sent to the owner, and the error → message mapping
  ao3-link.ts     finds and validates the AO3 work link in a message
  downloader.ts   FanFicFare subprocess wrapper
  uploader.ts     scp subprocess wrapper (+ SSH key check)
  subprocess.ts   helpers shared by the two wrappers
  config.ts       loads and validates ~/.bookcarrier/config.json
  logger.ts       small logger (levels + timestamps)
test/             Vitest tests, one file per module
docs/specs/       the specifications (see below)
launchd/          template LaunchAgent plist
```

## Development

```bash
pnpm test          # run the tests once
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
pnpm build         # compile src/ to dist/
```

The tests never call AO3 or the Kindle: the subprocesses and Telegram's API are replaced by fakes.

## Specifications

The project is built spec-first. Each feature has its own folder in [`docs/specs/`](./docs/specs) with `requirements.md` (EARS requirements), `research.md`, `design.md` and `tasks.md`; the rules shared by every feature are in [`_principles.md`](./docs/specs/_principles.md). The specs are the source of truth.

## Roadmap

| #   | Feature                                                 | State        |
| --- | ------------------------------------------------------- | ------------ |
| 1   | Send an AO3 fic from a link                             | ✅ Done      |
| 2   | Retry queue + start at login with launchd               | ✅ Done (manual verification pending) |
| 3   | Send an ebook or a PDF as a file (EPUB, MOBI, PDF)      | 📝 Specified |
| 4   | “Follow” button and chapter tracking                    | Planned      |
| 5   | Daily check for new chapters                            | Planned      |
| 6   | `/list`, `/drop`, `/status` commands                    | Planned      |

## Known limitations

- Retries stop 30 minutes after the first failure: a Kindle that stays off longer than that gets the request abandoned, and the link has to be shared again (one tap from the phone). The window is configurable (`giveUpAfterMs`).
- A request that is still on its first attempt when the daemon stops is lost; only requests already in the queue survive a restart.
- Titles with accents lose them in the file name and in the confirmation message (`Corazón` → `Coraz_n`), because FanFicFare sanitizes file names.
- Only individual AO3 works are supported (no series or collections).
- Files sent to the bot (ebooks, PDFs) are not handled yet: that is feature 3. For now the bot only answers AO3 links.
- The log files under `~/Library/Logs/Bookcarrier/` are not rotated.

## A note on AO3

This is a personal tool for your own reading. Please respect [AO3's Terms of Service](https://archiveofourown.org/tos) and don't hammer the site. FanFicFare already backs off on errors, and Bookcarrier sends one request at a time.
