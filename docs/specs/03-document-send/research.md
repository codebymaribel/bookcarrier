# Research — Feature 3: Document Send

Date: 2026-11-19

> Written before `requirements.md`. The scope decisions below come from a conversation with the owner on 2026-11-19.

## The idea

Today the bot only accepts AO3 links. This feature lets the owner send a **file** (an ebook or a PDF) to the bot from the phone, and the daemon copies it to the Kindle with the same `scp` path as feature 1:

```
phone ──send file──▶ Telegram bot ──getFile──▶ Bookcarrier (on your Mac) ──scp──▶ Kindle
                          ◀──────── "Delivered “name.pdf” to your Kindle." ◀───┘
```

Most of the pipeline already exists: `ownerOnly`, `uploadToKindle` (key check + `scp`), the error → message mapping and the temporary-directory lifecycle in `bot.ts`. What is new:

- the **input**: a Telegram document instead of a link;
- the **download**: Telegram's file endpoint instead of FanFicFare;
- a **check for an existing file** on the Kindle, with a **confirmation** from the owner before overwriting.

## Scope decisions (2026-11-19)

- **Size:** the official Bot API limit (20 MB, see below) is enough. No self-hosted Bot API server.
- **Formats:** **EPUB, MOBI and PDF** by default (the keys of `documentFolders`), validated by **extension only**. No magic-byte check. AZW3 was considered and **dropped**: KOReader does not read it (see "Formats on the Kindle").
- **Destination:** **not** the fics' folder. A new optional config field, `documentFolders`, maps each accepted extension to its folder on the Kindle; by default `epub`, `mobi` and `pdf` all go to `/mnt/us/documents/books/` (the owner's real `remotePath`, for the fics, points to `…/books/AO3/`). The keys of the map are also the accepted formats, so adding or removing a format, or giving one its own folder, is a config edit, not a code change.
  - _Changed 2026-11-19: first `remotePath` was reused, then a single `documentsRemotePath` was planned; the map replaced both so the feature scales without code changes._
- **Name already on the Kindle:** the bot **warns the owner and asks for confirmation** before overwriting.
- **Kindle unreachable:** the bot reports the failure and **does not retry**. This holds even though feature 2 (retry queue) will already exist when this one is built.
- **One file per message.** No albums/media groups.
- **Download timeout:** reuse `downloadTimeoutMs`. No new config field.
- **Existence-check timeout:** reuse `uploadTimeoutMs`. No new config field.
- **Confirmation expiry:** a "Replace / Cancel" question expires after **10 minutes** without an answer.
- **Order:** this becomes **feature 3**, after the retry queue. The roadmap's current 3–5 move down one place (see "Impact on existing specs").

## Telegram: receiving and downloading a document

### What the bot receives

- A file sent "as a file" arrives as `message.document`. In grammY it is handled with `bot.on("message:document", …)`, a filter separate from the current `message:text`, so the two flows do not interfere: a document never reaches `extractWorkLink`, and a text never reaches the document flow.
- The `Document` object always has `file_id` and `file_unique_id`. **`file_name`, `mime_type` and `file_size` are all optional** ("as defined by the sender"), so the design cannot assume a name or a size are present.
- **Gotcha:** when a message carries an `animation` (a GIF / silent MP4), Telegram *also* sets `document` "for backward compatibility". So `message:document` also fires for GIFs. The extension check rejects them anyway (`.mp4` and `.gif` are not accepted), but it is worth having a test for it.
- A document forwarded from another chat or channel still has `from.id` = the owner (the one who forwarded it), so `ownerOnly` keeps working without changes.
- The optional `caption` (text typed next to the file) is available but **not used** in this feature.

### Downloading it

