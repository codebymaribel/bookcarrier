# AO3 rate-limit deferral (extends feature 2, retry queue)

When AO3 keeps answering 429 past the 30-minute retry window, the request is not lost: it is kept, the owner is told, and it is retried every few hours.
Branch `feature/ao3-rate-limit-deferral`. Builds on docs/specs/02-retry-queue (R1–R6 there still hold except where a spec below says otherwise).

## Specs

- S1: "si se acaba el plazo de retry y aun no se ha completado el queue por el error, que guardemos esos requests, le avisemos al usuario que hay inconvenientes con fanficfare e intentaremos luego y que intentemos de nuevo pasadas unas horas" — when a queued download's 30-minute window (or backoff ladder) runs out and the last failure is a rate limit, the item is **kept** (deferred), not abandoned; its EPUB spool directory is kept.
- S2: Only rate-limit failures are deferred ("Solo 429 / rate-limit"): a `DownloadFailedError` whose stderr or message shows `429` / `Too Many Requests`. Any other give-up behaves as today (removed, spool cleaned, `gaveUp` message).
- S3: The deferred retry runs **2 hours** later ("2 horas"), configurable (`deferredRetryMs`, default `7200000`).
- S4: A deferred item is retried every 2 hours until **24 hours** after its first enqueue ("Cada N horas hasta 24 h"), configurable (`deferredGiveUpAfterMs`, default `86400000`). When the next deferred attempt would land past that limit, it is abandoned: removed, spool cleaned, owner notified with the last error.
- S5: The owner is notified exactly once when an item becomes deferred: FanFicFare/AO3 is having trouble and it will be tried again later (in about 2 hours, for up to 24 hours). Failed deferred retries in between are silent. Delivery is notified as today.
- S6: While at least one deferred item is in the queue (AO3 cooling down), a new link is **not** sent to AO3 ("Diferirlo directo"): it is enqueued as deferred at stage `download`, scheduled with the earliest deferred item's next attempt, and the owner is told it was saved and when it will be tried. No "downloading…" ack is sent for it.
- S7: The deferred flag is persisted in the queue file (optional field, version 1 stays readable both ways) and survives a daemon restart.
- S8: README (EN/ES) and config.example.json describe the deferral, the two new config keys and the new messages.

## Tasks

- [ ] T1 rate-limit detection, deferred state in queue/state, config keys — S1–S4, S7 — inline — commit:
- [ ] T2 pipeline: defer on give-up, deferred notifications, cooldown for new links, daemon wiring — S1, S4–S6 — inline — commit:
- [ ] T3 docs: README EN/ES, config.example.json — S8 — inline — commit:

## Log

- L1: "tenemos un inconveniente en el proyecto. fanficfare (o ao3 realmente) esta devolviendo 429 Client Error: Too Many Requests. lleva horas en eso por lo que el bot no funciona. Que quiero implementar: si se acaba el plazo de retry y aun no se ha completado el queue por el error, que guardemos esos requests, le avisemos al usuario que hay inconvenientes con fanficfare e intentaremos luego y que intentemos de nuevo pasadas unas horas"
- L2: Owner decisions: wait "2 horas"; limit "Cada N horas hasta 24 h"; scope "Solo 429 / rate-limit"; new links during cooldown "Diferirlo directo".
- L3: Parent decision: a deferred item whose download succeeds stays deferred through its upload, so an upload failure right after waits the deferred cadence (2 h) until the 24 h limit instead of restarting the 30-minute ladder (whose window is already spent).
