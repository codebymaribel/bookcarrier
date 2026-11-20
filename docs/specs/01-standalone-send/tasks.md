# Tasks — Feature 1: Standalone Send

Each task ships with its test (Vitest). See [design.md](./design.md).

## Step 0 — Scaffolding (no business logic) — **not blocked by the manual tests**

- [x] Node 24 project + strict TypeScript, `pnpm init`, Vitest configuration.
- [x] `logger.ts`: simple logger (info/warn/error levels, timestamp).
- [x] `config.ts` + `config.example.json`: loads and validates the external config file (R6.1–R6.4). Includes `kindlePort`.
  - Test: a valid config loads fine; a config with a missing field throws a clear error; `config.example.json` is never read as the real config.
- [x] `config.ts`: expand a leading `~` in `sshKeyPath` (R6.5).
  - Test: `~/.ssh/k` → `<home>/.ssh/k`; `~` alone → `<home>`; an absolute path is left untouched; `~other/x` is left untouched.

## Prior manual test (blocks T1–T7, not Step 0) — see [manual-tests.md](./manual-tests.md)

- [x] Install FanFicFare on the Mac (`brew install fanficfare`) and run by hand:
  ```
  cd $(mktemp -d) && fanficfare '<test-url>' -f epub -o output_filename='${storyId}-${title}${formatext}' ; ls -la
  ```
  Confirm: (a) that the file comes out as `<storyId>-<title>.epub`, (b) that the download works with AO3 in its current post-incident state, (c) what `exit code` it returns. **This test can only be done on the Mac** — AO3 is not reachable from sandbox environments.
- [x] Test `scp` by hand with KindleMOD's key to `/mnt/us/documents/books/`.
- [x] Create the bot in BotFather (already done) and confirm it responds to a simple message with long polling using a minimal grammY script.

## Feature 1

- [x] **T1 — Owner filtering (R1.1).** grammY middleware that discards updates from any `from.id` different from the configured one.
  - Test: an update from a different id produces no reply; an update from the owner passes to the next handler.
- [x] **T2 — AO3 link extraction and validation (R2.1, R2.2, R2.3).** Function that receives the message text and returns the AO3 work id, or a rejection reason (not AO3 / not an individual work).
  - Lives in `ao3-link.ts` (see design.md). Contract: `extractWorkLink(text)` → `{ ok: true, workId, canonicalUrl }` or `{ ok: false, reason }`.
  - Test: different texts (no URL, URL from another site, AO3 URL to a series, AO3 URL to a work) return the expected result.
  - Test (R2.4): the real Android share text from manual test 3 — title line, then `https://archiveofourown.org/works/61265059` — returns `workId: '61265059'`.
  - Test (R2.4): `/works/<id>/chapters/<n>`, `/collections/<name>/works/<id>`, `www.` host, and `?view_adult=true` / `#comments` all return the work id; `/collections/<name>` alone and `/users/<name>` are `unsupported-link`.
  - Test (R2.4): `https://evil.example/archiveofourown.org/works/1` and `https://notarchiveofourown.org/works/1` are `no-ao3-link`.
  - Test (R2.5): two AO3 links in one text → the first one's id.
  - Test (R2.6): `canonicalUrl` is always `https://archiveofourown.org/works/<id>`, whatever form the input had.
- [ ] ~~**T3 — `filename.ts`: stable name.**~~ **No longer needed** (2026-11-17): FanFicFare generates and sanitizes the name itself with `-o output_filename=...`. R4.1 and R4.2 are covered in T4.
- [x] **T4 — `downloader.ts`: download with FanFicFare (R3.1–R3.5, R4.1, R4.2).** Includes passing the `output_filename` template and resolving the resulting EPUB from a temporary directory exclusive to the request.
  - Test (with mocked subprocess, no calls to AO3): exit 0 + a single `.epub` in the directory → resolves with that path; exit 0 but zero `.epub` → rejects; exit 0 but more than one `.epub` → rejects; non-zero exit → rejects; timeout exceeded → rejects and kills the process.
  - Test: the arguments passed to `spawn` include `-o output_filename=${storyId}-${title}${formatext}` exactly (without TypeScript interpolating the `${...}`).
  - Test: a Python traceback on stderr → the error message carries only its last line (no stack trace for the owner); the full tail is kept in `error.stderr` for the logs.
  - Test (R3.6): the arguments include `--non-interactive`, and `spawn` is called with stdin set to `'ignore'`.
  - Test (R3.5): `'error'` event with `ENOENT` → rejects with an error **distinct** from a download failure, and the message names `fanficfare`. This case is not confused with a non-zero exit code.
