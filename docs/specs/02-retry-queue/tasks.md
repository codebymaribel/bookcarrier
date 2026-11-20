# Tasks — Feature 2: Retry Queue

Each task ships with its test (Vitest). See [design.md](./design.md).

Prerequisite: feature 1 closed and verified by hand.

## Tasks

- [x] **T1 — `errors.ts`: transient vs permanent classification.** It is the basis of everything else, so it goes first.
  - Test: network timeout → `transient`; AO3 429 and 403 → `transient`; nonexistent work → `permanent`; `spawn` `'error'` event (missing binary) → `permanent`; scp non-zero exit code with the process launched → `transient`.

- [x] **T2 — `state.ts`: atomic state reading and writing.**
  - Test: missing file → empty state with no error (R2.4); valid JSON → parsed; corrupt JSON → renames to `.corrupt-<ts>`, returns empty and signals (R2.5); two concurrent `writeState` calls → the final file is valid JSON and contains the last write (R2.2).
  - Test: after a `writeState`, no temporary file is left in the directory.

- [x] **T3 — `queue.ts`: adds, removals and backoff.**
  - `backoffFor` test: returns 1, 2, 4, 8, 15 minutes for attempts 0..4.
  - `shouldGiveUp` test: false at 29 min, true at 31 min (R4.1).
  - Test: `enqueue` persists and assigns consistent `firstQueuedAt` and `nextAttemptAt`.
  - Test: `promoteToUpload` changes the stage keeping `firstQueuedAt` — the give-up window does **not** reset on promotion (otherwise an item could live longer than 30 min).

- [x] **T4 — `spool.ts`: spool and reconciliation.**
  - Test: `reconcile` deletes orphan `.epub` files and keeps the referenced ones (R5.3); `discard` deletes the indicated file and does not fail if it is already gone.

- [x] **T5 — `scheduler.ts`: the single timer.** With Vitest fake timers (`vi.useFakeTimers`).
  - Test: with an empty queue, there is no active timer (R3.5).
  - Test: with two items, a single timer is scheduled, at the earliest `nextAttemptAt` (R3.4).
  - Test: when it fires, it processes **all** due items, not just the first.
  - Test: an item with `nextAttemptAt` in the past (the daemon was down) is processed immediately on recalculation (R2.3).
  - Test: after each change to the queue, the previous timer is cancelled (timers do not pile up).

- [x] **T6 — Integrate into `downloader.ts`: download to the spool and classify errors.**
  - Test: a successful download leaves the EPUB in the spool, not in a temp; a failure returns the classified error.

- [x] **T7 — Integrate into `uploader.ts`: classify the failure.**
  - Test: `'error'` event → `permanent`; non-zero exit code → `transient`.

- [x] **T8 — Orchestration in `bot.ts`: enqueue, deliver, give up and notify.**
  - Test: transient download failure → enqueued with stage `download` and notified once (R1.1, R6.1).
  - Test: permanent download failure → **not** enqueued and the error is reported (R1.2).
  - Test: transient upload failure → enqueued with stage `upload` keeping the EPUB (R1.3).
  - Test: permanent upload failure (broken config) → **not** enqueued (R1.4).
  - Test: successful retry of stage `upload` → notifies with the title and deletes from the spool (R6.2, R5.2).
  - Test: failed intermediate retry → does **not** notify (R6.3).
  - Test: give-up → notifies with the last error and deletes from the spool (R6.4, R4.2).
  - Test: successful retry of stage `download` → promotes to `upload` and continues (R3.2).

- [x] **T9 — Restoration at startup, in `index.ts`.**
  - Test: with persisted state, at startup the queue is restored, the spool is reconciled and the timer is rescheduled (R2.3, R5.3).

- [x] **T10 — LaunchAgent (template plist + instructions).** No unit test: it is operating system configuration.
  - Plist in the repo with placeholder paths, `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false }`, `ThrottleInterval: 10`, logs to `~/Library/Logs/Bookcarrier/`.
  - `EnvironmentVariables.PATH` with Homebrew's prefix (R7.5) — without this the download fails under launchd with an error that lies.
  - `ProgramArguments` pointing to `/opt/homebrew/opt/node@24/bin/node` (R7.6).

- [x] **T11 — Binary check at startup (R7.7).**
  - Test: if `fanficfare` is not resolvable, startup logs it naming the missing binary; if both are present, it logs nothing.
  - Document the `launchctl bootstrap` / `bootout` / `print` commands and `plutil -lint`.

## Manual verification (before closing the feature)

- [ ] With the Kindle off, share a fic: confirm the enqueue notice and that the EPUB stays in the spool.
- [ ] Turn the Kindle on before 30 min: confirm the delivery, the notice with the title and that the spool ends up clean.
- [ ] With the Kindle off, wait the full 30 min: confirm the give-up notice and a clean spool.
- [ ] With an item enqueued, kill the daemon (`kill`) and confirm that launchd relaunches it, restores the queue and delivers.
- [ ] Rename the SSH key and share a fic: confirm it is **not** enqueued and a configuration error is reported.
- [ ] Corrupt `queue.json` by hand and restart: confirm the rename to `.corrupt-<ts>`, the clean startup and the notice.
- [ ] Test whether a freshly copied fic shows up in KOReader without restarting it. If it does not, try the `dbus-send` noted in research.md.
