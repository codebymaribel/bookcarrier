# Tasks — Feature 5: Follow + chapter tracking

Each task ships with its test (Vitest). See [design.md](./design.md) and [requirements.md](./requirements.md).

Prerequisites:

- Features 3 and 4 are merged into `main` (done: `40a3fde`).
- Port (2026-11-23): `main` b937c9d has the 429 deferral (#7) and the DDD layout (#8/#9). This list is the port onto branch `feature/05-follow-v2`; the old branch `feature/05-follow` (eba3ef3) is the reference for code and tests. All checkboxes are reset. Tests are colocated as `src/<ctx>/x.test.ts`; cross-context imports go through `index.ts`.
- ~~One real `--json-meta-file` run before T1~~: replaced by reading FanFicFare's source (research §1, 2026-11-23), because AO3 answered 429 for over half an hour. `numChapters` is a string with thousands separators; the file is `<epub name>.json`. The real run moves to the manual verification.

The order follows the dependencies: pure helpers first, then the stores, then the downloader and the queue, then the orchestration, and the wiring and docs last.

## Tasks

- [x] **T1 — `src/fanfic/fic-meta.ts`: `FicMeta` and `parseFicMeta`** (test `src/fanfic/fic-meta.test.ts`). Pure, no I/O; exported via `src/fanfic/index.ts`.
  - Test: `numChapters` `12`, `"12"` and `"1,204"` → `12`, `12`, `1204` (R2.2).
  - Test: `numChapters` `0`, `-3`, `"abc"`, `1.5`, missing, and a non-object input → `undefined` (R2.2, R2.3).
  - Test: `status` `"Completed"` → `completed`, `"In-Progress"` → `in-progress`, `"Abandoned"` or missing → `unknown` (R2.4).
  - Test: `workId` and `url` come from the arguments, not from the JSON (even when the JSON has a different `storyId`).
  - Test: missing `title`/`author` → the fallback title and `""`.

- [x] **T2 — `src/shared/json-file.ts`: extract the atomic JSON store from `src/retry-queue/state.ts`.** No behavior change for the queue.
  - `createJsonFileStore<T>(path, parse, empty, now)`; `src/retry-queue/state.ts` keeps its exported interface and wraps it.
  - Test (`src/shared/json-file.test.ts`): write then read returns the same state; a missing file → `empty()` with no backup; invalid JSON, wrong `version` or `parse` returning `undefined` → the file is moved to `<path>.corrupt-<now>`, `corruptBackup` is returned and the state is `empty()` (R5.2).
  - Test: a write that fails leaves the previous file intact (atomic write).
  - Test: **every existing `src/retry-queue/state.test.ts` test passes unchanged** (regression guard for the extraction).

- [ ] **T3 — `src/follows/follows.ts` (new context `src/follows/`, with `index.ts`): state, `onDelivered`, `follow`, `unfollow`** (test `src/follows/follows.test.ts`). Uses T1 and T2, with a store in a temp directory.
  - Test, one per row of design.md's `onDelivered` table: no meta → `none` and nothing written; followed + `completed` → `completed` and removed (R6.4); followed + in-progress or unknown → `updated` with the new chapters, status, title and `updatedAt` (R6.1); not followed + in-progress → `offer` and added to `recent` (R3.1); not followed + completed or unknown → `none` (R3.1a).
  - Test: `recent` keeps the 10 most recent work ids; the 11th drops the oldest; re-delivering a fic that is already in `recent` moves it to the front without duplicating it (R3.5).
  - Test: a followed fic is never dropped by the 10-entry limit (R3.5).
  - Test: `follow` → `followed` (moved from `recent`) / `already` / `unknown` (R3.3, R3.4, R3.6); `unfollow` → `unfollowed` with the title / `not-followed` (R4.1, R4.2).
  - Test: a new `createFollows` over the same file sees the followed fics and `recent` (restart, R5.3, acceptance criteria 8 and 15).
  - Test: when `store.write` rejects, the call rejects and the in-memory state is unchanged.
  - Test: two calls started together (`onDelivered` and `follow` without awaiting the first) are applied in order, and the file holds both effects (serialized writes).

- [ ] **T4 — `src/shared/config.ts`: `followsPath`** (test `src/shared/config.test.ts`).
  - Test: absent → `~/.bookcarrier/follows.json` expanded (R7.1); `~/x.json` → expanded; empty string or a non-string → `ConfigError` naming `followsPath`, together with other fields' problems (R7.2).
  - Test: the existing config tests pass unchanged.

- [ ] **T5 — `src/fanfic/downloader.ts`: `--json-meta-file` and `meta`** (test `src/fanfic/downloader.test.ts`). `spawn` mocked, as today.
  - `downloadEpub` receives the parsed link (work id and canonical URL); `DownloadResult` gains `meta?: FicMeta`.
  - Test: the arguments are exactly the current ones plus `--json-meta-file`.
  - Test: the fake run writes the EPUB and a valid `<epub>.json` → `meta` is set (R2.1).
  - Test: no `.json`, invalid JSON, or invalid `numChapters` → the download still resolves with `filePath` and `title`, `meta` is `undefined`, and a warning naming the work id is logged (R2.3, acceptance criterion 6).
  - Test: the `.json` file does not count as an extra EPUB (one `.epub` + one `.json` → success).
  - Test: every existing downloader error test passes unchanged.

- [ ] **T6 — `src/retry-queue/`: keep `meta` on the item** (tests in `queue.test.ts` and `state.test.ts`).
  - `QueueItem.meta?: FicMeta`; `promoteToUpload` stores it.
  - Test: an item promoted with `meta` survives a write and a read with the same `meta` (R2.5).
  - Test: a queue file written before this feature (items without `meta`) loads, with `meta` undefined and no corrupt backup (R2.6).
  - Test: an item with an invalid `meta` loads, with `meta` dropped and the item kept.
  - Test: an item carrying both `deferred: true` and `meta` survives a write and a read with both intact; a deferred item enqueued straight away (cooldown) has no `meta`, and `promoteToUpload` on a deferred item sets `meta` while keeping `deferred` (#7).

- [ ] **T7 — messages + keyboards.**
  - New messages from design.md, plain text, per context: `src/follows/messages.ts` (follows texts) and `src/fanfic/messages.ts` (delivery texts); `followKeyboard(workId)`, `unfollowKeyboard(workId)`, `FOLLOW_DATA` in `src/telegram/` (tests colocated: `src/follows/messages.test.ts`, `src/telegram/bot.follow.test.ts`).
  - Test: `callback_data` is `fo:<workId>` / `uf:<workId>`, at most 64 bytes for a 12-digit id; `FOLLOW_DATA` matches both and rejects `fo:abc`, `fo:`, `xx:123` (R3.2, R4.3).
  - Test: `nowFollowing("T", 12)` mentions 12 chapters; a title with `_`, `*` and `[` is kept literally (R8.1).

- [ ] **T8 — `src/fanfic/pipeline.ts` + `src/telegram/bot.ts`: delivery messages with buttons.** Tests in `src/fanfic/pipeline.test.ts` (fakes as in the existing pipeline tests) and `src/telegram/bot.follow.test.ts`; `follows` faked.
  - `PipelineDeps.follows`; `Send` takes an optional abstract `DeliveryAction` (`{ action: "follow" | "unfollow"; workId } | undefined`), no grammY in `src/fanfic`; `src/telegram/bot.ts` translates it into the `InlineKeyboard`; `handle()` and `retry()` call `onDelivered` after a successful upload.
  - Test: outcome `offer` → delivery message with action `follow` (Telegram translates it to the Follow keyboard) (acceptance criterion 1); `none` → without keyboard (criteria 3, 6); `updated` → `deliveredFollowUpdated` with action `unfollow` (Unfollow keyboard) (criterion 5); `completed` → `deliveredCompletedUnfollowed` without keyboard (criterion 13).
  - Test: a retry delivery of an item with `meta` passes it to `onDelivered` and offers Follow (criterion 7); a retry of an item without `meta` passes `undefined`.
  - Test: `onDelivered` rejecting → the delivery message is still sent, without keyboard, and the error is logged.
  - Test: a failed upload never calls `onDelivered`.
  - Test: the download fake is called exactly once per delivery; following or updating triggers no other download (criterion 12).
  - Test: the existing pipeline tests pass, adjusted only for the new dependency.
  - Test: a deferred item (`deferred: true`) whose download succeeds on a retry delivers with its `meta` and offers Follow.

- [ ] **T9 — `src/telegram/bot.ts`: Follow and Unfollow taps** (test `src/telegram/bot.follow.test.ts`).
  - `bot.callbackQuery(FOLLOW_DATA, …)` registered before the generic `callback_query` fallback.
  - Test: `fo:<id>` → `answerCallbackQuery`, `follow(id)`; `followed`/`already` → the markup becomes the Unfollow keyboard and the matching reply is sent (criterion 2); `unknown` → the markup is removed and `followUnknown()` is replied (criterion 14).
  - Test: `uf:<id>` → `unfollow(id)`; `unfollowed` → the markup is removed and `unfollowed(title)` is replied (criterion 4); `not-followed` → `notFollowing()`.
  - Test: `follow` rejecting → `followSaveFailed()` is replied and the markup is not changed.
  - Test: `answerCallbackQuery` or `editMessageReplyMarkup` failing → warning logged, the reply is still sent.
  - Test: a tap from a non-owner → nothing called, no reply (criterion 10).
  - Test: the feature 3 `ow:` buttons still work, and a document delivery has no Follow button (criterion 11).

- [ ] **T10 — Startup wiring (`src/app/daemon.ts` / `src/index.ts`)** (test `src/app/daemon.test.ts`).
  - Read `follows.json` at startup, create `Follows`, pass it to the pipeline and the bot.
  - Test: a corrupt `follows.json` → the daemon starts, the error log names the backup path, and the state is empty (criterion 9).
  - Test: a valid file → the followed fics are available to the first tap after startup.

- [ ] **T11 — Documentation.** No unit test.
  - `config.example.json`: `followsPath` with its default (R7.3).
  - `README.md` and `README.es.md`: config table row for `followsPath`; "Using it" rows (Follow, Unfollow, re-sending a followed fic, a complete fic has no button, auto-unfollow when completed, old Follow button → send it again); a "How it works" step for the chapter metadata; roadmap renumbered (5 = Follow, 6 = daily check, 7 = commands).
  - `docs/fanficfare.md`: update the file paths to the DDD layout (`src/fanfic/downloader.ts`, etc.); move `--json-meta-file` from "Planned change" into the command and arguments sections; replace its 429 description with the deferral behavior (#7: after the retry ladder a 429'd item is deferred for hours, new links are deferred while any item is deferred).
  - `docs/specs/01`–`03` "Out of scope": update the feature numbers they cite (Follow → 5, daily check → 6, commands → 7).

## Manual verification (before closing the feature)

- [ ] One real run in an empty folder: `fanficfare <in-progress work URL> -f epub --non-interactive --json-meta-file` leaves `<storyId>-<title>.epub.json` with `numChapters` as a string (research §1). Once; on a 429, wait.
- [ ] Send an **in-progress** fic: the delivery message has "Follow"; tap it: the reply states the chapter count, which matches AO3's "Chapters: N/…", and the button becomes "Unfollow" (acceptance criteria 1, 2).
- [ ] Open `follows.json`: the fic is under `followed` with its work id, title, author, chapters, `in-progress` status and dates.
- [ ] Send a **complete** fic: no button (acceptance criterion 3).
- [ ] Restart the daemon (`bookcarrierctl restart`), then tap "Follow" on a fic delivered before the restart: it is followed (acceptance criterion 15).
- [ ] Send the link of the followed fic again: the message says the follow was updated and shows "Unfollow" (acceptance criterion 5).
- [ ] Tap "Unfollow": the button disappears and the fic is gone from `follows.json` (acceptance criterion 4).
- [ ] With the Kindle asleep, send an in-progress fic; wake the Kindle: the retry delivery offers "Follow" (acceptance criterion 7).
- [ ] Send a document (feature 3): no Follow button (acceptance criterion 11).
- [ ] Corrupt `follows.json` by hand and restart: the daemon starts, `follows.json.corrupt-<ts>` exists and the log names it (acceptance criterion 9).
- [ ] Check the log during all of the above: each delivery shows one FanFicFare run and no other AO3 activity (acceptance criterion 12).
