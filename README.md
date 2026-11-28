# Bookcarrier

🇬🇧 English · [🇪🇸 Español](./README.es.md)

A small personal daemon that carries books to your Kindle from your phone, through a private Telegram bot ready to read in KOReader.

Share ebooks and PDFs (EPUB, MOBI, PDF) to the bot as files and copies them to a books folder on the Kindle, it also handles fanfics from [Archive of Our Own](https://archiveofourown.org) (AO3), share an AO3 link with the bot, and a few moments later the EPUB is on the Kindle.

## Behind the scenes

```
phone ──share link──▶ Telegram bot ──▶ Bookcarrier  ──FanFicFare──▶ EPUB ──scp──▶ Kindle

phone ──send file──▶ Telegram bot ──▶ Bookcarrier ──getFile──▶ EPUB/MOBI/PDF ──scp──▶ Kindle
```

## What it does today

- Accepts an AO3 work link shared to the bot, even when the share menu sends the title and the URL together (Downloads the fic as an EPUB with [FanFicFare](https://github.com/JimmXinu/FanFicFare), named `<work-id>-<title>.epub` so the name is stable.).
- Accepts a document sent to the bot as a file (EPUB, MOBI or PDF by default, up to 20 MB) and copies it to its folder on the Kindle (`/mnt/us/documents/books/` by default, not the fics' folder). If a file with that name is already there, it asks whether to replace it.
- Copies it to the Kindle with `scp`.
- On an **in-progress** AO3 fic, the delivery message has a **Follow** button: it stores the fic with the number of chapters delivered, so the daily check (feature 6) knows where to look from. **Unfollow** stops following it, and a followed fic that becomes complete is unfollowed on its own. This feature does not ask AO3 for new chapters.
- Tells you, in the chat, whether it was delivered or exactly what failed.
- If the failure is transient (AO3 down or rate-limiting, the Kindle's Wi-Fi asleep), it **keeps the request in a persistent queue and retries it on its own** for up to 30 minutes; if AO3 is still rate-limiting (`429`) by then, it keeps the request and tries again every 2 hours for up to 24 hours (see [Retry queue](#retry-queue)). Documents are **not** retried: if the Kindle is unreachable, you send the file again.

- Can run as a macOS LaunchAgent: it starts at login and comes back on its own if it crashes (see [Run as a LaunchAgent](#4-run-as-a-launchagent)).
- Has a control panel: `bookcarrierctl` in the terminal and a menu bar item (SwiftBar) to start, stop and check the daemon (see [Control panel](#control-panel)).
- Only answers **you**: messages from any other Telegram account are ignored without a reply.

## Requirements

| What                                                 | Notes                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                                                | Developed and tested on macOS (Apple Silicon).                                                                                                    |
| Node 24.15+                                          | `nvm use` reads `.nvmrc` for development; the LaunchAgent uses Homebrew's `node@24` (`brew install node@24`).                                     |
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

| Field                  | Required | Default                                                                                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | :------: | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telegramToken`        |    ✔     |                                                                                                                 | Token from @BotFather. **Never commit it.**                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ownerId`              |    ✔     |                                                                                                                 | Your numeric Telegram ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kindleUser`           |    ✔     |                                                                                                                 | SSH user on the Kindle (usually `root`).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kindleHost`           |    ✔     |                                                                                                                 | IP or hostname only, **without** the user.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sshKeyPath`           |    ✔     |                                                                                                                 | Path to the private key. A leading `~` is expanded.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kindlePort`           |          | `2222`                                                                                                          | SSH port on the Kindle (`22` if you use USBNetwork's sshd).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `remotePath`           |          | `/mnt/us/documents/books/`                                                                                      | Destination folder for the fics on the Kindle. **It must already exist**: `scp` does not create folders.                                                                                                                                                                                                                                                                                                                                                                    |
| `documentFolders`      |          | `{ "epub": "/mnt/us/documents/books/", "mobi": "/mnt/us/documents/books/", "pdf": "/mnt/us/documents/books/" }` | Which document formats are accepted and where each one goes. Keys are lower-case extensions without the dot (`pdf`, not `PDF` or `.pdf`); values are absolute folders on the Kindle (a missing trailing `/` is added). If present, it **replaces** the default as a whole (it is not merged): leave a format out to stop accepting it. Every folder must already exist. A format KOReader cannot open (for example `azw3`) can be added, but it will not be readable there. |
| `downloadTimeoutMs`    |          | `600000`                                                                                                        | Maximum time for a download (10 min).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `uploadTimeoutMs`      |          | `120000`                                                                                                        | Maximum time for the copy (2 min).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sshConnectTimeoutSec` |          | `10`                                                                                                            | SSH `ConnectTimeout`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `queuePath`            |          | `~/.bookcarrier/queue.json`                                                                                     | Retry queue state file. A leading `~` is expanded.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `followsPath`          |          | `~/.bookcarrier/follows.json` | Followed fics state file (also keeps the last 10 delivered fics that offered Follow). A leading `~` is expanded. |
| `spoolDir`             |          | `~/.bookcarrier/spool`                                                                                          | Where downloaded EPUBs wait for delivery. Never the system temp folder. `~` is expanded.                                                                                                                                                                                                                                                                                                                                                                                    |
| `giveUpAfterMs`        |          | `1800000`                                                                                                       | Give up on a queued request this long after it was first enqueued (30 min).                                                                                                                                                                                                                                                                                                                                                                                                 |
| `retryBackoffMinutes`  |          | `[1, 2, 4, 8, 15]`                                                                                              | Wait before each retry, in minutes. A non-empty list of positive integers.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `deferredRetryMs`      |          | `7200000`                                                                                                       | When AO3 keeps answering `429` past `giveUpAfterMs`, the request is kept and retried this often (2 h). See [Retry queue](#retry-queue).                                                                                                                                                                                                                                                                                                                                     |
| `deferredGiveUpAfterMs` |          | `86400000`                                                                                                      | A request deferred by AO3's rate limit is abandoned once its next retry would land later than this after it was first enqueued (24 h).                                                                                                                                                                                                                                                                                                                                      |

If a required field is missing or has the wrong type, the daemon does not start and the log says which field is wrong.

### 3. Run it

```bash
pnpm start        # node dist/index.js
```

Run `pnpm build` again after changing the code. Stop it with `Ctrl+C` (a clean exit). Only **one** instance can poll a given bot at a time; a second one gets a Telegram `409 Conflict`.

At startup the daemon checks that `fanficfare`, `scp` and `ssh` can be found on the `PATH`. If one is missing it logs an error naming it (and the `PATH` it searched), but it still starts.

To keep it running in the background, install it as a LaunchAgent (next section) instead of using `pnpm start`.

### 4. Run as a LaunchAgent

The repo ships a template plist, [`launchd/com.codebymaribel.bookcarrier.plist`](./launchd/com.codebymaribel.bookcarrier.plist). It starts the daemon at login (`RunAtLoad`), relaunches it if it crashes but not after a clean exit (`KeepAlive: { SuccessfulExit: false }`), waits 10 s between relaunches (`ThrottleInterval`) and writes its logs to `~/Library/Logs/Bookcarrier/`.

`bin/bookcarrierctl install` installs it for you: it copies the template to `~/Library/LaunchAgents/`, fills in the absolute paths of the repo and your home (launchd does not expand `~` or `$HOME`), creates the log folder, validates the plist with `plutil -lint` and loads it. Nothing to edit by hand.

```bash
brew install node@24          # stable path: /opt/homebrew/opt/node@24/bin/node
pnpm build                    # install needs dist/index.js
bin/bookcarrierctl install
bin/bookcarrierctl status     # Bookcarrier: running (PID 30046) · 0 in retry queue
```

- If Node 24 or `dist/index.js` is missing, `install` says which one and what to run, and writes nothing.
- Running `install` again replaces the installed plist with a fresh copy of the template and reloads the job: that is how you apply changes to the template. If the new plist is not valid, nothing is changed.
- `bookcarrierctl uninstall` unloads the job and deletes the plist. It keeps the logs, the queue and the spool.

There is no npm bin for `bookcarrierctl` (it has to work without Node on the `PATH`, for the menu bar). To run it from anywhere, symlink it into a folder on your `PATH`, or add the repo's `bin/` to your `PATH`:

```bash
ln -s "$PWD/bin/bookcarrierctl" ~/bin/bookcarrierctl    # from the repo root; ~/bin must be on your PATH
# or, in ~/.zshrc:
export PATH="/absolute/path/to/bookcarrier/bin:$PATH"
```

It works from any directory and through a symlink. The rest of this README calls it `bookcarrierctl`; all its commands are in [Control panel](#control-panel).

A few things worth knowing:

- **Keep the `EnvironmentVariables.PATH` entry.** launchd gives its jobs almost no `PATH`, and child processes inherit it. Without Homebrew's prefix, `fanficfare` cannot be found and every download fails as if the configuration were broken. The startup check above logs it if that happens.
- **The node path is the versioned Homebrew one** (`/opt/homebrew/opt/node@24/bin/node`): it survives patch upgrades and does not jump major versions. The nvm path includes the patch version and breaks on update.
- **Edit the template in `launchd/`, not the installed copy**: `install` overwrites `~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist`.
- Only one instance can poll the bot: stop any `pnpm start` before installing the LaunchAgent.
- Logs: one file, `~/Library/Logs/Bookcarrier/bookcarrier.log` (no rotation), with the daemon's INFO, WARN and ERROR lines in order. `bookcarrierctl logs` shows its last lines. An install from before the single log keeps writing to the old `bookcarrier.out.log` and `bookcarrier.err.log` until you run `bookcarrierctl install` again; the old files are not deleted.

### 5. Restart the daemon

The daemon reads `~/.bookcarrier/config.json` and loads `dist/` only at startup, so it needs a restart after any change. What to run depends on what changed:

| You changed                            | Run                                         |
| -------------------------------------- | ------------------------------------------- |
| The code (`src/`)                      | `pnpm build`, then `bookcarrierctl restart` |
| `~/.bookcarrier/config.json`           | `bookcarrierctl restart` (no build needed)  |
| The plist template (`launchd/…plist`)  | `bookcarrierctl install`                    |

`restart` stops the running process and starts it again. After a template change it is not enough, because launchd keeps the copy it loaded; `install` writes a fresh plist and reloads the job.

Check that it came back up:

```bash
bookcarrierctl status     # Bookcarrier: running (PID 30046) · 0 in retry queue
bookcarrierctl logs       # last 50 lines of bookcarrier.log
```

`running` with a PID means it is up. If it says `crashed` or `stopped` instead, the last `WARN`/`ERROR` lines of `bookcarrier.log` say why (for example, a config error names the field).

If you run it with `pnpm start` instead, stop it with `Ctrl+C` and run `pnpm start` again.

## Control panel

`bin/bookcarrierctl` is the only thing that talks to `launchctl` for Bookcarrier, and the menu bar item only calls `bookcarrierctl`. It is plain Bash and needs no Node. See [Run as a LaunchAgent](#4-run-as-a-launchagent) to put it on your `PATH`.

| Command                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Exit                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `status [--porcelain]`     | The state (`running` with its PID, `stopped`, `crashed` with the last exit status, `not-loaded`, `not-installed`) and the number of items in the retry queue, split into those waiting to download and those waiting to send (`2 in retry queue (1 to download, 1 to send)`). `--porcelain` prints `state=`, `pid=`, `last_exit=`, `queue_items=`, `queue_download=` and `queue_send=` lines for scripts (`-` when there is no value, `?` for the queue counts when the queue file cannot be read). | 0 if running, 3 otherwise |
| `start`                    | Starts the daemon (loads the job if it is not loaded). If it is already running, says so and does nothing.                                                                                                                                                                                                                                                                                                                                                                                          | 0 / 1                     |
| `stop`                     | Sends SIGTERM, so the daemon exits cleanly and launchd does not relaunch it until `bookcarrierctl start`. Waits up to 15 s; if it is still running, says so and exits 1. Never sends SIGKILL.                                                                                                                                                                                                                                                                                                       | 0 / 1                     |
| `restart`                  | Stops and starts the daemon again, for example after `pnpm build` (loads the job if it is not loaded).                                                                                                                                                                                                                                                                                                                                                                                              | 0 / 1                     |
| `install`                  | Installs the LaunchAgent and loads it; run it again to apply template changes (see [Run as a LaunchAgent](#4-run-as-a-launchagent)).                                                                                                                                                                                                                                                                                                                                                                | 0 / 1                     |
| `uninstall`                | Unloads the job and deletes its plist. Keeps the logs, the queue and the spool.                                                                                                                                                                                                                                                                                                                                                                                                                     | 0 / 1                     |
| `logs [-f]`                | The last 50 lines of `bookcarrier.log`. `-f` (or `--follow`) keeps following it until `Ctrl+C`.                                                                                                                                                                                                                                                                                                                                                                                                     | `tail`'s                  |
| `menubar install <folder>` | Installs the SwiftBar plugin into `<folder>` (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0 / 1                     |
| `help`                     | Prints the usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0                         |

An unknown command or option prints the usage and exits 2. When the LaunchAgent is not installed, `start`, `stop` and `restart` exit 1 with `Bookcarrier is not installed. Run: bookcarrierctl install`.

**Custom `queuePath`:** `bookcarrierctl` and the menu bar read the queue from `~/.bookcarrier/queue.json`. If you set `queuePath` in `config.json`, also set `BOOKCARRIER_QUEUE_FILE` to the same path (it does not read `config.json`).

Under the hood it uses `launchctl list`, `bootstrap`, `bootout`, `kickstart [-k]` and `kill SIGTERM` on `gui/$(id -u)/com.codebymaribel.bookcarrier`, so those still work by hand if you ever need them.

### Menu bar (SwiftBar)

[SwiftBar](https://github.com/swiftbar/SwiftBar) shows the daemon's state in the menu bar and lets you start or stop it with a click.

1. `brew install swiftbar`
2. Open SwiftBar and choose a plugin folder when it asks (for example `~/SwiftBarPlugins`).
3. Install the plugin into that folder:

   ```bash
   bookcarrierctl menubar install ~/SwiftBarPlugins
   ```

   It writes `bookcarrier.10s.sh` there, with this repo's path filled in. Run it again if you move the repo.

The icon has a different symbol for each state, so it does not depend on color:

| State                               | Icon                                               | First menu line                              | Actions       |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------- | ------------- |
| Running                             | filled book (`book.fill`)                          | `Running · PID 30046`                        | Stop, Restart |
| Stopped or not loaded               | outlined book (`book`)                             | `Stopped`                                    | Start         |
| Crashed                             | warning triangle (`exclamationmark.triangle.fill`) | `Crashed (last exit 9) — launchd will retry` | Start         |
| Not installed                       | closed book (`book.closed`)                        | `Not installed`                              | Install       |
| `bookcarrierctl` missing or failing | question mark (`questionmark.circle`)              | the error                                    | none          |

- The second line shows the retry queue split by stage: `Retry queue: 1 to download · 1 to send` (both parts always, even when one is 0), `Retry queue: empty` when it has no items, or `Retry queue unreadable`.
- Actions run the matching `bookcarrierctl` command in the background (no Terminal window) and refresh the menu right after.
- Every menu also has **Open logs** (`bookcarrier.log` in Console), **Open spool folder** (`~/.bookcarrier/spool` in Finder) and **Open queue file**.
- The plugin refreshes every 10 seconds (the `10s` in its name). A state-changing `bookcarrierctl` command run in the terminal also refreshes it at once.
- To start SwiftBar at login, use SwiftBar's own "Launch at login" setting.

## Using it

Share (or paste) an AO3 work link to the bot, or send it a document as a file. It replies right away and again when it is done.

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
| (later) 30 minutes pass and AO3 still answers `429`                             | FanFicFare is having trouble with AO3; it saved the request and will try again in about 2 hours, for up to 24 hours. |
| A link while a request is waiting on AO3's `429`                                | It saves it without downloading (AO3 is not hit) and says when it will try.                |
| (later) 24 hours pass and AO3 still answers `429`                               | It gave up because AO3 kept rate-limiting FanFicFare, with the last error.                 |
| A link, but the SSH key or `scp` is misconfigured                               | A configuration error naming the problem (missing key, open permissions, `scp` not found). |

If a message contains several AO3 links, only the first one is used.

Following a fic (in-progress AO3 fics only; documents are never followed):

| This happens | The bot answers |
| --- | --- |
| An in-progress fic is delivered | `Delivered “Title” to your Kindle.` with a **Follow** button. |
| → you tap **Follow** | `Following “Title” — 12 chapters delivered.` and the button becomes **Unfollow**. |
| → you tap **Unfollow** | `OK, I'm no longer following “Title”.` and the button disappears. |
| You send the link of a followed fic again | `Delivered “Title” to your Kindle. I updated your follow: now 14 chapters.` with an **Unfollow** button: the stored chapters and status update on their own. |
| A fic that is already complete is delivered | `Delivered “Title” to your Kindle.` with **no** button: complete fics are not followed. |
| You send a followed fic again and it is complete now | `Delivered “Title” to your Kindle. It's complete now, so I'm no longer following it.` It is unfollowed on its own, with no button. |
| → you tap an old **Follow** button, after 10 newer fics were delivered (or the fic is unknown) | `I don't have that fic any more. Send me its link again to follow it.` Nothing is stored. |
| FanFicFare leaves no usable chapter metadata | The fic is still delivered, with **no** **Follow** button, and a warning is logged. |
| The followed fics file is unreadable at startup | `The file with your followed fics was unreadable, so I started with none followed. The old file was kept as <path> so it can be inspected.` (the old file is `follows.json.corrupt-<timestamp>`). |

A fic's **Follow** button keeps working for the last 10 delivered fics, even across a daemon restart. Followed fics do not count towards that limit. A request that was deferred by AO3's rate limit offers **Follow** too, when it is finally delivered.

For a document (EPUB, MOBI, PDF, as a file; the caption is ignored):

| You send                                                          | The bot answers                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Libro.epub`, not yet on the Kindle                               | `Got it, checking your Kindle…`, then `Delivered “Libro.epub” to your Kindle.`                                                            |
| A file in a format that is not accepted (`.azw3`, `.jpg`, a GIF…) | `I can't send that kind of file. Send me one of: EPUB, MOBI, PDF.` (the list comes from `documentFolders`)                                |
| A file bigger than 20 MB                                          | `That file is 25 MB; I can only fetch files up to 20 MB from Telegram.` Nothing is downloaded.                                            |
| `Libro.epub`, already on the Kindle                               | `“Libro.epub” is already on your Kindle. Replace it?` with two buttons, **Replace** and **Cancel**.                                       |
| → you tap **Replace**                                             | The file is downloaded and overwritten, then `Delivered “Libro.epub” to your Kindle.`                                                     |
| → you tap **Cancel**                                              | `OK, I left “Libro.epub” as it was. Nothing was sent.`                                                                                    |
| → you tap a button after 10 minutes, or after a daemon restart    | `That request is no longer pending. Send me the file again.`                                                                              |
| A file, but the Kindle is off or asleep                           | `I couldn't send “Libro.epub” to your Kindle (…). Is it awake and on the Wi-Fi? Send me the file again when it is.` It is **not** queued. |
| A file, but Telegram's download fails                             | `I couldn't get that file from Telegram: …`                                                                                               |
| A file, but the SSH key or `ssh`/`scp` is misconfigured           | A configuration error naming the problem.                                                                                                 |

The name on the Kindle is the file's name with the characters the Kindle's FAT32 partition rejects (`\ / : * ? " < > |`) turned into `_`: `Dune: Messiah.epub` arrives as `Dune_ Messiah.epub`. Accents are kept (`Corazón.pdf`). Extensions are matched ignoring case (`Report.PDF` is accepted).

## Retry queue

Every failure is classified as **transient** or **permanent**:

- **Transient** — network failure, AO3 `429`/`403`, a timeout, the Kindle not answering. Retrying can fix it, so the request goes into the queue.
- **Permanent** — the work does not exist, `fanficfare` or `scp` cannot be launched, the SSH key is missing or has open permissions. Retrying will not fix it, so the bot reports it right away and nothing is queued.

A queued request remembers its **stage**. If the download failed, the retry downloads again; if only the copy to the Kindle failed, the EPUB is already in the spool and the retry only runs `scp` — AO3 is not hit again.

- **Backoff:** retries happen 1, 2, 4, 8 and 15 minutes apart (cumulative 1, 3, 7, 15, 30).
- **Give up:** 30 minutes after it was first enqueued, the request is abandoned and its EPUB deleted from the spool — except when AO3 is still rate-limiting (`429`), see [below](#when-ao3-keeps-rate-limiting-429).
- **Notifications:** one message when it is enqueued, one when it is delivered (with the title), one when it is given up (with the last error). Failed attempts in between are silent.
- **Persistence:** the queue lives in `~/.bookcarrier/queue.json` (written atomically) and the EPUBs in `~/.bookcarrier/spool/`. After a restart the daemon restores the queue, reschedules the retries and deletes spool files no queued item refers to. If the queue file is unreadable, it is kept aside as `queue.json.corrupt-<timestamp>`, the daemon starts with an empty queue and tells you.
- **No idle work:** with an empty queue there is no timer at all; otherwise a single timer points at the next due retry.

The window and the ladder are configurable (`giveUpAfterMs`, `retryBackoffMinutes`).

### When AO3 keeps rate-limiting (`429`)

AO3 can answer `429 Too Many Requests` for hours. A request whose 30-minute window runs out while the last error is still a `429` is **not** abandoned:

- It is kept as **deferred** (in the queue file, so it survives a restart) and retried **every 2 hours**.
- You get one message saying FanFicFare is having trouble with AO3 and when it will try again. Failed deferred retries are silent; a delivery is announced as usual.
- It is abandoned (and you are told, with the last error) once its next retry would land more than **24 hours** after it was first enqueued.
- While any request is deferred, AO3 is considered to be **cooling down**: a new link is not downloaded, it is saved as deferred and tried together with the earliest deferred request. This avoids prolonging the rate limit. Likewise, once a deferred retry gets another `429`, the other deferred requests due at that moment wait another 2 hours without hitting AO3.
- Only rate-limit failures are deferred. Any other failure (AO3 `403`/`5xx`, a timeout, the Kindle asleep) is still abandoned at 30 minutes. A deferred request that downloads but then cannot reach the Kindle keeps the 2-hour cadence.

Both limits are configurable (`deferredRetryMs`, `deferredGiveUpAfterMs`).

## How it works

1. `ownerOnly` drops every update that is not from the owner, without replying.
2. `extractWorkLink` finds the AO3 URL inside the text (checking the exact hostname) and rebuilds the canonical URL `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` runs `fanficfare` as a subprocess in an empty folder of the spool and picks up the single `.epub` it leaves there. FanFicFare itself names and sanitizes the file.
4. `uploadToKindle` checks the SSH key first (the same criterion SSH uses), then runs `scp`.
5. Next to the EPUB, `fanficfare` writes `<name>.epub.json` (`--json-meta-file`). `parseFicMeta` reads the published chapter count (`numChapters`) and the status (`Completed` / `In-Progress`) from it, with no extra request to AO3. If the JSON is missing or unusable, the fic is still delivered, just without a **Follow** button. Once the fic is delivered, `follows.onDelivered` decides whether to offer **Follow**, update a followed fic or unfollow it (`follows.json`). A request deferred by AO3's rate limit reads this metadata once it is finally downloaded, so it offers **Follow** when it is delivered.
6. The bot replies. On success the EPUB is deleted from the spool; on a transient failure the request goes into the retry queue; on a permanent one the error is reported and the EPUB deleted.

For a document:

1. `ownerOnly` also drops documents and button taps that are not from the owner.
2. `validateDocument` accepts the file only if its extension is a key of `documentFolders` and Telegram declares it at most 20 MB, and `sanitizeFileName` builds the name it will have on the Kindle.
3. `existsOnKindle` runs `ssh … test -e '<folder><name>'`, with the path single-quoted so the Kindle's shell never interprets any character of the name. Exit `0` means it exists, `1` that it does not; anything else means the Kindle is unreachable, and nothing is downloaded.
4. If it exists, the bot asks with **Replace** / **Cancel** buttons and returns right away. Only the Telegram `file_id`, the name and the folder are kept, in memory, for 10 minutes.
5. To deliver, the file is downloaded from Telegram (`getFile` + `fetch`) into a temporary folder of its own (never the spool), sent with `uploadToKindle` to its folder, and the temporary folder is deleted whatever the outcome. Documents never go into the retry queue, and the bot token never appears in a log line or a message.

A few deliberate choices:

- **Subprocesses use `spawn`, never `exec`**, and everything is async: nothing blocks the event loop.
- **Configuration problems and delivery failures are told apart without reading `scp`'s exit code**: a bad key is detected _before_ launching `scp`, a missing binary by the `error` event, and any other failure is a delivery failure.
- **Messages are processed one at a time**, in arrival order (grammY's long polling). A second link is acknowledged when the first one finishes. New requests and retries share the same line, so AO3 and the Kindle only ever see one operation at a time.
- Error messages show only the last useful line of a subprocess's stderr, never a stack trace. The full detail goes to the log.

## Project layout

```
src/              one folder per bounded context; each exposes an index.ts, the only thing
                  other contexts import; unit tests sit next to the module they test (*.test.ts)
  index.ts        entrypoint: loads the config, checks binaries, starts long polling
  app/            composition root
    daemon.ts       startup: restores the queue, reconciles the spool, arms the retry timer
    binaries.ts     startup check that fanficfare, scp and ssh are on the PATH
  telegram/       Telegram interface
    bot.ts          owner filter, text/document handlers and the Replace/Cancel buttons
  fanfic/         fics shared as AO3 links
    pipeline.ts     the request and retry flow (orchestration), one operation at a time
    ao3-link.ts     finds and validates the AO3 work link in a message
    downloader.ts   FanFicFare subprocess wrapper
    fic-meta.ts     reads a fic's chapter count and status from FanFicFare's metadata file
    failure.ts      transient vs permanent failure classification, AO3 rate-limit (429) detection
    messages.ts     every text about fics, and their error → message mapping
  follows/        followed fics
    follows.ts      Follow, Unfollow, the last 10 delivered fics and the follows.json state
    messages.ts     every text about following fics, and the corrupt-follows-file notice
  documents/      documents sent to the bot as files
    flow.ts         the document flow (orchestration), including the Replace/Cancel question
    document.ts     document validation and file name sanitization
    telegram-file.ts downloads a file sent to the bot (getFile + fetch), without leaking the token
    pending.ts      in-memory pending Replace/Cancel questions, with a 10-minute expiry
    messages.ts     every text about documents, and their error → message mapping
  retry-queue/    retry queue
    queue.ts        backoff, give-up window and AO3 rate-limit deferral policy
    state.ts        the persisted queue file (atomic writes, corrupt-file backup)
    spool.ts        one directory per queued request, holding its EPUB
    scheduler.ts    the single timer that wakes up for the next due item
    messages.ts     the corrupt-queue-file notice
  kindle/         delivery to the Kindle
    uploader.ts     scp subprocess wrapper
    ssh.ts          SSH options and key check shared by scp and ssh; existence check on the Kindle
    messages.ts     the Kindle configuration-problem text
  shared/         config.ts (loads and validates ~/.bookcarrier/config.json), logger.ts,
                  json-file.ts (atomic, versioned JSON file read/write shared by the queue and the follows),
                  subprocess.ts (helpers for the subprocess wrappers), messages.ts (generic text)
test/             Vitest tests of bookcarrierctl, the launchd plist and the SwiftBar template
docs/specs/       the specifications (see below)
launchd/          template LaunchAgent plist
bin/              bookcarrierctl, the control panel script
swiftbar/         SwiftBar menu bar plugin template
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

| #   | Feature                                               | State        |
| --- | ----------------------------------------------------- | ------------ |
| 1   | Send an AO3 fic from a link                           | ✅ Done      |
| 2   | Retry queue + start at login with launchd (+ deferral on AO3 `429`) | ✅ Done      |
| 3   | Send a document as a file (EPUB, MOBI, PDF)           | ✅ Done      |
| 4   | Control panel: `bookcarrierctl` + menu bar (SwiftBar) | ✅ Done      |
| 5   | “Follow” button and chapter tracking                  | ✅ Done      |
| 6   | Daily check for new chapters                          | Planned      |
| 7   | `/list`, `/drop`, `/status` commands                  | Planned      |

## Known limitations

- Retries stop 30 minutes after the first failure: a Kindle that stays off longer than that gets the request abandoned, and the link has to be shared again (one tap from the phone). The window is configurable (`giveUpAfterMs`). Only AO3's `429` rate limit gets the longer, 24-hour deferral.
- A request that is still on its first attempt when the daemon stops is lost; only requests already in the queue survive a restart.
- Titles with accents lose them in the file name and in the confirmation message (`Corazón` → `Coraz_n`), because FanFicFare sanitizes file names.
- Only individual AO3 works are supported (no series or collections).
- Documents sent as files are limited to 20 MB (the Bot API's download limit) and are not retried: if the Kindle is unreachable, the file has to be sent again.
- A document is validated by its extension only; its content is not checked.
- The log files under `~/Library/Logs/Bookcarrier/` are not rotated.

## A note on AO3

This is a personal tool for your own reading. Please respect [AO3's Terms of Service](https://archiveofourown.org/tos) and don't hammer the site. FanFicFare already backs off on errors, and Bookcarrier sends one request at a time.