- [x] **T5 — `uploader.ts`: send via scp (R5.1–R5.7).**
  - Test (R5.2, prior check, without spawning): non-existent key → rejects with a configuration error and `spawn` is **not** called.
  - Test (R5.2, permissions): `600` passes; `400` **also** passes (SSH's criterion, not exactly `600`); `644` fails naming the permissions; `640` fails (the group can read); `000` fails (the owner cannot read it).
  - Test (R5.5): `'error'` event with `ENOENT` → rejects with a configuration error naming `scp`.
  - Test (R5.6): `spawn`'s arguments include `-o BatchMode=yes`.
  - Test (R5.8): the arguments include **uppercase** `-P` with the port from `opts.port`, and do **not** include lowercase `-p`. This test exists because `-p` is a silent mistake: the invocation looks valid and fails as if the Kindle did not respond.
  - Test: success (exit 0) → resolves.
  - Test (R5.3, R5.7): non-zero exit → rejects as a send failure, **without** branching on the code's value.
  - Test: own timeout exceeded → rejects and kills the process.
- [x] **T6 — Orchestration in `bot.ts` (full flow + messages to the owner).**
  - Test: given a valid link, `downloader` → `uploader` are called in order, and the bot replies with the expected success message (R5.4); given a failure at any step, the corresponding error message is sent and the next step is not called.
  - Test: the downloader receives the canonical URL (R2.6), not the original text.
  - Test: the request's temporary directory is removed after a success **and** after a failure at either step.
  - Test: two messages arriving back to back are processed one after the other, not interleaved. (Run through grammY's real long-polling loop with a fake `getUpdates`: `handleUpdate` called in parallel would not prove anything, because only `bot.start()` serializes.)
  - Test: one distinct message per failure class (link not recognized / not supported, download failed, FanFicFare not launchable, send failed, configuration problem, unexpected); an unexpected error shows no detail to the owner; subprocess stderr goes to the log only.
- [x] **T7 — `index.ts`: entrypoint.** Loads config, instantiates the bot, starts long polling. (No unit test — it is the integration point; verified by hand against real Telegram at the end.)
  - Also adds `tsconfig.build.json` (compiles only `src` to `dist/`) and the `build` / `start` scripts: Node does not resolve `./x.js` imports to `.ts`, so the daemon runs from the compiled output (`pnpm build && pnpm start`).
  - Checked without touching the real bot (temporary `HOME`, fake token): missing config, invalid config and a rejected token all log the cause and exit with code 1; the token never appears in the output.

## Final verification (manual, before closing the feature)

- [x] Share a real AO3 link from Android to the bot and confirm the EPUB reaches the Kindle with the expected name.
- [x] Try an invalid link and confirm the rejection message.
- [x] Turn the Kindle off (or disconnect it from the network) and confirm the bot reports the error without hanging.

_Final verification passed by hand on 2026-11-19 (real Telegram, real Kindle). Feature 1 closed._

## Deferred (not part of this feature)

- **Accented titles.** FanFicFare sanitizes accents to `_` (`Corazón partido` → `Coraz_n partido`), and the delivery message shows that string. Cosmetic; no accented fic has been tried yet. When it matters, the fix is internal to `downloadEpub` (a prior `-m` / `--meta-only` request for the clean title, see design.md) and does not touch its signature or `bot.ts`. Decided 2026-11-19: leave it for later.
