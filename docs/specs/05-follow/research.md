# Research — Feature 5: Follow + chapter tracking

Findings behind the decisions in [requirements.md](./requirements.md).

## 1. Where the chapter count comes from (2026-11-22)

Source: FanFicFare 4.63.0 installed at `/opt/homebrew/Cellar/fanficfare/4.63.0_1`, read directly from its code.

- `fanficfare --help` lists `-j/--json-meta` ("Output metadata as JSON with download") and `--json-meta-file` ("Similar to --json-meta, but output metadata for each download as JSON to an individual file named by appending ".json" to the output_filename").
- `cli.py:587-600`: when either flag is set, after the download it writes `getAllMetadata()` plus `output_filename`, `subject_tags` and, unless `-z/--no-meta-chapters`, the chapter list `zchapters`. `--json-meta` prints it to stdout; `--json-meta-file` writes `<output_filename>.json`.
- `adapters/base_otw_adapter.py:451-462` (the base of the AO3 adapter): `numChapters` is the **published** chapter count, the number before the `/` in AO3's "Chapters: 12/?" or "12/20". `status` is `"Completed"` or `"In-Progress"`.
- Other fields the same metadata carries and the bot already uses or may want: `storyId`, `title`, `author`, `storyUrl`, `dateUpdated`.

Consequence: the chapter count can be read **from the same FanFicFare run that downloads the fic**. No extra request to AO3 is needed. `--json-meta-file` is preferred over `--json-meta` because stdout also carries FanFicFare's progress lines; a separate file next to the EPUB (already in the request's spool directory) is simpler to parse.

Confirmed from the source (2026-11-23), because AO3 kept answering 429 to the planned real run for over half an hour:

- `story.py:1167-1169`: `getMetadata` passes `numWords` and `numChapters` through `commaGroups(str(value))`, so in the JSON `numChapters` is **always a string with thousands separators** (`"12"`, `"1,204"`). The parser still accepts a plain number, in case a future FanFicFare changes it.
- `cli.py:600`: the file is `output_filename + ".json"`. With Bookcarrier's template that is `<storyId>-<title>.epub.json`, next to the EPUB in the request's spool folder.
- A real run is still part of the manual verification (tasks.md), once AO3 stops answering 429.

## 2. AO3 rate limit (2026-11-22)

A single `fanficfare -m -j` probe against AO3 returned `429 Too Many Requests` (`/works/<id>/navigate`). This confirms the project principle (pauses and backoff on 429) and is one more reason why this feature must not add any AO3 request of its own: it only reads metadata from the download that already happens.

_Update 2026-11-23:_ `main` now defers 429'd requests for hours (#7: `QueueItem.deferred`, `deferredRetryMs`, `deferredGiveUpAfterMs`; new links are deferred while any item is deferred). Feature 6's daily check must respect "while any request is deferred, do not hit AO3" (e.g. skip the check until `queue.cooldownUntil()` has passed).

## 3. Reusable code in the repo (2026-11-22)

- Inline buttons and `callback_query`: feature 3's pattern in `src/telegram/bot.ts` (originally `src/bot.ts`, before the DDD layout) (`OVERWRITE_DATA = /^ow:([A-Za-z0-9_-]{8}):(y|n)$/`, `bot.callbackQuery(...)`, `answerCallbackQuery`, `editMessageReplyMarkup`).
- Persistent JSON state: `src/retry-queue/state.ts` (atomic write with `write-file-atomic`, `version` field, corrupt file moved to `<path>.corrupt-<now>`).
- Delivery points where the button attaches: `handle()` (new request) and `retry()` (queue retry) in `src/fanfic/pipeline.ts`, both ending in `messages.delivered(title)`.
- `DownloadResult` (`src/fanfic/downloader.ts`) only returns `{ filePath, title }` today; it has to carry the chapter metadata.

## 4. Whole fic or only the new chapters, and the 429 risk (2026-11-23)

Source: FanFicFare 4.63.0 code (`adapters/base_otw_adapter.py:521-529`, `defaults.ini` `[archiveofourown.org]`) and Bookcarrier's `src/fanfic/downloader.ts`.

- Bookcarrier always downloads the **whole fic**: every run starts in an empty spool directory, so there is no previous EPUB for `--update-epub` to extend. The previous EPUB lives on the Kindle, not on the Mac.
- The AO3 adapter uses `use_view_full_work` (default `true`): for a fic with more than one chapter it fetches all chapters with **one** request to `?view_full_work=true`, instead of one request per chapter. Together with the work page and `/navigate`, a download is about 3 requests, independent of the chapter count.
- `defaults.ini` sets `slow_down_sleep_time:4` (about 4 s between requests to the same site).
- Consequence: downloading only the new chapters would not reduce the number of requests (update mode still reads the metadata and chapter list), and it would require keeping a copy of every followed EPUB on the Mac. The 429 risk depends on **how often** fics are requested, not on their size.
- For feature 6 (daily check): check each followed fic with `--meta-only` (no chapters), download the whole fic only when `numChapters` grew, pause between fics and back off on 429. Feature 5 adds no request (R2.1).
