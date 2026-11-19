# Requirements — Feature 3: Document Send

See the [project principles](../_principles.md), the [feature 1 spec](../01-standalone-send/requirements.md) and the [feature 2 spec](../02-retry-queue/requirements.md), which this feature builds on. The findings behind each decision are in [research.md](./research.md).

## Goal

A file (EPUB, MOBI or PDF) sent to the Telegram bot ends up on the Kindle, in the folder the config assigns to its format (by default `/mnt/us/documents/books/`, separate from the fics' folder), and the bot confirms delivery or reports the error. If a file with the same name already exists on the Kindle, the bot asks the owner before replacing it. No retries: if the Kindle is unreachable, the error is reported and the owner sends the file again.

## Decisions made (2026-11-19)

- **Formats:** EPUB, MOBI and PDF by default, validated by extension only. AZW3 is out of the default (KOReader does not read it).
- **Size:** up to 20 MB, the official Bot API download limit. No self-hosted Bot API server.
- **Formats and destination come from one config field, `documentFolders`:** a map from extension to folder on the Kindle. Its keys are the accepted formats; each value is where that format goes. The default sends `epub`, `mobi` and `pdf` to `/mnt/us/documents/books/`. Documents do **not** go to `remotePath`, which is the fics' folder (in the owner's config, `…/books/AO3/`).
  - _Changed 2026-11-19, twice: first it was decided to reuse `remotePath`; then a single `documentsRemotePath`; finally the map, so that adding a format, removing one, or sending one format to its own folder is a config edit and never a code change._
- **Existing file:** warn and ask for confirmation ("Replace" / "Cancel"), which expires after 10 minutes.
- **Kindle unreachable:** report, no retry. Documents never go into feature 2's queue.
- **One file per message.**
- **No new timeout fields:** the Telegram download uses `downloadTimeoutMs`; the existence check uses `sshConnectTimeoutSec` and `uploadTimeoutMs`. The only new config field is `documentFolders`.

## Scope

