# Feature 3 — Send a document (EPUB, MOBI, PDF) as a file

Implements docs/specs/03-document-send (requirements.md, design.md, research.md, tasks.md). Branch `feature/03-document-send`, cut from `main` at a0a4d02 (features 1 and 2 merged).
Those spec files are the verbatim source of every requirement; the S# below point at them instead of copying them.

## Specs

- S1: requirements.md R1 (owner only) — verbatim there.
- S2: requirements.md R2 (accepted documents: format, size).
- S3: requirements.md R3 (file name sanitization).
- S4: requirements.md R4 (existence check over ssh, quoting).
- S5: requirements.md R5 (overwrite confirmation, pending store, expiry).
- S6: requirements.md R6 (download from Telegram, token never leaked).
- S7: requirements.md R7 (no queue for documents, errors).
- S8: requirements.md R8 (`documentFolders` config).
- S9: requirements.md acceptance criteria and tasks.md test lists per task.

## Tasks

- [x] T1 config documentFolders — S8 — writer A (wave 1) — commit: 32bbd23
- [x] T2 ssh.ts shared part out of uploader — S4 — writer B (wave 1) — commit: 84a8ebd
- [x] T3 shellQuote — S4 — writer B (wave 1) — commit: 84a8ebd
- [x] T4 existsOnKindle — S4 — writer B (wave 1) — commit: 84a8ebd
- [x] T5 sanitizeFileName — S3 — writer C (wave 1) — commit: d8f031c
- [x] T6 validateDocument — S2, S8 — writer C (wave 1) — commit: d8f031c
- [x] T7 downloadTelegramFile — S6 — writer D (wave 1) — commit: acda1ce
- [x] T8 pending store — S5 — writer C (wave 1) — commit: d8f031c
- [x] T9 messages + documentFailureMessage — S2, S5, S7 — writer D (wave 1) — commit: acda1ce
- [x] T10 createDocumentFlow — S2–S7 — wave 2 — commit: 0734d43
- [x] T11 bot.ts wiring — S1, S5 — wave 2 — commit: 0734d43
- [x] T12 ssh in the startup binary check — S4 — wave 2 — commit: 0734d43
- [x] T13 docs — S8, S9 — wave 2 — commit: c54700a
- [x] Research prerequisites by hand (`ssh … test -e` exit codes; > 20 MB `getFile` error text) — owner — research.md checklist marked done (L5, L6; commit c3da530)
- [ ] Manual verification list (tasks.md) — owner — pending human

## Log

