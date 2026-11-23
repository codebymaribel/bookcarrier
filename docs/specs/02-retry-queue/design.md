# Design — Feature 2: Retry Queue

See [requirements.md](./requirements.md) and [research.md](./research.md).

## State shape

A single JSON file, by default `~/.bookcarrier/queue.json`:

```ts
type Stage = 'download' | 'upload';

type QueueItem = {
  id: string;              // uuid v4, generated on enqueue
  url: string;             // AO3 work URL
  stage: Stage;            // stage it is currently in
  epubPath?: string;       // path in the spool; present only if stage === 'upload'
  title?: string;          // for the delivery message; known after the download
  attempts: number;        // accumulated failed attempts
  firstQueuedAt: number;   // epoch ms — basis for the give-up window
  nextAttemptAt: number;   // epoch ms — when the next attempt is due
  lastError: string;       // last error, for the give-up message
  deferred?: boolean;      // R8: AO3's 429 outlasted the window; retried every few hours
};

type QueueState = {
  version: 1;              // so the format can be migrated later
  items: QueueItem[];
};
```

`deferred` (R8) is optional, so files written before it still parse and older code ignores it; `version` stays `1`.

`version` is there from day one on purpose: when this migrates to SQLite or changes shape, an old file will be recognizable instead of blowing up.

## New modules

```
src/
  queue/
    state.ts        # read/write QueueState atomically
    queue.ts        # add, remove, stage transitions, backoff calculation
    scheduler.ts    # the single timer: computes the next wake-up and fires
    spool.ts        # handling of the EPUB directory and its cleanup
  errors.ts         # transient vs permanent classification
```

### `errors.ts` — this feature's central decision

All of the queue's behavior depends on a single question: **is this error worth retrying?** If we classify wrongly, we either enqueue garbage forever or discard recoverable requests.

```ts
type FailureKind = 'transient' | 'permanent';
```

- **Transient** (enqueued): network timeout, AO3 403/429/5xx, SSH connection timeout, scp exit code for unreachable host.
- **Permanent** (not enqueued, R1.2 and R1.4): the work does not exist, the link is not from AO3, `scp` binary missing from the PATH (`spawn`'s `error` event), SSH key nonexistent or with wrong permissions.

The key distinction in the uploader is the one we already detected in feature 1: `spawn`'s `'error'` event means "the process could not be launched" (permanent, broken config), while a non-zero exit code with the process actually launched means "it was tried and failed" (transient, probably the Kindle). That difference is exactly the border between enqueueing and not enqueueing.

### `state.ts`

- `readState(): Promise<QueueState>` — if the file does not exist, returns `{ version: 1, items: [] }` (R2.4). If it exists but does not parse, renames it to `queue.json.corrupt-<timestamp>`, returns an empty state and signals so the bot notifies (R2.5).
- `writeState(state): Promise<void>` — uses `write-file-atomic` (temp + fsync + rename, see research.md). Calls are serialized within the process with a chained promise, so two concurrent writes do not clobber each other.

### `queue.ts`

- `enqueue(url, stage, error, opts)` → creates the item, computes `nextAttemptAt` with the first backoff step, persists.
- `backoffFor(attempts): number` → returns the delay of the corresponding step of the `[1, 2, 4, 8, 15]` minute ladder. After the last step, the item has already exceeded the window and is abandoned, so there is no ceiling to repeat.
- `shouldGiveUp(item, now): boolean` → `now - item.firstQueuedAt > giveUpAfterMs` (default 30 min).
- `promoteToUpload(item, epubPath, title)` → `download` → `upload` transition (R3.2).
- `remove(id)` → removes the item and persists.

### `scheduler.ts`

A single `setTimeout`, never a `setInterval` (R3.4, R3.5 and the "no unnecessary polling" principle):

1. After any change to the queue, cancel the current timer if there is one.
2. If the queue is empty, schedule nothing and finish.
3. Otherwise, find the minimum `nextAttemptAt` and schedule a `setTimeout` for that instant (clamped to >= 0).
4. When it fires: take **all** due items, process them, and go back to step 1.

When the daemon starts, this same recalculation is called with the restored state, so an item whose `nextAttemptAt` passed while the daemon was down is processed immediately (R2.3).

Implementation note: Node's `setTimeout` has a maximum of ~24.8 days; with a 30-minute window it is not a problem, but if `giveUpAfterMs` is lengthened a lot the delay will have to be clamped and rescheduled.

### `spool.ts`

- Configurable directory, by default `~/.bookcarrier/spool/`. **Not** `/tmp`, which macOS cleans (R5.1).
- `reconcile(items)` at startup: deletes every `*.epub` in the spool not referenced by the `epubPath` of some restored item (R5.3). This cleans up the orphans left by a crash between "I downloaded" and "I persisted".
- `discard(epubPath)` after delivery or give-up (R5.2, R4.2).

## Changes to feature 1 modules

- `downloader.ts`: instead of downloading to a disposable temp, it downloads to the spool. Errors are returned classified with `FailureKind`.
- `uploader.ts`: distinguishes the `'error'` event (permanent) from the exit code (transient) and returns it classified.
- `bot.ts`: on a failure, the orchestrator now consults the classification and decides whether to enqueue or report. Success messages may come from the direct flow or from a retry, so the delivery text is unified in one place.

## launchd

`~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist`, with `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false }`, `ThrottleInterval: 10`, and logs to `~/Library/Logs/Bookcarrier/` (see research.md for the detail and the `launchctl` commands). The plist goes in the repo as a template with placeholder paths, not with the real paths.

## What this design deliberately leaves out

- **No prior reachability check** (a ping or a short ssh before scp). It would add a network request and one more code path to avoid an attempt that fails fast anyway with `ConnectTimeout=10`. Trying and failing is simpler and does not lie about the real state.
- **No queue size limit.** With a 30-minute window, the queue cannot grow much: items go away on their own. If the window is lengthened in the future, this has to be reconsidered.
- **No retries on Telegram notifications.** If `sendMessage` fails, it is logged and we move on. The fic's delivery is what matters; the notification is not.
