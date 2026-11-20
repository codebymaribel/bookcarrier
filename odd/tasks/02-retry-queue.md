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

- [ ] T1 errors.ts classification — S1 — inline — commit: 
- [ ] T2 queue/state.ts atomic state — S2 — inline — commit: 
- [ ] T3 queue/queue.ts adds/removals/backoff — S3, S4 — inline — commit: 
- [ ] T4 queue/spool.ts — S5 — inline — commit: 
- [ ] T5 queue/scheduler.ts single timer — S3 — inline — commit: 
- [ ] T6 downloader to spool + classified errors — S1, S5 — inline — commit: 
- [ ] T7 uploader failure classification — S1 — inline — commit: 
- [ ] T8 bot.ts orchestration + notifications — S1, S3, S4, S6 — inline — commit: 
- [ ] T9 startup restoration in index.ts — S2, S5 — inline — commit: 
- [ ] T10 LaunchAgent template plist + docs — S7 — inline — commit: 
- [ ] T11 binary check at startup + launchctl docs — S7 — inline — commit: 
- [ ] Manual verification list (tasks.md) — owner, on the real Kindle — pending human

## Log

- L1: "Realiza la feature 2"
- L2: Exploration: feature 1 not merged to main; downloader has no 403/429/404 detection yet (only stderr text); FanFicFare needs an empty exclusive outDir, so the spool uses one sub-directory per queue item (`spool/<id>/<file>.epub`).