- Two steps: `getFile(file_id)` returns a `File` with a `file_path`; the bytes are at `https://api.telegram.org/file/bot<token>/<file_path>`.
- **Limit: bots can download files of up to 20 MB** with the official Bot API ("for the moment", per the docs). Only a self-hosted Bot API server lifts it, which the scope decision rules out. The exact error text for a bigger file is on the "to test by hand" list.
- The link is valid for **at least one hour**; if it expires, calling `getFile` again gives a new one. The `file_id` itself stays valid much longer, so the bot can download the file **after** the owner confirms the overwrite, without holding it on disk while waiting (see "Confirming an overwrite").
- **Security:** the download URL contains the **bot token**. It must never be logged, never be put in an error message shown to the owner, and never appear in a stack trace that ends up in the log. Errors from the download step must be built with a sanitized message (the `file_path`, never the full URL).
- **Timeout:** `AbortSignal.timeout(downloadTimeoutMs)` (10 min by default, far more than 20 MB needs). Decided: no separate field.

### Options for the download code

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. `ctx.getFile()` + native `fetch`** | `getFile`, build the URL, `fetch` with `AbortSignal.timeout(…)`, stream to disk with `stream/promises.pipeline` + `Readable.fromWeb` | No new dependency (principle: minimal stack). Full control over the timeout and over keeping the token out of errors. Easy to fake in tests (inject `fetch`). | About 40 lines of our own code. |
| B. `@grammyjs/files` plugin | `bot.api.config.use(hydrateFiles(token))`, then `file.download(path)` | Less code, official grammY plugin. | New dependency for a single call. Its errors are not ours: we would have to check that none carries the URL with the token. It needs `FileFlavor` types on the context, which touches `createBot`'s types. |
| C. Self-hosted Bot API server | `telegram-bot-api` binary running on the Mac | Files up to 2 GB. | One more process to install, keep alive and add to launchd. Discarded: 20 MB is enough. |

**Proposed decision:** option **A**. It follows the project's pattern (thin wrappers we control, like `downloader.ts` and `uploader.ts`), adds no dependencies, and makes the "token never leaks" rule explicit in our own code instead of trusting a library.

### Checking the size before downloading

When `document.file_size` is present and over 20 MB, the bot can reject the file **before** calling `getFile`, with a clear message ("the file is X MB, the limit is 20 MB"). When `file_size` is missing, the `getFile` error is the fallback and has to map to the same message.

## Formats on the Kindle: who opens what

The Kindle has **two readers**, and they do not support the same formats. The owner reads with KOReader, so a format KOReader can open is required.