- One document per message. Messages and button taps are processed **one at a time**, in arrival order (grammY's long polling), as in feature 1.
- A single recipient (the owner's Telegram ID).
- The AO3 link flow (features 1 and 2) does not change.

## Requirements (EARS)

### R1 — Owner filtering

- R1.1: When the daemon receives a document or a button tap (`callback_query`) whose `from.id` is not the owner's, the system shall ignore it without replying. (This is feature 1's R1.1 applied to the new update types; the existing `ownerOnly` middleware already covers it.)

### R2 — Document reception and validation

- R2.1: When the owner sends a message with a document, the system shall handle it in the document flow, separate from the text flow: a document never goes through AO3 link extraction, and a text message never goes through the document flow.
- R2.2: The system shall accept a document only when the extension of its `file_name`, lower-cased and without the dot, is a key of `documentFolders` (by default `epub`, `mobi`, `pdf`). The list of accepted formats shall never be hard-coded outside the config's default.
- R2.3: When the document's extension is not one of the accepted ones, or the document has no `file_name`, the system shall reply that the format is not supported, naming the accepted formats (taken from `documentFolders`), and shall not download it.
- R2.4: The system shall ignore the `mime_type` declared by the sender and shall not inspect the file's content.
- R2.5: When the document declares a `file_size` greater than 20 MB, the system shall reply that the file is too big, stating its size and the limit, without calling `getFile`.
- R2.6: When a message carries an animation (GIF or silent MP4), which Telegram also exposes as a `document`, the system shall reject it under R2.3 like any other unsupported format.
- R2.7: The system shall ignore the document's caption.

### R3 — File name on the Kindle

- R3.1: The system shall take only the base name of `file_name` (no directory parts), so that a name like `../../x.pdf` or `a/b.pdf` can never write outside the request's temporary directory.
- R3.2: The system shall replace with `_` the characters that the Kindle's FAT32 partition does not accept (`\ / : * ? " < > |` and control characters), and shall remove trailing dots and spaces.
- R3.3: The system shall keep accented letters and other Unicode letters in the name. (Unlike fics, where FanFicFare turns them into `_`.)
- R3.4: When the sanitized name is empty or has no base name left before the extension, the system shall reject the document under R2.3.
- R3.5: The system shall use the same sanitized name for the existence check, for the confirmation message, for the upload and for the delivery message.

### R4 — Checking whether the file already exists

- R4.1: Before downloading the document, the system shall check whether a file with the sanitized name exists in the document's destination folder (`documentFolders[extension]`) on the Kindle, by running `ssh … test -e '<path>'` as an async subprocess, with the same user, host, port, key, `ConnectTimeout` and `BatchMode=yes` as the upload.
- R4.2: The system shall pass the remote path to `ssh` wrapped in single quotes, with every `'` in it turned into `'\''` (POSIX quoting), because the command goes through the Kindle's shell. No character of the name may be interpreted by that shell.
- R4.3: The system shall invoke `ssh` with the configured port using the `-p` option (lowercase). (Watch the difference with `scp`, which uses uppercase `-P`; see feature 1's R5.8.)
- R4.4: Before launching `ssh`, the system shall check the SSH key with the same criterion as feature 1's R5.2, and report a configuration error without launching the subprocess if the key is not usable.
- R4.5: When `ssh` exits with 0, the system shall treat the file as existing and go to R5 (confirmation).
- R4.6: When `ssh` exits with 1, the system shall treat the file as not existing and go straight to R6 (download) and R7 (send).
- R4.7: When `ssh` exits with any other code, or does not finish within `uploadTimeoutMs`, the system shall treat it as a send failure (Kindle unreachable), notify the owner, and not download the document.
  - _Unlike `scp` (feature 1's R5.7), here exit codes 0 and 1 do carry meaning: they come from `test`, not from SSH. Everything else, including SSH's own 255, is a failure._
- R4.8: When the `ssh` subprocess cannot be launched (`error` event from `spawn`), the system shall report a configuration error naming the binary.

### R5 — Confirmation before overwriting

- R5.1: When the file already exists on the Kindle, the system shall send the owner a message saying that a file with that name already exists, with two inline buttons: "Replace" and "Cancel".
- R5.2: The system shall not download the document while waiting for the answer. It shall keep in memory only what is needed to continue (`file_id` and the sanitized name), identified by a short id.
- R5.3: The buttons' `callback_data` shall contain only that short id and the chosen action, never the file name, and shall be at most 64 bytes.
- R5.4: The document handler shall return after asking. It shall not wait for the answer, so that the bot can keep processing updates, including the answer itself.
- R5.5: When the owner taps "Replace" on a pending confirmation, the system shall download the document (R6) and send it to the Kindle (R7), overwriting the existing file.
- R5.6: When the owner taps "Cancel" on a pending confirmation, the system shall reply that nothing was sent, and shall not download the document.
- R5.7: When the owner taps a button, the system shall answer the callback query (so the button stops loading on the phone), remove the buttons from the question message, and remove the pending confirmation, whatever the action.
- R5.8: When a pending confirmation has not been answered within 10 minutes, the system shall consider it expired.
- R5.9: When the owner taps a button whose confirmation is expired, already answered, or unknown (for example, after a daemon restart), the system shall reply that the request is no longer pending and that the file should be sent again, and shall do nothing else.
- R5.10: The system shall not persist pending confirmations. A daemon restart discards them (R5.9 covers the taps that arrive afterwards).
- R5.11: While a confirmation is pending, the system shall keep handling other messages and documents normally. Each document has its own independent confirmation.

### R6 — Download from Telegram

- R6.1: The system shall download the document with `getFile` followed by an HTTPS download from Telegram's file endpoint, as async I/O that does not block the main loop, into a temporary directory of its own for the request.
- R6.2: When the download does not finish within `downloadTimeoutMs`, the system shall cancel it and treat it as a failed download.
- R6.3: When `getFile` fails, or the download returns an HTTP error, or the resulting file is zero bytes, the system shall notify the owner that the document could not be downloaded, and shall not attempt to send it.
- R6.4: When `getFile` fails because the file is bigger than the Bot API allows (the case R2.5 cannot catch when `file_size` is missing), the system shall reply with the same "file too big" message as R2.5.
- R6.5: The system shall never write the download URL (which contains the bot token) or the token itself to the log, to a message for the owner, or to an error that may end up in either. Download errors shall identify the file by its `file_path` only.

### R7 — Sending to the Kindle

- R7.1: The system shall send the document with the existing upload (feature 1's R5), to the document's destination folder (`documentFolders[extension]`), under the sanitized name.
- R7.1a: Every folder in `documentFolders` must exist on the Kindle, as `remotePath` must (feature 1's R5.9): `scp` does not create directories. If it does not exist, the send fails and is reported as a send failure.
- R7.2: When the copy finishes successfully, the system shall notify the owner of the delivery, including the file name.
- R7.3: When the copy fails because the Kindle is unreachable, the system shall notify the owner, asking them to send the file again when the Kindle is awake, and shall **not** enqueue it. (Documents never use feature 2's queue.)
- R7.4: When the copy fails because of a configuration problem (key, binary), the system shall report the configuration error, as in feature 1.
- R7.5: The system shall delete the request's temporary directory when the request ends, whether it succeeded or failed.
- R7.6: The system shall not store documents in feature 2's spool directory. (The spool's startup reconcile would delete them.)

### R8 — Configuration

- R8.1: The system shall accept a new **optional** config field, `documentFolders`: a JSON object whose keys are file extensions and whose values are folders on the Kindle.
  ```json
  "documentFolders": {
    "epub": "/mnt/us/documents/books/",
    "mobi": "/mnt/us/documents/books/",
    "pdf":  "/mnt/us/documents/books/"
  }
  ```
- R8.2: When `documentFolders` is absent, the system shall use the default above.
- R8.3: When `documentFolders` is present, it shall **replace** the default as a whole (it is not merged with it). This is what makes it possible to remove a format: leaving it out of the object.
- R8.4: The system shall validate `documentFolders` when loading the config and, following feature 1's R6.4, shall not start and shall name the exact entry when:
  - it is not an object, or it is an empty object (there would be no accepted format);
  - a key is not a lower-case extension without a dot (only `a-z` and `0-9`): `"PDF"` and `".pdf"` are errors, not silently fixed, so the config never has two spellings of the same format;
  - a value is not a non-empty string, or is not an absolute path (it must start with `/`).
- R8.5: When a folder in `documentFolders` does not end with `/`, the system shall add it when loading, so that the remote path is always built the same way.
- R8.6: Adding a format, removing one, or changing its folder shall require only editing `config.json` and restarting the daemon, with no code change.
- R8.7: `config.example.json` and the README's config table shall document the new field, its default, and the note that a format KOReader cannot open (for example AZW3) can be added but will not be readable there.

### R9 — Messages

- R9.1: Every new text for the owner shall live in `messages.ts`, in plain text (no `parse_mode`), so that a file name with `_`, `*` or `[` can never break the message.
- R9.2: The system shall acknowledge an accepted document before the existence check, so that the owner knows it is being handled.

## Out of scope for this feature

- Retrying documents when the Kindle is unreachable (possible later, since `file_id` can be reused; not now).
- Files bigger than 20 MB (would need a self-hosted Bot API server).
- AZW3 and any format other than EPUB, MOBI and PDF **in the default config**. The owner can add one to `documentFolders`; the code treats every format the same way.
- Per-format behavior (for example, converting or renaming only PDFs): every format goes through the same flow; only its folder changes.
- Checking the file's content (magic bytes) or its DRM.
- Several documents in one message (albums).
- Using the caption (as a title or a name).
- Converting between formats or editing metadata.
- "Follow" button and chapter tracking (now feature 4), daily update check (feature 5), `/list`, `/drop`, `/status` commands (feature 6).

## Acceptance criteria (Given/When/Then)

1. **Given** the owner sends a 5 MB `Libro.epub` and no file with that name exists on the Kindle, **when** the download and the `scp` succeed, **then** the file is in `/mnt/us/documents/books/` (not in the fics' folder), the bot confirms delivery with the name `Libro.epub` and no question is asked.
2. **Given** the owner sends `Report.PDF`, **when** the bot validates it, **then** it is accepted (the extension check ignores case).
3. **Given** the owner sends `book.azw3` or `photo.jpg`, **when** the bot validates it, **then** it replies that the format is not supported, naming EPUB, MOBI and PDF, and downloads nothing.
4. **Given** the owner sends a 25 MB PDF, **when** the bot reads `file_size`, **then** it replies that the file is too big (25 MB, limit 20 MB) without calling `getFile`.
5. **Given** the owner sends `Dune: Messiah.epub`, **when** it reaches the Kindle, **then** it is stored as `Dune_ Messiah.epub`, and the delivery message uses that name.
6. **Given** the owner sends `Corazón.pdf`, **when** it reaches the Kindle, **then** the name keeps the accent.
7. **Given** a file named `it's $(reboot).pdf`, **when** the existence check runs, **then** the name reaches `test -e` as a literal string and nothing in it is executed on the Kindle.
8. **Given** `Libro.epub` already exists on the Kindle, **when** the owner sends it again, **then** the bot says that it already exists and shows "Replace" and "Cancel", without downloading it yet.
9. **Given** that question, **when** the owner taps "Replace", **then** the file is downloaded and overwritten on the Kindle, the bot confirms delivery and the buttons disappear.
10. **Given** that question, **when** the owner taps "Cancel", **then** the bot says that nothing was sent, nothing is downloaded, and the buttons disappear.
11. **Given** that question, **when** the owner taps a button more than 10 minutes later, or after the daemon has restarted, **then** the bot replies that the request is no longer pending and that the file should be sent again.
12. **Given** a question is pending, **when** the owner sends an AO3 link or another document, **then** it is handled normally without waiting for the answer.
13. **Given** the Kindle is asleep, **when** the owner sends a document, **then** the existence check fails, the bot reports that the Kindle is unreachable and asks to send the file again, nothing is downloaded and nothing is enqueued.
14. **Given** the SSH key has open permissions, **when** the owner sends a document, **then** the bot reports the configuration error without launching `ssh`.
15. **Given** any download error, **when** it is logged and reported, **then** neither the log nor the message contains the bot token.
16. **Given** someone who is not the owner sends a document or taps a button, **when** the daemon receives it, **then** it does not reply at all.
17. **Given** a `config.json` without `documentFolders`, **when** the daemon starts, **then** EPUB, MOBI and PDF are accepted and go to `/mnt/us/documents/books/`, and the fics keep going to `remotePath`.
18. **Given** `documentFolders` is `{ "epub": "/mnt/us/documents/books/", "pdf": "/mnt/us/documents/pdfs" }`, **when** the owner sends a PDF and then a MOBI, **then** the PDF goes to `/mnt/us/documents/pdfs/` (trailing `/` added) and the MOBI is rejected as unsupported, with the reply naming EPUB and PDF — all without changing any code.
19. **Given** `documentFolders` has a key `"PDF"`, or a value `"books/"`, or is `{}`, **when** the daemon starts, **then** it does not start and the log names the wrong entry.
