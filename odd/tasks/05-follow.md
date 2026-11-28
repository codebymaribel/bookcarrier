# Feature 5 — Follow + chapter tracking

Implements docs/specs/05-follow (requirements.md, research.md, design.md, tasks.md). Branch `feature/05-follow-v2`, cut from `main` at b937c9d (429 deferral #7 and DDD layout #8/#9 merged); ported from the old branch `feature/05-follow` (eba3ef3, cut from 40a3fde), which stays as the reference for code and tests (L23).
Those spec files are the verbatim source of every requirement; the S# below point at them instead of copying them.

## Specs

- S1: requirements.md, whole document (R1–R8, acceptance criteria 1–12), once the owner approves it.

## Tasks

- [x] T1 research.md + requirements.md draft — S1 — inline — commit: 446f4e1
- [x] T2 owner review of requirements (Open questions Q1, Q2) — S1 — owner — resolved 2026-11-22 (L6, L7)
- [x] T3 design.md — S1 — inline — approved 2026-11-23 (L11)
- [x] T4 tasks.md (implementation tasks, each with its test) — S1 — inline — written 2026-11-23, pending owner review
- [x] I1–I11 implementation (superseded by the v2 port P0–P4): docs/specs/05-follow/tasks.md T1–T11 — T1, T2 done (0193871); T3 done (5c0ac1d); T4–T6 done (a2ab8bb); T7–T10 done (d0c5012); T11 done (docs commit); manual verification pending (owner)
- [x] P0 port spec update: design.md, tasks.md, research.md for the DDD layout and the 429 deferral — S1 — inline (L23)
- [x] P1 port T1–T6 (fic-meta, json-file, follows context, followsPath, downloader, queue meta incl. `deferred`+`meta`) — S1 — writer
- [x] P2 port T7–T10 (messages/keyboards, pipeline delivery action + telegram translation, taps, startup wiring) — S1 — writer
- [x] P3 port T11 (docs, incl. docs/fanficfare.md paths and 429 deferral description) — S1 — writer
- [x] P4 independent verification of the port (typecheck, full suite, differential check, R1–R8 and criteria 1–15) — S1 — verify

## Log

- L1 (user): "arranca la feature 5"
- L2 (user decisions): feature 5 = "Chequeo diario de actualizaciones"; branch "desde main, ya hice pull"; "Spec primero (requirements → design → tasks)".
- L3 (user decision): after learning the daily check depends on Follow, which does not exist: "Feature 5 = Follow + seguimiento de capítulos" (daily check becomes feature 6).
- L4 (user decisions): Follow button "En todos los fics de AO3"; Unfollow "Sí, botón \"Unfollow\""; repeated link of a followed fic: "Se actualizan solos".
- L5 (evidence): a FanFicFare `-m -j` probe against AO3 got 429; field names (`numChapters`, `status`) confirmed from FanFicFare 4.63.0 source instead; no retry.
- L6 (user): "q1 -> cuando dices las ultimas 50 entregas te refieres a los ultimos 50 fics descargados de fanficfare o capitulos en total? q2 -> si el fic pasa de in_progress a complete lo dejamos de seguir"
- L7 (user decisions): last deliveries kept for Follow: "10 es suficiente"; complete fics: "No ofrecer Follow en completos" (supersedes L4's "En todos los fics de AO3"); auto-unfollow notice: "Sí, en el mensaje de entrega". requirements.md R2.4, R3.1, R3.1a, R3.5, R3.6, R6.4, R6.5 and criteria 3, 13–15 rewritten; Open questions removed.
- L8 (user): "otra consulta que tengo, cuando descargamos un capitulo nuevo de un fic que seguimos, descarga todos los capitulos o descarga solo el ultimo? que riesgo de 429 Too Many Requests nos trae esto en fanficfare"
- L9 (evidence): answered from FanFicFare 4.63.0 source; recorded as research.md §4 (whole fic, ~3 requests via view_full_work regardless of chapters; 429 risk is frequency, relevant to feature 6).
- L10 (user): "reviso el design.md, mientras, quiero que me crees un archivo en docs explicando el uso que le damos a fanficfare, es decir, desde que funciones se llama, que comandos usamos, configuracion del cli, etc" → docs/fanficfare.md written (side request, not a feature 5 task).
- L11 (user): "listo el design" → design.md approved; tasks.md written.
- L12 (evidence): spec committed in 446f4e1, docs/fanficfare.md in 766ee4b. Slice boundary: these two docs-only commits (573 lines) form the spec slice; implementation starts a new slice.
- L13 (user): "lo he intentado la ultima media hora, dejando minutos de por medio y sigue dando 429 :/"
- L14 (evidence): prerequisite resolved from FanFicFare source: numChapters is a string via commaGroups (story.py:1167-1169); JSON file is output_filename+".json" (cli.py:600). Real run moved to manual verification.
- L15 (user): "ok con tasks.md" → implementation started. T1 parseFicMeta signature changed to (raw, { workId, url, fallbackTitle }) so the title fallback has a source; design.md updated.
- L16 (evidence): implementation slice 1 = 0193871 (T1, T2). T3 follows.ts delegated to gentle-ai-worker (context backstop); 27 tests, full suite 563 passed; worker decisions: follow removes from recent; update keeps url/author/followedAt; no-op outcomes do not write.
- L17 (evidence): T4–T6 by gentle-ai-worker; parent added followsPath to test/document.probes.test.ts (outside worker surfaces) so typecheck passes; full suite 580 passed. Design updated: DownloadOptions.workId, DownloadResult.metaWarning, enqueue carries meta.
- L18 (evidence): T7–T10 by gentle-ai-worker; full suite 623 passed, typecheck clean. Accepted worker decisions: owner notified on corrupt follows.json (mirrors queue); createBot follows param optional; not-followed Unfollow tap leaves markup; unfollow write failure → followSaveFailed.
- L19 (evidence): T11 docs by gentle-ai-worker; parent also renumbered 01 requirements Scope line ("feature 3" → "feature 5"). Roadmap marks feature 5 in progress until manual verification.
- L20 (evidence): independent gentle-ai-verify (Risk: item 3): typecheck clean, 623 tests; differential check main vs HEAD on createStateStore identical across 17 cases; downloader args only append --json-meta-file; no weakened assertions; R1–R8 and criteria 1–15 PASS (automated parts); manual checklist still pending.
- L21 (user): "tenemos actualizaciones en el proyecto, ya tengo actualizado main, comparalo y analiza como afecta o cambia este feature"
- L22 (evidence): main gained #7 (AO3 429 deferral: QueueItem.deferred, deferredRetryMs, deferredGiveUpAfterMs; new links deferred while any item is deferred) and #8/#9 (DDD layout: src/<context>/ with index.ts public API, colocated tests, per-context messages.ts, bot.ts split into fanfic/pipeline.ts + telegram/bot.ts). Nearly every feature 5 source file conflicts.
- L23 (user decisions): "Portar sobre una rama nueva desde main"; "Contexto nuevo src/follows/"; "Acción abstracta que telegram/ traduce"; "feature/05-follow-v2; la vieja queda". Old branch feature/05-follow (eba3ef3) is the reference for code and tests.
- L24 (evidence): port on feature/05-follow-v2: bbfe750 spec (P0), 099cc61 T1–T2 + de8a22d T3–T6 (P1), 0dd0dfb T7–T10 (P2), 53824e9 T11 docs (P3). P4 gentle-ai-verify (Risk: item 3): PASS — typecheck clean; differential check of createStateStore main vs HEAD identical in 17 cases; FanFicFare args only gain --json-meta-file; #7 deferral tests untouched; DDD import rule and no grammY in fanfic/follows hold; R1–R8 and criteria 1–15 covered. Its end-to-end probe kept as src/app/follow.e2e.test.ts (681 tests). Manual checklist still pending (owner). Slice note: branch is ~2.8k lines in 5 work-unit commits; publish as chained PRs (spec / T1–T6 / T7–T10 / docs).
- L25 (user): AO3 still answered 429 days later (now on ?view_full_work=true). Owner chose "Creá el personal.ini con transformativeworks": ~/.fanficfare/personal.ini created with [archiveofourown.org] use_archive_transformativeworks_org:true (FanFicFare wiki ProblematicSites); documented in docs/fanficfare.md. Pending: one manual run to confirm.
- L26 (user): transformativeworks mirror answered "403 Client Error: Forbidden for url: https://archive.transformativeworks.org/works/93369896/navigate"; personal.ini switched to use_archiveofourown_gay:true for one more try.
- L27 (user): "sacame el commit del espejo de AO3 porque no funciono, es decir no lo usaremos" → mirror note removed from docs/fanficfare.md before commit; ~/.fanficfare/personal.ini (created in this feature, only content was the mirror setting) deleted. FanFicFare runs with its defaults again.
- L28 (user): "listo, cerramos el feature 5. pasame el mensaje del PR" → manual verification recorded in 5e2aba6; roadmap row 5 marked done in README.md and README.es.md; feature closed. Push/PR remain the owner's.
