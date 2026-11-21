# Feature 2 — Retry queue + launchd

Implements docs/specs/02-retry-queue (requirements.md, design.md, research.md, tasks.md). Branch `feature/02-retry-queue`, cut from `feature/01-standalone-send` (not merged into main yet).
Those spec files are the verbatim source of every requirement; the S# below point at them instead of copying them.

## Specs

- S1: requirements.md "R1 — Enqueueing" (R1.1–R1.4), verbatim there.
- S2: requirements.md "R2 — Persistence" (R2.1–R2.5).
- S3: requirements.md "R3 — Retries" (R3.1–R3.5), ladder "1, 2, 4, 8, 15 minutes".
- S4: requirements.md "R4 — Giving up" (R4.1–R4.2), window "30 minutes" (`giveUpAfterMs`).
- S5: requirements.md "R5 — File spool" (R5.1–R5.3).
- S6: requirements.md "R6 — Notifications to the owner" (R6.1–R6.4).
- S7: requirements.md "R7 — The daemon must come back on its own" (R7.1–R7.7).
- S8: requirements.md "Acceptance criteria" 1–7, and tasks.md test list per task.

## Tasks

- [x] T1 errors.ts classification — S1 — inline — commit: 6beffa6
- [x] T2 queue/state.ts atomic state — S2 — inline — commit: 6beffa6
- [x] T3 queue/queue.ts adds/removals/backoff — S3, S4 — inline — commit: 6beffa6
- [x] T4 queue/spool.ts — S5 — inline — commit: 6beffa6
- [x] T5 queue/scheduler.ts single timer — S3 — inline — commit: 6beffa6
- [x] T6 downloader to spool + classified errors — S1, S5 — inline — commit: (this commit: feat(queue) wire retry queue)
- [x] T7 uploader failure classification — S1 — inline — commit: (this commit: feat(queue) wire retry queue)
- [x] T8 bot.ts orchestration + notifications — S1, S3, S4, S6 — inline — commit: (this commit: feat(queue) wire retry queue)
- [x] T9 startup restoration in index.ts — S2, S5 — inline — commit: (this commit: feat(queue) wire retry queue)
- [x] T10 LaunchAgent template plist + docs — S7 — inline — commit: (pending, parent commits)
- [x] T11 binary check at startup + launchctl docs — S7 — inline — commit: (pending, parent commits)
- [x] Manual verification list (tasks.md) — owner, on the real Kindle — done 2026-11-21

## Log

- L1: "Realiza la feature 2"
- L2: Exploration: feature 1 not merged to main; downloader has no 403/429/404 detection yet (only stderr text); FanFicFare needs an empty exclusive outDir, so the spool uses one sub-directory per queue item (`spool/<id>/<file>.epub`).
- L3: Implementation decisions: spool keeps one directory per item (`spool/<id>/`), so `discard(id)` removes the item's directory; an unrecognized FanFicFare exit is classified transient (the 30-min window bounds the cost); a retry that hits a permanent error is removed and reported; requests and retries share one work chain so AO3 and the Kindle see one operation at a time; a batch that throws re-arms no sooner than 60 s. Config gained `queuePath`, `spoolDir`, `giveUpAfterMs`, `retryBackoffMinutes`. Orchestration of startup lives in `src/daemon.ts`.
- L4: T10–T11 done: template plist `launchd/com.codebymaribel.bookcarrier.plist` (placeholders `__REPO__`/`__HOME__`, node@24, KeepAlive SuccessfulExit=false, ThrottleInterval 10, logs under ~/Library/Logs/Bookcarrier, Homebrew PATH; `plutil -lint` OK); `src/binaries.ts` (`findMissingBinaries` searches PATH for executable regular files, `checkRequiredBinaries` logs one error with the missing names + PATH, nothing when all present) wired into `main()` after config load, test-first in `test/binaries.test.ts`; README.md/README.es.md document the queue, new config fields and LaunchAgent install; tasks.md T1–T11 ticked (manual list pending). typecheck/test (213)/build green.
- L5: Hardening after assess (medium, review not due): spool reconcile only deletes uuid-named item dirs and loose .epub files, so a misconfigured spoolDir cannot delete unrelated files. Manual verification list remains for the owner.
- L6: gentle-ai-verify (Risk: item 5): S2 pass, S7 partial — blocker: a polling failure after start left the retry timer alive so the process never exited 1 and launchd could not relaunch it. Fixed with daemon.pollUntilStopped (finally → daemon.stop()), plist contract test added, engines raised to >=24.15.0 (write-file-atomic 8 requirement). Clean SIGTERM exit 0 still needs a real-Telegram manual check.
- L7: Owner ran the SIGTERM check with the real Telegram config: "bot started" → "retry queue restored {items:0}" → "shutting down {SIGTERM}" → "bot stopped", exit code: 0. S7 clean-exit path confirmed.
- L8: Owner completed every manual check in docs/specs/02-retry-queue/tasks.md on the real Kindle (enqueue + spool, delivery before 30 min, give-up at 30 min, kill -9 relaunch + restore + deliver, renamed SSH key not enqueued, corrupt queue.json renamed + notice, KOReader pick-up). The kill item was reworded to `kill -9` (plain kill = SIGTERM = exit 0, not relaunched per R7.2). Real-world evidence 2026-11-21 10:26–10:27Z: Wi-Fi timeout enqueued, delivered on first retry.
