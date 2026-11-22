# Tasks — Feature 3: Document Send

Each task ships with its test (Vitest). See [design.md](./design.md) and [requirements.md](./requirements.md).

Prerequisites:

- Feature 2 is closed and verified by hand. (Feature 3 builds on its `errors.ts` and on the shape `bot.ts` has after the queue.)
- The "to test by hand" items of [research.md](./research.md) are done, at least the `ssh … test -e` one (exit codes against the real Kindle) and the one for a file > 20 MB (the exact `getFile` error text). Both can change a detail of T4 and T7.

The order follows the dependencies: config and pure helpers first, then the subprocess and network wrappers, then the orchestration, and the wiring last.

## Tasks

- [x] **T1 — `config.ts`: the `documentFolders` field.**
  - `parseDocumentFolders(raw, problems)`, the `CONFIG_DEFAULTS` entry, and `ResolvedConfig.documentFolders` as a `ReadonlyMap<string, string>`.
  - Test: absent → `epub`, `mobi`, `pdf` → `/mnt/us/documents/books/` (R8.2).
  - Test: present with only `{ "pdf": "/x/" }` → the map has only `pdf` (replaces, does not merge, R8.3).
  - Test: `"/mnt/us/documents/pdfs"` → resolved as `"/mnt/us/documents/pdfs/"` (R8.5).
  - Test: each invalid case names its entry, and every problem is reported in one `ConfigError` together with the other fields' problems (R8.4): not an object, `[]`, `{}`, key `"PDF"`, key `".pdf"`, key `"p df"`, value `""`, value `42`, value `"books/"`.
  - Test: the resolved value is a `Map`, and `has("constructor")` is `false` with the default config.
  - Test: the existing config tests pass unchanged.

- [x] **T2 — `ssh.ts` (shared part) + move it out of `uploader.ts`.** No behavior change.
  - Move `assertKeyUsable` to `ssh.ts`; add `SshTarget` and `commonSshArgs`. `uploader.ts` uses them.
  - Test: `commonSshArgs` returns `ConnectTimeout`, `BatchMode=yes` and `-i <key>`, and **no** port flag.
  - Test: the key-check tests now live in `ssh.test.ts` (moved, not rewritten).
  - Test: every existing `uploader.test.ts` test passes unchanged, plus one new one asserting the port is still uppercase `-P`.

- [x] **T3 — `ssh.ts`: `shellQuote`.** In its own test file (`shell-quote.test.ts`), because the T4 tests mock `spawn`.
  - Test: plain name → `'name'`; `it's.pdf` → `'it'\''s.pdf'`; empty string → `''`.
  - Test, round trip through a real local `sh -c "printf %s <quoted>"`: the output is byte-for-byte the input for `it's $(reboot) \`id\` "x" ; & | * ?`, a newline, accents and a leading `-` (R4.2, acceptance criterion 7).

- [x] **T4 — `ssh.ts`: `existsOnKindle`.** `spawn` mocked, the same pattern as `uploader.test.ts`.
  - Test: the arguments are exactly `-p <port>`, the common options, `user@host` and **one** argument `test -e '<path>'` (R4.1–R4.3).
  - Test: exit 0 → `true`; exit 1 → `false` (R4.5, R4.6).
  - Test: exit 255, another code, or killed by a signal → `UploadFailedError("exit-code")`; no `close` before `timeoutMs` → `UploadFailedError("timeout")` and the child is killed (R4.7).
  - Test: `error` event → `UploadConfigError("binary-not-found")` naming `ssh` (R4.8).
  - Test: unusable key → `UploadConfigError`, `spawn` not called (R4.4).

- [x] **T5 — `document.ts`: `sanitizeFileName`.**
  - Test, path traversal: `../../x.pdf` → `x.pdf`; `a/b.pdf` → `b.pdf`; `a\b.pdf` → `b.pdf` (R3.1).
  - Test, FAT characters: `Dune: Messiah.epub` → `Dune_ Messiah.epub`; each of `* ? " < > |` and a control character → `_` (R3.2).
  - Test: `name. .pdf` keeps its inner dot; `name.pdf. ` → `name.pdf` (trailing dots and spaces removed, R3.2).
  - Test: `Corazón.pdf` keeps the accent; the NFD form of `Corazón.pdf` comes out identical to the NFC form (R3.3).
  - Test: `""`, `.pdf`, `..pdf`, `   .pdf` → `undefined` (R3.4).

