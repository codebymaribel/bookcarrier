# DDD layout (refactor)

Reorganize `src/` by bounded context so it is clear what works with what. No behavior change.
Branch `refactor/ddd-layout` from `main`.

## Specs

- S1: "vamos a reorganizar la organizacion del proyecto con DDD. Actualmente estan todos los archivos de todas las features mezclados y se hace imposible conseguir que funciona con que" — `src/` is split into one folder per bounded context: `fanfic/`, `retry-queue/`, `documents/`, `kindle/`, `telegram/`, `shared/`, `app/`. `src/index.ts` stays as the entrypoint (`dist/index.js` is used by launchd and bookcarrierctl).
- S2: "Estratégico: carpeta por contexto" — strategic DDD only: no `domain/application/infrastructure` subfolders. Each context has an `index.ts` as its public API; code outside a context imports only through that `index.ts`.
- S3: "Junto al código (src/fanfic/x.test.ts)" — unit tests live next to the module they test. Tests of non-`src` artifacts (bookcarrierctl, launchd plist, SwiftBar template) stay in `test/`.
- S4: "Mover + extraer pipeline de bot.ts" — `createPipeline` (the AO3 request/retry use case) moves out of `bot.ts` into `fanfic/pipeline.ts`; `errors.ts` (failure classification) becomes `fanfic/failure.ts`. `telegram/bot.ts` keeps only the Telegram interface. No behavior change: the whole suite passes unchanged in its assertions.
- S5: README (EN/ES) project layout describes the new structure.

## Tasks

- [x] T1 move modules and tests into context folders, fix imports and configs; errors → fanfic/failure — S1, S3, S4 (rename) — inline — commit: d9aadc5
- [x] T2 extract pipeline from bot.ts into fanfic/pipeline.ts (and its flow tests) — S4 — inline — commit: 3906630
- [x] T3 context index.ts public APIs, cross-context imports through them — S2 — inline; messages split per context (L3); binaries → app — commit: aafc56a
- [x] T4 README EN/ES layout — S5 — inline — commit: 96145e7

## Log

- L1: "vamos a reorganizar la organizacion del proyecto con DDD. Actualmente estan todos los archivos de todas las features mezclados y se hace imposible conseguir que funciona con que"
- L2: decisions (ask): strategic DDD, folder per context; tests next to code; move + extract pipeline from bot.ts; branch from main ("ya esta actualizada").
- L3: messages.ts decision (ask): "Partirlo por contexto (Recomendado, DDD real)" — each context owns its messages and error→text mapping; README one-file promise updated.
- L4: slice boundary: T1+T2 (~400 lines) form one review slice; T3+T4 the second. Each commit leaves typecheck clean and 536/536 tests passing.
