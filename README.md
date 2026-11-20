# Bookcarrier

🇬🇧 English · [🇪🇸 Español](./README.es.md)

A small personal daemon that carries books to your Kindle from your phone, through a private Telegram bot. Today it handles fanfics from [Archive of Our Own](https://archiveofourown.org) (AO3): share an AO3 link with the bot, and a few moments later the EPUB is on the Kindle, ready to read in KOReader. Next it will also take ebooks and PDFs sent to the bot as files (see [Roadmap](#roadmap)).

```
phone ──share link──▶ Telegram bot ──▶ Bookcarrier (on your Mac) ──FanFicFare──▶ EPUB ──scp──▶ Kindle
                           ◀──────────── "Delivered “Title” to your Kindle." ◀──────────────┘
```

> **Status:** Feature 1 (send an AO3 fic) is done and verified end to end. The retry queue (feature 2) and sending ebooks and PDFs as files (feature 3) are specified but not built yet.
>
> The project was called **Ficarrier** while it only handled fanfics; it was renamed when its scope grew to books in general.

## What it does today

- Accepts an AO3 work link shared to the bot, even when the share menu sends the title and the URL together.
- Downloads the fic as an EPUB with [FanFicFare](https://github.com/JimmXinu/FanFicFare), named `<work-id>-<title>.epub` so the name is stable.
- Copies it to the Kindle with `scp`.
- Tells you, in the chat, whether it was delivered or exactly what failed.
- Only answers **you**: messages from any other Telegram account are ignored without a reply.

## Requirements

| What                                                 | Notes                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                                                | Developed and tested on macOS (Apple Silicon).                                                                                                    |
| Node 24                                              | `nvm use` reads `.nvmrc`.                                                                                                                         |
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

If a required field is missing or has the wrong type, the daemon does not start and the log says which field is wrong.

### 3. Run it

```bash
pnpm start        # node dist/index.js
```

Run `pnpm build` again after changing the code. Stop it with `Ctrl+C` (a clean exit). Only **one** instance can poll a given bot at a time; a second one gets a Telegram `409 Conflict`.

## Using it

Share (or paste) an AO3 work link to the bot. It replies right away and again when it is done.

| You send                                                                        | The bot answers                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A link to a work (also `…/works/123/chapters/456`, `…/collections/x/works/123`) | `Got it, downloading…`, then `Delivered “Title” to your Kindle.`                           |
| Text with no AO3 link                                                           | It does not recognize a valid AO3 link.                                                    |
| A link to a series, a user page, a collection page…                             | That type of link is not supported yet.                                                    |
| A link, but the download fails                                                  | The cause (for example an AO3 or Cloudflare error).                                        |
| A link, but the Kindle is off or asleep                                         | The fic was downloaded but could not be sent; share it again when the Kindle is awake.     |
| A link, but the SSH key or `scp` is misconfigured                               | A configuration error naming the problem (missing key, open permissions, `scp` not found). |

If a message contains several AO3 links, only the first one is used.

## How it works

1. `ownerOnly` drops every update that is not from the owner, without replying.
2. `extractWorkLink` finds the AO3 URL inside the text (checking the exact hostname) and rebuilds the canonical URL `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` runs `fanficfare` as a subprocess in an empty temporary folder and picks up the single `.epub` it leaves there. FanFicFare itself names and sanitizes the file.
4. `uploadToKindle` checks the SSH key first (the same criterion SSH uses), then runs `scp`.
5. The bot replies, and the temporary folder is always deleted.

A few deliberate choices:

- **Subprocesses use `spawn`, never `exec`**, and everything is async: nothing blocks the event loop.
- **Configuration problems and delivery failures are told apart without reading `scp`'s exit code**: a bad key is detected _before_ launching `scp`, a missing binary by the `error` event, and any other failure is a delivery failure.
- **Messages are processed one at a time**, in arrival order (grammY's long polling). A second link is acknowledged when the first one finishes.
- Error messages show only the last useful line of a subprocess's stderr, never a stack trace. The full detail goes to the log.

## Project layout

```
src/
  index.ts        entrypoint: loads the config, starts long polling
  bot.ts          owner filter + the request flow (orchestration)
  messages.ts     every text sent to the owner, and the error → message mapping
  ao3-link.ts     finds and validates the AO3 work link in a message
  downloader.ts   FanFicFare subprocess wrapper
  uploader.ts     scp subprocess wrapper (+ SSH key check)
  subprocess.ts   helpers shared by the two wrappers
  config.ts       loads and validates ~/.bookcarrier/config.json
  logger.ts       small logger (levels + timestamps)
test/             Vitest tests, one file per module
docs/specs/       the specifications (see below)
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
| 2   | Retry queue + start at login with launchd               | 📝 Specified |
| 3   | Send an ebook or a PDF as a file (EPUB, MOBI, PDF)      | 📝 Specified |
| 4   | “Follow” button and chapter tracking                    | Planned      |
| 5   | Daily check for new chapters                            | Planned      |
| 6   | `/list`, `/drop`, `/status` commands                    | Planned      |

## Known limitations

- There is no queue yet: if the Kindle is unreachable the bot reports it and **does not retry on its own**.
- If the daemon is stopped while a download is running, that request is lost.
- Titles with accents lose them in the file name and in the confirmation message (`Corazón` → `Coraz_n`), because FanFicFare sanitizes file names.
- Only individual AO3 works are supported (no series or collections).
- Files sent to the bot (ebooks, PDFs) are not handled yet: that is feature 3. For now the bot only answers AO3 links.
- The daemon is not started automatically yet; that comes with feature 2.

## A note on AO3

This is a personal tool for your own reading. Please respect [AO3's Terms of Service](https://archiveofourown.org/tos) and don't hammer the site. FanFicFare already backs off on errors, and Bookcarrier sends one request at a time.