- [x] **T6 — `document.ts`: `validateDocument`.** Depends on T5.
  - Test: `book.epub`, `Book.MOBI`, `Report.PDF` with the default map → `ok`, with the folder from the map (R2.2).
  - Test: `book.azw3`, `photo.jpg`, `no-extension` → `unsupported-format` (R2.3); a document without `file_name` → `unsupported-format`.
  - Test: an animation's document (`file_name` `x.mp4`) → `unsupported-format` (R2.6).
  - Test: `file_size` 25 MB on a `.pdf` → `too-big` with the size (R2.5); exactly 20 MB → `ok`; no `file_size` → `ok` (the limit is then enforced by T7).
  - Test: a 30 MB `.zip` → `unsupported-format`, not `too-big` (format is checked first).
  - Test: with a custom map `{ pdf: "/a/" }`, `book.epub` → `unsupported-format` and `x.pdf` → folder `/a/` (R8.6).
  - Test: `x.constructor` → `unsupported-format`.

- [x] **T7 — `telegram-file.ts`: `downloadTelegramFile`.** Fake `getFile` and `fetch`, a real temporary directory.
  - Test: success writes exactly the bytes the fake `fetch` returns to `destPath` (R6.1).
  - Test: each failure gives its reason: `getFile` rejects → `get-file`; no `file_path` → `no-path`; status 404 → `http`; `fetch` throws → `network`; zero bytes → `empty` (R6.3).
  - Test: a `fetch` that never finishes → `timeout`, within `timeoutMs` (R6.2).
  - Test: `getFile` rejects with the "file is too big" description → `TelegramFileTooBigError` (R6.4).
  - Test (R6.5, acceptance criterion 15): for **every** failure above, neither the error's message, nor its `cause`, nor the line `formatLine` produces for it contains the token or `api.telegram.org/file/bot`.
  - Test: an existing file at `destPath` is not overwritten (`"wx"`).

- [x] **T8 — `pending.ts`: the pending-confirmation store.** Injected clock and id generator.
  - Test: `add` then `take` → the entry; a second `take` → `undefined` (R5.7, R5.9).
  - Test: `take` at 9:59 → the entry; at 10:01 → `undefined` (R5.8).
  - Test: `add` drops expired entries (the internal size goes down), with no timer created (`vi.getTimerCount() === 0`).
  - Test: `take` of an unknown id → `undefined`.
  - Test: the default id generator gives 8 characters matching `[A-Za-z0-9_-]`, and `ow:<id>:y` is at most 64 bytes (R5.3).