- L1: "listo. pasamos a la feature 3"
- L2: Prerequisite checks in research.md need the owner: the harness safety policy blocks the agent from reading ~/.ssh, so `ssh … test -e` is run by the owner; the > 20 MB `getFile` error needs a real upload to the bot. Wave 1 (T1–T9) starts meanwhile; T4/T7 details may be adjusted after the results.
- L3: Owner check (research "> 20 MB" item, partial): a 20,333,552-byte PDF (19.39 MiB) → getUpdates carries `file_size`; getFile returned ok with `file_path` "documents/file_0.pdf". So the Bot API limit is binary (20 × 1024 × 1024 = 20,971,520 bytes), not 20,000,000: the T6 size check must use 20 MiB. The "file is too big" error text still needs a file > 20 MiB.
- L4: Incident: `brew upgrade node` (26.12.1 → 26.13.1, fixing the missing libsimdjson.34) removed the node binary this Pi session spawns subagents with (ENOENT). Owner chose to restart the Pi session. Wave 1 (T1–T9) has NOT started: no source file was touched. Resume: relaunch the 4 wave-1 writers (A: T1 config; B: T2–T4 ssh.ts; C: T5, T6, T8 document.ts + pending.ts; D: T7, T9 telegram-file.ts + messages.ts) with disjoint surfaces. Pending from the owner: test -e exit codes (0/1/1/255 expected) and the getFile text for a file > 20 MiB; research items 3–7 instructions were given.
- L5: "retoma la feature 3". Session restarted, node 26.13.1 works, baseline `pnpm test` 217/217 green. Owner marked every research.md "To test by hand" item done: `:` in a name fails on vfat (`scp: dest open "/mnt/us/documents/books/Dune: Messiah.pdf": Bad message`), a 19 MB scp took seconds (well inside uploadTimeoutMs), quoting with `'` works. Not recorded verbatim: the exact `test -e` exit codes and the `getFile` error text for > 20 MiB; T4 keeps 0/1/255 and T9 must not depend on the exact getFile text. Wave 1 relaunched (writers A–D).
- L6: Owner recorded in research.md: `test -e` exit codes exists → 0, doesn't exist → 1, Kindle asleep → 255 (T4 matches); `getFile` > 20 MiB → `{"ok":false,"error_code":400,"description":"Bad Request: file is too big"}` (T7 `isTooBigError` matches `/too big|too large/i`).
- L7: Wave 1 integrated: `pnpm test` 365/365, `pnpm typecheck` exit 0. Writer decisions to carry into wave 2: `ResolvedConfig.documentFolders` is a `ReadonlyMap` (defaults stored as a Map); `PendingStore.size()` is test-only; R3.4 base name = everything before the last `.`, names that sanitize to dots/spaces or dotfiles → rejected; `messages.tooBig(sizeBytes?)` takes BYTES (T10 passes `DocumentCheck.sizeBytes`), shown as binary MB; local-write errors in `downloadTelegramFile` are rethrown (→ `unexpected`); upload error classes live in `ssh.ts` and are re-exported by `uploader.ts`; key-check tests duplicated in `ssh.test.ts` instead of moved (uploader tests kept unchanged). Parent patched the `ResolvedConfig` fixtures in test/bot.flow.test.ts and test/daemon.test.ts.
- L8: Slice boundary: wave 1 (T1–T9) = commits 14a01b4..acda1ce (~1,860 authored lines, past the ~400 slice). Delivery shape (one PR or chained PRs) is the owner's decision at publish time. Risk: item 2 (shellQuote builds a remote shell command on the Kindle; token must never leak in download errors) → independent verify launched.
- L9: Independent verify (wave 1): no blockers; S2–S8 met. Should-fix fixed by parent: `downloadTelegramFile` rethrew any pipeline error with a `syscall` raw, so a read-side error carrying the URL/token could escape (R6.5). Now the side is decided by which stream emitted first (pipeline forwards errors to both); regression test added (RED observed, then 366/366, typecheck 0). Nit fixed: `isTooBigError` comment now cites L6.
- L10: Wave 2 integrated: `pnpm test` 406/406, typecheck 0. Writer decisions: `download` is a required override of `createDocumentFlow` (needs `getFile`); documents are wired inside `createBot` (optional 4th param), index.ts unchanged per design; two existing binaries tests updated for `ssh`. Flagged, not fixed: a document scp after "Replace" does not join the pipeline's serialization chain, so it can run alongside a retry-queue scp; a failed overwrite question leaves the pending entry until expiry. README tables not re-run through Prettier (not installed in the repo). Slice boundary: wave 2 = 0734d43..c54700a. Independent verify of wave 2 launched (Risk: item 2 token/owner-only, item 4 concurrent scp).
- L11: Independent verify (wave 2): no blockers; S1–S9 met (manual list pending). Concurrency (document scp alongside a retry scp) judged an acceptable follow-up: different default folders, design does not require serialization. Parent fixed the should-fix (a failed overwrite question now drops the pending entry and replies `messages.unexpected`; RED observed), corrected the bot.ts pipeline comment, and added the verifier's 6 probes as test/document.probes.test.ts. `pnpm test` 413/413, typecheck 0.
- L12: Owner: "listas las pruebas, casi todas pasan excepto la 5 que dio este error: I couldn't download that fic right now (fanficfare exited with code 1: fanficfare.exceptions.HTTPErrorFFF: HTTP Error in FFF '429 Client Error: Too Many Requests for url: https://archiveofourown.org/works/93369896/chapters/249170766'(429)). I'll keep retrying for up to 30 minutes and tell you how it goes." Every manual item passed except acceptance criterion 12 (AO3 link while a question is pending). The 429 is AO3 rate limiting, not the document flow: the link did reach fanficfare and the feature 2 retry queue took it, so the pending question did not block the AO3 flow. Criterion 12 stays open until the retry delivers the fic (or a later fresh run does).
