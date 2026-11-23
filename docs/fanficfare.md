# How Bookcarrier uses FanFicFare

[FanFicFare](https://github.com/JimmXinu/FanFicFare) is the tool that turns an AO3 link into an EPUB. Bookcarrier does not import it as a library: it runs the `fanficfare` command-line program as a subprocess and picks up the file it leaves behind.

Version checked for this document: **FanFicFare 4.63.0** (Homebrew, `brew install fanficfare`).

## At a glance

| What | Where | Value |
| --- | --- | --- |
| Binary | `src/downloader.ts` `FANFICFARE_BIN` | `fanficfare`, found on the `PATH` |
| Only entry point | `src/downloader.ts` `downloadEpub(url, outDir, opts)` | one subprocess per download |
| Arguments | `downloadEpub` | `<url> -f epub --non-interactive --json-meta-file -o output_filename=${storyId}-${title}${formatext}` |
| Working directory | `cwd` of the subprocess | `outDir`, an empty spool folder for this request |
| Timeout | config `downloadTimeoutMs` | default `600000` (10 min), then `SIGKILL` |
| FanFicFare config files | FanFicFare's own lookup | none of Bookcarrier's; see "Configuration" |

## Who calls it

There is exactly one place that runs FanFicFare: `downloadEpub` in `src/downloader.ts`. Everything else reaches it through the pipeline in `src/bot.ts`, which receives it as the `download` dependency (`PipelineDeps.download`) so tests can replace it with a fake.

```
Telegram message with an AO3 link
  └─ bot.ts  pipeline.handle()          new request
       └─ download(id, link.canonicalUrl)
            └─ spool.prepare(id)        empty folder ~/.bookcarrier/spool/<id>/ (spoolDir)
            └─ downloadEpub(url, dir, { timeoutMs: config.downloadTimeoutMs })

Retry timer (feature 2 queue, item in the "download" stage)
  └─ bot.ts  pipeline.retry()
       └─ download(item.id, item.url)   same helper, same call
```

- The URL is always the **canonical** work URL built by `src/ao3-link.ts` (`https://archiveofourown.org/works/<id>`), never the raw text the owner shared. A chapter link or a collection link is normalized to the work first.
- Other modules only know FanFicFare by name:
  - `src/binaries.ts` checks at startup that `fanficfare` (with `scp` and `ssh`) is on the `PATH`, and logs an error if not. The daemon starts anyway.
  - `src/errors.ts` reads FanFicFare's error output to decide whether a failure is worth retrying.
  - `src/messages.ts` has the owner-facing text for "FanFicFare could not be started".

## The command, argument by argument

```sh
fanficfare https://archiveofourown.org/works/<id> \
  -f epub \
  --non-interactive \
  --json-meta-file \
  -o 'output_filename=${storyId}-${title}${formatext}'
```

| Argument | Why |
| --- | --- |
| `<url>` | The canonical AO3 work URL. |
| `-f epub` | Output format. KOReader on the Kindle reads EPUB. |
| `--non-interactive` | FanFicFare never stops to ask a question (login, adult check). Together with stdin closed (`stdio: ["ignore", …]`), a prompt makes it fail at once instead of hanging until the timeout. |
| `--json-meta-file` | Also writes the fic's metadata as JSON next to the EPUB (see "The metadata file"). It comes from the same run, so it costs no extra request to AO3. |
| `-o output_filename=…` | Overrides one FanFicFare setting for this run. `${storyId}`, `${title}` and `${formatext}` are **FanFicFare's** template variables, not JavaScript ones. That's why the string is in plain quotes in the code. FanFicFare fills them in and makes the name file-system safe itself. Result: `12345678-My_Fic_Title.epub`. |

## How the subprocess is run

All of this is in `downloadEpub`:

- **Async, never blocking.** `child_process.spawn`, wrapped in a promise. The bot keeps handling other messages while a download runs.
- **Working directory = `outDir`.** It is an empty folder exclusive to this request (`src/queue/spool.ts`), so FanFicFare's EPUB is the only one there. Bookcarrier does not try to predict the file name. After the run it lists the folder and takes the single `.epub`.
- **Both output pipes are read.** stdout is read and thrown away. For stderr, only the last part is kept, for the logs. Reading both prevents the child from blocking on a full pipe.
- **Timeout.** After `downloadTimeoutMs` the process gets `SIGKILL`, and the download fails with reason `timeout`.
- **Result.** `{ filePath, title, meta? }` (`meta` is described below, `metaWarning` carries the reason when it is missing). The title comes from the file name minus the `<storyId>-` prefix and the extension. FanFicFare has already sanitized it, so accents become `_` (`Corazón` → `Coraz_n`), a known limitation listed in the README.

## Outcomes and how they are classified

| What happened | Error | Classified as (`src/errors.ts`) | Effect |
| --- | --- | --- | --- |
| `spawn` fails (`ENOENT`: not installed or not on `PATH`) | `DownloadLaunchError` | permanent | reported to the owner at once, never queued |
| Exit code ≠ 0, stderr says the work does not exist (`StoryDoesNotExist`, `(404)`, `HTTP Error 404`) | `DownloadFailedError("exit-code")` | permanent | reported, never queued |
| Any other exit code ≠ 0 (AO3 down, 403, **429**, network) | `DownloadFailedError("exit-code")` | transient | queued, retried with backoff (feature 2) |
| Timeout | `DownloadFailedError("timeout")` | transient | queued |
| Exit 0 but no EPUB, an empty EPUB, or more than one | `DownloadFailedError("no-file" / "multiple-files")` | permanent | reported, never queued |

stderr (often a Python traceback) goes to the log only, never to the owner, so the owner never sees raw tracebacks.

## Configuration

**Bookcarrier ships no FanFicFare config file.** The only setting it changes is `output_filename`, through `-o` on each run.

FanFicFare still reads its own config files, in this order. Later ones override earlier ones:

1. its built-in `defaults.ini` (inside the installed package);
2. `~/.fanficfare/defaults.ini`, `$XDG_CONFIG_HOME/fanficfare/defaults.ini`, `./defaults.ini`;
3. `~/.fanficfare/personal.ini`, `$XDG_CONFIG_HOME/fanficfare/personal.ini`, `./personal.ini`;
4. options given with `-o` (highest priority).

Consequences:

- `./` is the request's empty spool folder, so a `personal.ini` in the repo or in the daemon's directory is **never** read.
- To change FanFicFare's behavior for Bookcarrier (for example to log in to AO3 for works restricted to registered users), create `~/.fanficfare/personal.ini` in the home of the user that runs the daemon. Under launchd that's your user, since it is a LaunchAgent.
- `--non-interactive` means a login or adult-content prompt cannot be answered at run time. FanFicFare prints that it needs `username`/`password` or `is_adult:true` in `personal.ini` and exits with an error.

Built-in AO3 defaults that matter for Bookcarrier (`[archiveofourown.org]` in FanFicFare's `defaults.ini`):

- `use_view_full_work: true` (default): all chapters are fetched in **one** request to `?view_full_work=true`, not one request per chapter. Together with the work page and `/navigate`, a download is about 3 requests to AO3, whatever the chapter count.
- `slow_down_sleep_time: 4`: FanFicFare waits about 4 s between requests to the same site.

## launchd and the `PATH`

launchd gives its jobs almost no `PATH`. The LaunchAgent template (`launchd/com.codebymaribel.bookcarrier.plist`) sets `EnvironmentVariables.PATH` to include Homebrew's prefix. Without it, `fanficfare` is not found and every download fails with `DownloadLaunchError`. The startup check in `src/binaries.ts` logs this case.

## AO3 rate limiting (429)

AO3 answers `429 Too Many Requests` when it is hit too often. FanFicFare then exits with an error. Bookcarrier classifies that as transient and retries later with backoff (feature 2). It never retries immediately. Bookcarrier only runs FanFicFare when the owner sends a link or the queue retries one, so the request rate stays low. See [docs/specs/05-follow/research.md](specs/05-follow/research.md) §2 and §4.

## The metadata file

With `--json-meta-file`, FanFicFare writes `<output_filename>.json` in the same folder as the EPUB, for example `12345678-My_Fic_Title.epub.json`. After finding the EPUB, `downloadEpub` reads `<filePath>.json` (when it knows the work id) and passes it to `parseFicMeta` (`src/fic-meta.ts`). Two fields matter:

- `numChapters`: the published chapter count. FanFicFare writes it as a **string grouped with commas** (`"12"`, `"1,204"`), so the parser accepts a number or a string, strips the separators, and requires a positive integer.
- `status`: `Completed` or `In-Progress`. Anything else is treated as unknown.

The work id and URL come from the AO3 link Bookcarrier already parsed, not from the JSON. The `.json` file does not trip the single-`.epub` check, because `findEpub` only looks at `.epub` files.

The file is never fatal. If it is missing, unreadable, invalid JSON or has no valid `numChapters`, the download still succeeds and `DownloadResult.meta` is left empty. The bot logs a warning with the work id (`no chapter metadata for work <id>: <reason>`), delivers the fic as usual and sends the delivery message **without** the Follow button. See [feature 5's design](specs/05-follow/design.md).

## Testing

Tests never run the real `fanficfare` and never touch AO3:

- the pipeline tests inject a fake `download` through `PipelineDeps`;
- the downloader's own tests check the arguments, the spool-folder handling, the timeout and the error cases with a stand-in process.