- [x] **T9 — `messages.ts`: the new texts and `documentFailureMessage`.**
  - Test: `unsupportedFormat` lists the formats it is given, upper-cased (`EPUB, MOBI, PDF`).
  - Test: `tooBig` with and without a known size.
  - Test: `documentFailureMessage` maps `TelegramFileTooBigError` → `tooBig`, `TelegramDownloadError` → `docDownloadFailed`, `UploadConfigError` → `uploadConfig`, `UploadFailedError` → `docSendFailed`, anything else → `unexpected`.
  - Test: no document text mentions "link" or "fic" (they are the fics' texts, not these).
  - Test: the existing `failureMessage` tests pass unchanged.

- [x] **T10 — `document-flow.ts`: `createDocumentFlow`.** The event-order style of `bot.flow.test.ts`: every fake pushes into one `events` list.
  - Test: valid, not on the Kindle → `docAck`, check, temp dir, download to `<dir>/<safeName>`, upload with `remotePath` = the format's folder, `docDelivered`, temp dir removed. No question (acceptance criterion 1).
  - Test: unsupported / too big → only the reply, no check, no download (R2.3, R2.5).
  - Test: on the Kindle → `docAck`, check, `askOverwrite` with the name, **no download**, and `onDocument` resolves (R5.1, R5.2, R5.4).
  - Test: `onDecision("replace")` on that id → download + upload + `docDelivered`; `onDecision("cancel")` → `overwriteCancelled`, no download (R5.5, R5.6).
  - Test: `onDecision` on an unknown or expired id → `confirmationExpired`, nothing else (R5.9).
  - Test: two documents both pending → each decision acts on its own document (R5.11).
  - Test: check fails with `UploadFailedError` → `docSendFailed`, no download, nothing enqueued (R4.7, R7.3); with `UploadConfigError` → `uploadConfig`.
  - Test: download fails → `docDownloadFailed`, no upload, temp dir removed; upload fails → `docSendFailed`, temp dir removed (R6.3, R7.3, R7.5).
  - Test: `reply` throwing does not stop the delivery (it is logged).
  - Test: neither function ever rejects, even when a fake throws something unexpected.
  - Test: the logger's calls never contain the token.

- [x] **T11 — `bot.ts`: wiring.** Through grammY with a fake transport, as `bot.owner.test.ts` does.
  - Test: a document from a stranger and a button tap from a stranger get no reply and no API call (R1.1, acceptance criterion 16).
  - Test: an owner's document reaches `onDocument`, and an owner's text still goes to the AO3 flow and never to `onDocument` (R2.1).
  - Test: `askOverwrite` sends an inline keyboard with "Replace" → `ow:<id>:y` and "Cancel" → `ow:<id>:n`.
  - Test: a tap on `ow:<id>:y` calls `answerCallbackQuery`, `editMessageReplyMarkup` and then `onDecision(id, "replace")`; if `editMessageReplyMarkup` fails, `onDecision` still runs (R5.7).
  - Test: a `callback_query` with data that does not match `OVERWRITE_DATA` is answered and nothing else happens.

- [x] **T12 — Binary check at startup: add `ssh`.** Extends feature 2's R7.7 check.
  - Test: if `ssh` is not resolvable, startup logs it naming `ssh`, together with `fanficfare` and `scp`.

- [x] **T13 — Documentation.** No unit test.
  - `config.example.json`: the `documentFolders` block with the default (R8.7).
  - `README.md` and `README.es.md`: config table row for `documentFolders` (default, replace-not-merge, and the note that a format KOReader cannot open can be added but will not be readable there); "Using it" rows for a document (delivered, unsupported format, too big, already exists → Replace/Cancel, expired); "How it works" steps for documents; roadmap renumbered (3 = Send a document, Follow → 4, daily check → 5, commands → 6); a line in the intro about documents.
  - `_principles.md`: review the project description ("carries fanfics from AO3") so it mentions documents.
  - `docs/specs/02-retry-queue/requirements.md` "Out of scope": update the feature numbers it cites (Follow → 4, daily check → 5, commands → 6).

## Manual verification (before closing the feature)

- [x] Send an **EPUB**, a **MOBI** and a **PDF**: all three arrive in `/mnt/us/documents/books/`, not in `…/books/AO3/`, and open in KOReader (acceptance criterion 1).
- [x] Send the same file again: the question appears; "Cancel" leaves it untouched; "Replace" overwrites it, and KOReader keeps the reading position (acceptance criteria 8–10).
- [x] Tap a button after 10 minutes, and after restarting the daemon: "no longer pending" (acceptance criterion 11).
- [x] With a question pending, share an AO3 link: the fic is delivered normally (acceptance criterion 12).
- [x] Send `Dune: Messiah.epub`, `Corazón.pdf` and `it's.pdf`: check the names on the Kindle with `ls` over SSH, and that sending each one a second time triggers the question (the check finds them under the same name) (acceptance criteria 5–7).
- [x] Send a `.azw3` and a `.jpg`: rejected, the reply lists EPUB, MOBI, PDF (acceptance criterion 3).
- [x] Send a file > 20 MB: "too big", nothing downloaded (acceptance criterion 4).
- [x] Send a ~20 MB PDF: it arrives within `uploadTimeoutMs`. If it does not, raise the default and note it in research.md.
- [x] With the Kindle asleep, send a document: "unreachable, send it again", nothing downloaded, nothing in the queue (acceptance criterion 13).
- [x] Change `documentFolders` to `{ "epub": "/mnt/us/documents/books/", "pdf": "/mnt/us/documents/pdfs" }` (create the folder first), restart: the PDF goes to `pdfs/` and a MOBI is rejected, with no code change (acceptance criterion 18). Then put `"PDF"` as a key: the daemon does not start and the log names it (acceptance criterion 19).
- [x] Search the daemon's log for the bot token after all of the above: no match (acceptance criterion 15).