| Format | KOReader | Native Kindle reader | In scope |
|---|---|---|---|
| EPUB | ✔ | ✘ (only through Amazon's Send to Kindle, which converts it) | ✔ |
| PDF | ✔ | ✔ | ✔ |
| MOBI | ✔ | ✔ | ✔ |
| AZW3 (KF8) | **Not listed** | ✔ | ✘ dropped |

- KOReader's README lists: "fixed page formats (PDF, DjVu, CBT, CBZ) and reflowable e-book formats (EPUB, FB2, Mobi, DOC, RTF, HTML, CHM, TXT)". **AZW3 is not on the list**, and r/koreader users report that it does not open. A secondary site claims the opposite; we do not trust it.
- **Decision (2026-11-19):** AZW3 is dropped and EPUB takes its place. An AZW3 would only open in the native reader, which also does not re-index its library after an `scp` (see feature 2's research). All three formats in scope open in KOReader, which walks the filesystem and needs no refresh.
- **DRM:** a MOBI with DRM will not open in KOReader. Out of scope: the bot copies the file and does not inspect it.

## Validating by extension

- Accepted extensions: the keys of `documentFolders` (by default `epub`, `mobi`, `pdf`). The code never hard-codes the list.
- Compare in **lower case**: `.PDF` and `.Mobi` must be accepted.
- Take the extension from `file_name`. If `file_name` is missing, the file cannot be validated by extension, so it is rejected with the "unsupported format" message. (Telegram almost always sends the name for documents, but it is optional in the API.)
- The sender's `mime_type` is ignored: it is optional and not reliable ("as defined by the sender").
- No content check (magic bytes), by decision. A `.pdf` that is not a PDF reaches the Kindle and fails to open there; that is acceptable for a personal tool.

## The file name on the Kindle

Unlike fics, there is no FanFicFare to name and sanitize the file: the name comes from the sender's `file_name`. That brings two problems, plus the overwrite question, which gets its own section.

### 1. Path traversal (local)

`file_name` is user-controlled text. Joined with `join(tempDir, file_name)`, a name like `../../.ssh/authorized_keys` or `a/b.pdf` would write outside the temporary directory. Even though only the owner can send files, the rule should be: **use the base name only** (`path.basename`), and reject names that are empty or only dots.

### 2. Characters the Kindle filesystem does not accept

The Kindle's user partition (`/mnt/us`, which is what USB exposes) is **FAT32/vfat**. FAT does not accept `\ / : * ? " < > |`, control characters, or names that end in a dot or a space. A name with `:` (common in book titles: "Dune: Messiah.epub") could make `scp` fail on the Kindle side with an error that looks like a delivery failure.

**Proposed decision:** replace only the characters FAT forbids with `_`, trim trailing dots and spaces, and **keep accents and other Unicode letters**. This is better than what FanFicFare does with fics (`Corazón` → `Coraz_n`), and it fixes that known limitation for documents. Whether the Kindle stores accents correctly over `scp` has to be tested by hand (it depends on the `iocharset`/`utf8` the partition is mounted with).

The **sanitized** name is the one used everywhere: in the existence check, in the confirmation message and for the upload. Otherwise the check could look for `Dune: Messiah.epub` while the upload writes `Dune_ Messiah.epub`.

### Note on `scp` and odd names

Since OpenSSH 9.0, `scp` uses the SFTP protocol by default, so the remote file name does not go through a shell on the Kindle. With the legacy protocol (`-O`) the remote *destination* is interpreted by the remote shell, but in our `scp` call the destination is only the destination folder (`documentFolders[ext]`) (a directory from the config), and the file name travels inside the protocol. For the upload, sanitizing the name is enough. **The existence check is different** (see below).

## Confirming an overwrite

Decision: if a file with the same (sanitized) name already exists in the destination folder (`documentFolders[ext]`), the bot warns the owner and asks before replacing it. This needs three pieces that do not exist today.

### 1. Knowing whether the file exists on the Kindle

`scp` cannot answer "does this exist?". Options:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. `ssh` + `test -e`** | `spawn('ssh', [...same -p/-i/-o as scp..., 'user@host', 'test -e <quoted path>'])`. Exit 0 = exists, 1 = does not exist, 255 = SSH failure | One short subprocess, same key and options as the uploader, and the same `spawn` pattern. `test` is in busybox, which the Kindle has. | The remote command **does go through the Kindle's shell**: the path has to be shell-quoted (see below). |
| B. `sftp` in batch mode | `sftp -b -` with `ls <path>` on stdin | No remote shell involved. | Its exit codes and output are harder to read; it needs `sftp-server` on the Kindle (KOReader's SSH server is dropbear, which may not ship it). |
| C. List the folder | `ssh … ls <folder>` and look for the name in the output | One call could also serve a future `/list`. | Parsing `ls` output, with Unicode names, is fragile. |

**Proposed decision:** option **A**, with three rules:

- **Quoting:** wrap the full remote path in single quotes and turn every `'` in it into `'\''`. This is the standard POSIX technique and the only way to make a name like `it's.pdf` or `$(rm -rf).pdf` safe. The FAT sanitization already removes several dangerous characters, but not `'`, `$` or `` ` ``, so quoting is required anyway. It must have its own tests with hostile names.
- **Exit codes:** with `ssh`, unlike `scp`, the exit code *does* carry meaning: 0 and 1 come from `test`, 255 from SSH itself (unreachable Kindle, auth failure). 255 is treated exactly like an upload failure: "Kindle unreachable", no retry.
- **Bonus:** the check runs **before** the download, so an asleep Kindle is detected right away, without downloading 20 MB from Telegram for nothing.

The key check (`assertKeyUsable`) and the SSH options (`-p`/`-P`, `ConnectTimeout`, `BatchMode`) should be shared between `ssh` and `scp`. **Careful:** `ssh` takes the port with lowercase `-p`, while `scp` takes uppercase `-P` (the uploader already has a comment about this trap).

### 2. Asking the owner: inline buttons

- grammY's `InlineKeyboard` with two buttons, "Replace" and "Cancel". The owner's tap arrives as a `callback_query`, handled with `bot.callbackQuery(...)`.
- `ownerOnly` already covers it: callback queries carry `from.id`.
- **`callback_data` is limited to 64 bytes.** The file name cannot go in it (it can be longer, and Unicode takes several bytes per character). It carries a short id instead (`ow:<id>:yes` / `ow:<id>:no`), and the data lives in memory.
- The callback has to be answered (`answerCallbackQuery`) so the button stops spinning on the phone, and the original message can be edited to remove the buttons once answered.
- This is the project's **first** use of inline buttons. Feature 4 ("Follow" button) will need the same mechanism, so it is worth building it in a way the next feature can reuse.

### 3. Waiting without blocking the bot

- grammY's long polling processes updates **one at a time**. If the document handler `await`ed the owner's answer, the bot would be blocked: the answer itself (a `callback_query`) is an update that could never be processed. The flow therefore has to be **split in two**:
  1. **`message:document`:** validate → check existence. If the file does not exist, download and send right away. If it does, store a pending entry and ask; the handler returns.
  2. **`callbackQuery`:** look up the pending entry by id. "Replace" → download + send. "Cancel" → say so. In both cases, remove the entry.
- **The pending entry holds only `file_id` + the sanitized name**, not the file. The download happens after the confirmation (possible because `file_id` stays valid), so there are no files on disk while waiting and nothing to clean up if the owner never answers.
- **Pending state in memory** (`Map<id, PendingOverwrite>`), not persisted. If the daemon restarts, a tap on an old button finds no entry, and the bot answers "this request expired, send the file again". This is acceptable for a personal tool and keeps the queue's JSON state out of this feature.
- **Expiry: 10 minutes** (decided 2026-11-19). An entry with no answer must not live forever. How to implement it is left to `design.md`: one `setTimeout` per entry, or a check of its age when the button is tapped (no timer, but expired entries stay in memory until then).
- **Race condition, accepted:** between the check and the upload, the file could change on the Kindle. This is ignored; the only one writing there is the owner.

## Interaction with feature 2 (retry queue)

Feature 2 will be implemented first, so this feature builds on top of its changes:

- **Error classification (`errors.ts`)** can be reused as is for the upload: `UploadConfigError` → permanent (report), `UploadFailedError` → transient. The difference is what happens with a transient one: fics are enqueued, **documents are not** (decision). Instead, the bot reports the failure and asks the owner to send the file again. The new existence check (`ssh`) has to be classified the same way: 255 → transient (reported, not enqueued); missing key or binary → permanent.
- **The queue is not touched.** `QueueItem` has `url` and a `download` stage that are AO3-specific; documents do not go into it. That keeps feature 2's design intact.
- **The spool is not used.** The document goes to a per-request temporary directory, removed in a `finally`, as in feature 1 today. Bonus: the spool's `reconcile` (R5.3 of feature 2) deletes every `*.epub` not referenced by the queue; if documents used the spool, that reconcile would delete them. With a temporary directory there is no conflict.
- **Possible future improvement (not now):** Telegram's `file_id` can be used again later to download the same file, so retrying a document would only mean storing its `file_id` and calling `getFile` again. That would make a future "documents in the queue" cheap, if the decision changes.

## Timeouts

- **Download from Telegram:** `downloadTimeoutMs` (decided).
- **Existence check:** `sshConnectTimeoutSec` for the connection, plus `uploadTimeoutMs` as the safety-net timeout (decided).
- **Upload:** `uploadTimeoutMs` is 2 minutes. A 20 MB file over the Kindle's WiFi at ~200 KB/s takes ~100 s, close to the limit, and at the speeds seen in KindleMOD's worst case it would not fit. To be measured by hand with a real 20 MB PDF; if it does not fit, raise the default (it is one value in `config.ts`).

## Proposed shape (for `design.md`, not decided yet)

- `src/telegram-file.ts`: `downloadTelegramFile(fileId, destDir, opts)`. Does `getFile` + `fetch` + stream to disk, and builds errors without the token.
- `src/document.ts`: `validateDocument(doc)` returns `{ ok: true, safeName } | { ok: false, reason: 'unsupported-format' | 'too-big' | 'no-name' }` (extension list, size, name sanitization).
- `src/remote-exists.ts` (or inside `uploader.ts`): `existsOnKindle(name, opts)` returns `Promise<boolean>`, using `ssh` + `test -e` with POSIX quoting; it shares the key check and the SSH options with `uploadToKindle`.
- `src/pending.ts`: an in-memory store of pending confirmations (`add`, `take`, expiry).
- `bot.ts`: two new handlers, `message:document` and `callbackQuery`, reusing the `say` / temp-dir / `upload` / `failureMessage` structure. The shared part (temp dir + download + upload + messages) can be extracted to one helper, called both from the direct path and from "Replace".
- `messages.ts`: new texts (`docAck`, `unsupportedFormat`, `tooBig`, `alreadyExists`, `overwriteCancelled`, `confirmationExpired`, `docDelivered`, `docSendFailed` — "send the file again when it is awake").
- Tests follow the existing pattern: fakes for Telegram's API, `fetch` and the `ssh`/`scp` subprocesses; no network and no Kindle. Specific tests are needed for quoting with hostile names and for the "Replace" / "Cancel" / expired / unknown-id paths.

## Impact on existing specs

- **Roadmap (README and README.es):** "Follow" button → 4, daily check → 5, commands → 6. The new 3 is "Send a document".
- **`_principles.md`:** "Out of scope: sites other than AO3" still holds (this is not a site), but the project description ("carries fanfics from AO3") will need a line about documents. Worth reviewing when closing requirements.
- **README "Using it" table:** new rows for a document (accepted, wrong format, too big, already exists → confirm).
- **Config (`config.ts`, `config.example.json`, README config table):** new optional field `documentFolders` (extension → folder), default `epub`/`mobi`/`pdf` → `/mnt/us/documents/books/`. This reopens `config.ts`, which feature 2 had treated as closed.
- **Future feature 4 ("Follow" button):** it will be able to reuse the inline-keyboard and callback handling built here.

## To test by hand (not internet research)

- [ ] An **EPUB**, a **MOBI** and a **PDF** copied with `scp` to `/mnt/us/documents/books/`: all three open in KOReader, and they do not mix with the fics in `…/books/AO3/`.
- [ ] `ssh … 'test -e <path>'` against the Kindle (dropbear + busybox): confirm exit 0 / 1 for a file that exists / does not exist, and 255 with the Kindle asleep.
- [ ] A file with **accents** in its name (`Corazón.pdf`): does the name survive on the Kindle's vfat partition, and does `test -e` find it under that same name?
- [ ] A file with **`:`** in its name, without sanitizing: confirm it fails, so the sanitization is justified with evidence.
- [ ] A file with **`'`** in its name (`it's.pdf`): the existence check works with the quoting.
- [ ] A **~20 MB PDF**: time the `scp` against `uploadTimeoutMs` (2 min).
- [ ] A file **> 20 MB** sent to the bot: confirm that `file_size` comes in the update, and the exact text of `getFile`'s error.

## Open points

None. All scope questions were closed on 2026-11-19; the research is ready for `requirements.md`. The "to test by hand" items above can still change details of the design (for example, raising the `uploadTimeoutMs` default).

## Sources

- Telegram Bot API — `Document`, `Message.animation`, `getFile`, `InlineKeyboardButton.callback_data` (1–64 bytes): https://core.telegram.org/bots/api (the 20 MB limit and the 1-hour link are also quoted by https://docs.aiogram.dev/en/latest/_modules/aiogram/methods/get_file.html)
- grammY — file handling and self-hosted Bot API: https://grammy.dev/guide/files
- grammY — files plugin (`hydrateFiles`, `download`, `getUrl`): https://grammy.dev/plugins/files
- KOReader README — supported formats: https://github.com/koreader/koreader
- r/koreader — user report that AZW3 does not open: https://libreddit.winscloud.net/r/koreader/comments/1jg1bbo/recently_converted_my_kindle_paperwhite_to_a
- Kindle File Format (KF8 = AZW3): https://www.wikipedia.org/wiki/KF8
