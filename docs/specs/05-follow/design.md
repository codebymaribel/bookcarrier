# Design — Feature 5: Follow + chapter tracking

Implements [requirements.md](./requirements.md); findings in [research.md](./research.md).

> **Status: approved by the owner on 2026-11-23.**
>
> _Changed 2026-11-23 (after the first approval): `main` gained the 429 deferral (#7) and the DDD layout (#8/#9), so feature 5 is ported onto branch `feature/05-follow-v2` (cut from `main` b937c9d). Owner decisions (odd/tasks/05-follow.md L23): follows becomes a new bounded context `src/follows/`; the pipeline hands Telegram an abstract delivery action instead of a grammY keyboard; module paths, messages and the interaction with the deferral are updated below. Behavior and requirements are unchanged._

## Decisions from the research

- **Metadata from the same run:** `fanficfare` gets `--json-meta-file`, which writes `<output_filename>.json` next to the EPUB in the request's spool directory (research §1). No extra AO3 request (R2.1).
- **Lenient parsing:** `numChapters` may arrive as a number or as a string (possibly with thousands separators); the parser accepts both and requires a positive integer (R2.2).
- **The JSON file is never fatal:** a missing or broken JSON only removes the Follow button (R2.3). The download keeps being judged only by the EPUB, as today.
- **One file for follows:** `follows.json` holds both the followed fics and the last 10 delivered fics that offered Follow (R3.5), so a single atomic write keeps them consistent.

## Flow

```
AO3 link ──► download (fanficfare … --json-meta-file)
               │  EPUB + <name>.epub.json in the spool dir
               ▼
         parseFicMeta(json) ──► FicMeta | undefined
               │
     upload OK? ── no ──► queue item keeps meta (R2.5) ──► retry() later
               │ yes
               ▼
     follows.onDelivered(meta) ──► DeliveryOutcome
               │
               ├─ "offer"     → "Delivered …"                        [Follow]
               ├─ "updated"   → "Delivered … follow updated, N chapters" [Unfollow]
               ├─ "completed" → "Delivered … complete, no longer followed"
               └─ "none"      → "Delivered …" (no meta, Completed or unknown status)

Tap fo:<workId> ──► follows.follow(workId) ──► Followed | AlreadyFollowed | Unknown
Tap uf:<workId> ──► follows.unfollow(workId) ──► Unfollowed | NotFollowed
```

## Layout (DDD)

One folder per bounded context under `src/`; code outside a context imports only from its `index.ts` (cross-context only via `index.ts`); tests are colocated as `src/<ctx>/x.test.ts`.

| Piece | Context / path |
| --- | --- |
| `follows.ts` (store and rules), `messages.ts` (follows texts), `index.ts` | `src/follows/` (new context) |
| `fic-meta.ts` (`FicMeta`, `parseFicMeta`) | `src/fanfic/` |
| `downloader.ts`, `pipeline.ts` (delivery, `Send`, delivery action) | `src/fanfic/` |
| `json-file.ts` (atomic JSON store) | `src/shared/` |
| `QueueItem.meta`, `queue.ts`, `state.ts` | `src/retry-queue/` |
| `followsPath` | `src/shared/config.ts` |
| Follow/Unfollow buttons, `fo:`/`uf:` taps, translation of the delivery action | `src/telegram/bot.ts` |
| Startup: read `follows.json`, create `Follows`, wire pipeline and bot | `src/app/daemon.ts` |

`src/fanfic` never imports grammY: the pipeline passes Telegram an abstract delivery action and `src/telegram/` translates it into the `InlineKeyboard`. `fanfic` and `telegram` use `follows` only through `src/follows/index.ts`; `fic-meta` types used by `follows` and `retry-queue` are exported through `src/fanfic/index.ts`.

## Modules

### `src/fanfic/fic-meta.ts` (new, pure)

```ts
export type FicStatus = "in-progress" | "completed" | "unknown";
export type FicMeta = {
  workId: string;     // AO3 work id, digits only
  url: string;        // canonical work URL
  title: string;
  author: string;
  chapters: number;   // published chapters, positive integer
  status: FicStatus;
};
export type FicLink = { workId: string; url: string; fallbackTitle: string };
export function parseFicMeta(raw: unknown, link: FicLink): FicMeta | undefined;
```

- `workId` and `url` come from the AO3 link the bot already parsed (`src/fanfic/ao3-link.ts`), not from the JSON, so the follow key is the same one the bot uses everywhere.
- `status`: `"Completed"` → `completed`, `"In-Progress"` → `in-progress`, anything else → `unknown` (R2.4).
- `title`/`author` fall back to the downloader's title and to `""` when missing; only `numChapters` is mandatory.

### `src/fanfic/downloader.ts`

- Adds `--json-meta-file` to the FanFicFare arguments.
- `DownloadResult` becomes `{ filePath: string; title: string; meta?: FicMeta }`.
- After finding the EPUB, reads `<filePath>.json`. Any failure (missing, unreadable, invalid JSON, invalid `numChapters`) logs a warning with the work id and leaves `meta` undefined (R2.3). `findEpub` already filters `.epub`, so the extra `.json` file does not trip the "multiple files" check.
- `DownloadOptions` gains `workId?: string` (the `url` argument is already canonical); without it the `.json` is not read. The downloader has no logger, so a metadata problem is returned as `DownloadResult.metaWarning` (`no chapter metadata for work <id>: <reason>`) and `src/fanfic/pipeline.ts` logs it with the work id. On a queue retry the work id is derived from the item's canonical URL.

### `src/retry-queue/queue.ts`, `src/retry-queue/state.ts`

- `QueueItem` gains an optional `meta?: FicMeta`, set by `enqueue` (download succeeded, upload failed on a new request) and by `promoteToUpload` (download succeeded on a retry) (R2.5).
- `meta` coexists with the optional `deferred` flag from the 429 deferral (#7): an item can carry both (see "Interaction with the rate-limit deferral").
- Validation accepts items with or without `meta`, and an invalid `meta` is dropped (the item is kept), so old queue files load unchanged (R2.6). No version bump: the field is optional.

### `src/shared/json-file.ts` (new, extracted)

The atomic read/write with version check and corrupt-file backup that `queue/state.ts` implements today, extracted (into `src/shared/`, exported through its `index.ts`) so that both the queue and the follows file use one implementation (R5.2):

```ts
export type JsonFileStore<T> = {
  read(): Promise<{ state: T; corruptBackup?: string }>;
  write(state: T): Promise<void>;
};
export function createJsonFileStore<T>(
  path: string,
  parse: (raw: unknown) => T | undefined,   // undefined → treated as corrupt
  empty: () => T,
  now?: () => number,
): JsonFileStore<T>;
```

`src/retry-queue/state.ts` keeps its public interface and becomes a thin wrapper. **This touches shared code:** the existing queue state tests must keep passing unchanged, and they pin the queue's behavior through the refactor.

### `src/follows/follows.ts` (new context)

```ts
export type FollowedFic = FicMeta & { followedAt: number; updatedAt: number };
export type FollowsState = { version: 1; followed: FollowedFic[]; recent: FicMeta[] };

export type DeliveryOutcome =
  | { kind: "offer" }
  | { kind: "updated"; chapters: number }
  | { kind: "completed" }
  | { kind: "none" };

export type FollowResult = { kind: "followed" | "already"; fic: FollowedFic } | { kind: "unknown" };
export type UnfollowResult = { kind: "unfollowed"; title: string } | { kind: "not-followed" };

export type Follows = {
  onDelivered(meta: FicMeta | undefined): Promise<DeliveryOutcome>;
  follow(workId: string): Promise<FollowResult>;
  unfollow(workId: string): Promise<UnfollowResult>;
};
export function createFollows(store: JsonFileStore<FollowsState>, initial: FollowsState, now?: () => number): Follows;
```

`onDelivered` rules, in order:

| meta | followed? | status | effect | outcome |
| --- | --- | --- | --- | --- |
| undefined | any | — | nothing (R2.3, R6.3) | `none` |
| valid | yes | completed | remove follow (R6.4) | `completed` |
| valid | yes | in-progress / unknown | update chapters, status, title, `updatedAt` (R6.1, R6.4) | `updated` |
| valid | no | in-progress | put in `recent` as most recent, drop beyond 10 (R3.5) | `offer` |
| valid | no | completed / unknown | nothing (R3.1a) | `none` |

- `follow(workId)`: already followed → `already` (R3.4); in `recent` → move it to `followed` → `followed` (R3.3); otherwise `unknown` (R3.6).
- `unfollow(workId)`: removes it from `followed` → `unfollowed`; otherwise `not-followed` (R4.2).
- **Serialized writes.** Handlers run one at a time, but `retry()` runs from the scheduler's timer and can interleave with a button tap. Every mutation goes through one internal promise chain, so writes never overlap and each one starts from the latest in-memory state.
- The in-memory state changes only after the write succeeds. If a write fails, the error goes up to the caller (see "Error handling").

### `src/shared/config.ts`

- New optional `followsPath`, default `join(homedir(), ".bookcarrier", "follows.json")`, validated and `~`-expanded exactly like `queuePath` (R7.1, R7.2).

### `src/app/daemon.ts` / `src/index.ts`

- At startup, the follows file is read next to the queue state. A `corruptBackup` is logged as an error naming the backup path (R5.2, criterion 9) and, like the queue's, the owner is told (`followsMessages.followsFileCorrupt`, in `src/follows/messages.ts`) once polling starts. The daemon starts in both cases.
- `createBot` takes `follows` as an optional last parameter; `index.ts` always passes it. Without it, `fo:`/`uf:` taps fall through to the generic answer.
- `createFollows` is passed to the pipeline and to the bot.

### `src/fanfic/pipeline.ts` and `src/telegram/bot.ts`

- `PipelineDeps` gains `follows: Pick<Follows, "onDelivered">`.
- `handle()` and `retry()`, after a successful upload, call `follows.onDelivered(result.meta)` and send the delivery message with the delivery action that matches the outcome. `Send` becomes `(text: string, action?: DeliveryAction) => Promise<unknown>` with `type DeliveryAction = { action: "follow" | "unfollow"; workId: string } | undefined` (exported from `src/fanfic/index.ts`). `offer` → `{ action: "follow", workId }`; `updated` → `{ action: "unfollow", workId }`; `completed` and `none` → `undefined`.
- **Translation lives in `src/telegram/`**: the `Send` that `bot.ts` gives the pipeline (and the owner notifier used by `retry()`) turns the action into `reply_markup`. `followKeyboard(workId)` → "Follow" with `fo:<workId>`; `unfollowKeyboard(workId)` → "Unfollow" with `uf:<workId>`. `FOLLOW_DATA = /^(fo|uf):(\d{1,12})$/`. That's at most 15 bytes (R3.2, R4.3). grammY stays inside `src/telegram/`.
- `bot.callbackQuery(FOLLOW_DATA, …)`, registered before the generic `callback_query` fallback, same shape as feature 3:
  1. `answerCallbackQuery()` (warn on failure).
  2. `fo` → `follow`: `followed`/`already` → `editMessageReplyMarkup({ reply_markup: unfollowKeyboard })` + reply; `unknown` → remove the markup + reply "send it again".
  3. `uf` → `unfollow`: remove the markup + reply.
- `ownerOnly` already runs before every handler (R1.1).

### Messages (per context)

Plain-text messages (R8.1); each context owns its texts. Follows messages live in `src/follows/messages.ts`, exported as `followsMessages` through `src/follows/index.ts`; the pipeline's delivery texts stay in `src/fanfic/messages.ts` (`deliveredFollowUpdated`, `deliveredCompletedUnfollowed` are delivery texts and live there). The wording is fixed in implementation, and tests compare against these functions:

- `src/fanfic/messages.ts`: `deliveredFollowUpdated(title, chapters)` (delivered, follow updated, now N chapters); `deliveredCompletedUnfollowed(title)` (delivered; complete on AO3 and no longer followed).
- `src/follows/messages.ts`: `nowFollowing(title, chapters)` ("Following “Title” — N chapters delivered."), `alreadyFollowing(title)`, `unfollowed(title)`, `notFollowing()`, `followUnknown()` (send the link again), `followSaveFailed()` (the follow could not be saved; try the button again), `followsFileCorrupt(backupPath)`.

## Interaction with the rate-limit deferral (#7)

`main` defers AO3 429s for hours (`QueueItem.deferred`, `deferredRetryMs`, `deferredGiveUpAfterMs`; while any item is deferred, a new link is deferred straight away; see odd/tasks/ao3-rate-limit-deferral.md and docs/specs/02-retry-queue).

- A **deferred item whose download finally succeeds on a retry** goes through `promoteToUpload` and stores `meta`, like any retry. When its upload succeeds, `onDelivered(meta)` runs and Follow is still offered on that delayed delivery (R2.5), subject to the 10-delivery window of `recent` (R3.5).
- A **link deferred straight away** (during the AO3 cooldown) enters the queue **without meta**: nothing was downloaded yet. Its meta is set later by `promoteToUpload` if the download succeeds on a retry.
- `QueueItem` therefore carries both optional `deferred` and `meta`; they are independent. Validation, the state file and the spool handle any combination, and an item without `meta` delivers with `onDelivered(undefined)` → `none`.
- Feature 5 adds no AO3 request, so it does not touch the cooldown logic.

## Error handling, summarized

| Failure | Effect |
| --- | --- |
| No `.json`, invalid JSON, invalid `numChapters` | Warning logged with work id; delivery as before, no button (R2.3) |
| `follows.json` corrupt at startup | Moved to `.corrupt-<ts>`, error logged, empty state, daemon starts (R5.2) |
| Write fails in `onDelivered` | Error logged; the delivery message is still sent, without a button. The fic **was** delivered, and the follow state is left unchanged |
| Write fails in `follow`/`unfollow` | Error logged; reply `followSaveFailed()`; buttons left as they were so the owner can tap again |
| `answerCallbackQuery` / `editMessageReplyMarkup` fails | Warning logged, flow continues (as in feature 3) |
| Tap from a non-owner | Dropped by `ownerOnly`, no reply (R1.1) |

## Testing approach

- `src/fanfic/fic-meta.test.ts`: number and string `numChapters` (`12`, `"12"`, `"1,204"`), zero, negative, non-numeric, missing; the three status mappings.
- `src/shared/json-file.test.ts`: atomic write, version mismatch and corrupt input → backup + empty. The existing `src/retry-queue/state.test.ts` tests run unchanged as the regression guard for the extraction.
- `src/follows/follows.test.ts`: every row of the `onDelivered` table; the 10-entry limit and most-recent order in `recent`; re-delivery replaces the `recent` record; `follow`/`unfollow` results; state survives a new `createFollows` over the same file (restart, criterion 15); a failed write leaves memory unchanged; concurrent calls are serialized.
- `src/fanfic/downloader.test.ts`: arguments include `--json-meta-file`; with a fake run that writes the JSON → `meta` set; without it, or broken → `meta` undefined plus a warning, and the download still succeeds.
- `src/retry-queue/*.test.ts`: an item with `meta` round-trips; an item with both `deferred` and `meta` round-trips and keeps both; a pre-feature item without `meta` loads and is delivered.
- `src/fanfic/pipeline.test.ts` (delivery actions per outcome, retry and deferred-retry deliveries, onDelivered failures) and `src/telegram/bot.follow.test.ts` (fakes as in `bot.document.test.ts`; translation of the action into keyboards, taps): delivery message keyboards per outcome (criteria 1, 3, 5, 6, 13); retry delivery offers Follow (7); Follow and Unfollow taps (2, 4, 14); non-owner tap ignored (10); documents never get a button (11); no extra download call on follow or update (12).
- `src/shared/config.test.ts`: `followsPath` default, `~` expansion, invalid value refuses to start.

## What this design deliberately leaves out

- Any request to AO3 outside the download (feature 6 adds `--meta-only` checks).
- Keeping EPUB copies on the Mac for `--update-epub` (research §4: it would not reduce requests).
- Listing or managing followed fics from Telegram (feature 7).
- Migrating `follows.json` to SQLite (only if it grows; principles).
