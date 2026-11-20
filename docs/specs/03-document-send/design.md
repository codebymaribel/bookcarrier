# Design — Feature 3: Document Send

See [requirements.md](./requirements.md) and [research.md](./research.md).

**Prerequisite:** feature 2 is implemented. This design builds on feature 1's modules as they are today, and on feature 2's error classification (`errors.ts`). Where feature 2 changes a signature this design depends on, the section says so.

## Decisions from the research

- The document is downloaded with grammY's `getFile` + Node's native `fetch` (option A in research.md). **No new dependency.**
- The existence check is `ssh … test -e '<path>'`, with POSIX single-quote quoting (option A in research.md).
- The owner confirms an overwrite with inline buttons. The flow is split in two handlers (document, button tap) so that the bot never waits for a human.
- A pending confirmation keeps only `file_id` + name + folder, **in memory**. The file is downloaded after the confirmation, never before.
- Formats and their folders come from one config map, `documentFolders`. No format is hard-coded outside its default.
- Documents never touch feature 2's queue or spool.

## Flow

```
message:document
  │
  ├─ validateDocument(doc, folders) ── unsupported / too big ──▶ reply, end
  │        │ ok: { safeName, folder }
  ├─ reply docAck
  ├─ existsOnKindle(folder + safeName) ── failure ──▶ reply (unreachable / config), end
  │        │
  │        ├─ false ──▶ deliverDocument(...) ──▶ reply delivered / failure, end
  │        │
  │        └─ true ──▶ pending.add(...) → id
  │                    reply alreadyExists(safeName) + [Replace] [Cancel]   ← handler returns here
  │
callbackQuery "ow:<id>:y" / "ow:<id>:n"
  │
  ├─ answerCallbackQuery, remove the buttons (always)
  ├─ pending.take(id) ── missing / expired ──▶ reply confirmationExpired, end
  │        │
  │        ├─ "n" ──▶ reply overwriteCancelled, end
  │        └─ "y" ──▶ deliverDocument(...) ──▶ reply delivered / failure, end
```

`deliverDocument` = temporary directory → `downloadTelegramFile` → `uploadToKindle` → delete the directory in a `finally`. It is the single path to the Kindle, used both from the direct case and from "Replace".

## Modules

```
src/
  config.ts          # CHANGED: new documentFolders field (validated, resolved to a Map)
  ssh.ts             # NEW: SSH options and key check shared by scp and ssh; shellQuote; existsOnKindle
  uploader.ts        # CHANGED: uses ssh.ts for the key check and the common options (no behavior change)
  document.ts        # NEW: validateDocument, sanitizeFileName
  telegram-file.ts   # NEW: downloadTelegramFile (getFile + fetch → disk), errors without the token
  pending.ts         # NEW: in-memory store of pending confirmations, with lazy expiry
  document-flow.ts   # NEW: the document flow (orchestration), the equivalent of createRequestHandler
  messages.ts        # CHANGED: new texts + documentFailureMessage()
  bot.ts             # CHANGED: registers message:document and callbackQuery
```

The document flow lives in its own module (`document-flow.ts`) instead of growing `bot.ts`: after feature 2, `bot.ts` will already carry the queue orchestration, and the two flows share nothing beyond `ownerOnly` and the upload.

### `config.ts`

```ts
type Config = {
  // ...existing fields
  documentFolders?: Record<string, string>;   // as written in the JSON
};

type ResolvedConfig = Omit<Required<Config>, "documentFolders"> & {
  documentFolders: ReadonlyMap<string, string>;   // extension → folder, always ending in "/"
};

CONFIG_DEFAULTS.documentFolders = {
  epub: "/mnt/us/documents/books/",
  mobi: "/mnt/us/documents/books/",
  pdf: "/mnt/us/documents/books/",
};
```

- **Why a `Map` and not the plain object.** With a plain object, a lookup like `folders[ext]` for a file named `x.constructor` would return `Object.prototype.constructor` (a function, truthy) and the file would be "accepted". A `Map` only has the keys the owner wrote. The parsing turns the JSON object into a `Map`, and nothing downstream ever sees the object.
- `ResolvedConfig` stops being exactly `Required<Config>` because of this field. `RequestConfig` in `bot.ts` is a `Pick` of other keys, so it is not affected.
- New helper `parseDocumentFolders(raw, problems): ReadonlyMap<string, string>`, following the file's pattern (collect every problem, do not throw on the first one):
  - absent → the default (R8.2);
  - present → replaces the default as a whole, never merged (R8.3);
  - not an object, or `{}` → problem `"documentFolders" must be a non-empty object …`;
  - key not matching `/^[a-z0-9]+$/` → problem naming the key, e.g. `documentFolders: key "PDF" must be a lower-case extension without a dot` (R8.4);
  - value not a non-empty string, or not starting with `/` → problem naming the key (R8.4);
  - a value without a trailing `/` gets one added (R8.5).

### `ssh.ts`

Everything `scp` and `ssh` have in common, so the two cannot drift apart.

```ts
/** Who and how to connect: what both subprocesses need. */
export type SshTarget = {
  sshKeyPath: string;
  kindleUser: string;
  kindleHost: string;
  port: number;
  connectTimeoutSec: number;
  timeoutMs: number;
};

export const SSH_BIN = "ssh";

/** Moved from uploader.ts, unchanged (feature 1's R5.2). */
export async function assertKeyUsable(keyPath: string): Promise<void>;

/** ["-o", "ConnectTimeout=N", "-o", "BatchMode=yes", "-i", key]. The port is NOT here: see below. */
export function commonSshArgs(target: SshTarget): string[];

/** POSIX single-quote quoting: wraps in '…' and turns every ' into '\''. */
export function shellQuote(value: string): string;

/** true = the path exists (exit 0), false = it does not (exit 1). Anything else rejects. */
export async function existsOnKindle(remoteFilePath: string, target: SshTarget): Promise<boolean>;
```

- **The port flag stays at each call site** and is not part of `commonSshArgs`: `scp` uses `-P` and `ssh` uses `-p`. Putting it in the shared helper is exactly how one of the two ends up with the wrong letter. Each wrapper has a test asserting its own letter.
- `existsOnKindle` spawns `ssh -p <port> <commonSshArgs> user@host test -e <shellQuote(remoteFilePath)>`. The remote command is **one argument** to `ssh`, already quoted. The quoting is not for the local side (`spawn` does not use a shell); it protects the **remote** shell (R4.2).
- Exit codes (R4.5–R4.7): `0` → `true`, `1` → `false`, any other code or a signal → `UploadFailedError("exit-code")`, timeout → `UploadFailedError("timeout")`, `error` event → `UploadConfigError("binary-not-found")` naming `ssh` (R4.8). The key is checked first with `assertKeyUsable` (R4.4).
- **Reusing the upload errors** (`UploadConfigError`, `UploadFailedError`) instead of creating new ones is deliberate: for the owner, "the check failed" and "the copy failed" mean the same thing (the Kindle is unreachable or the config is broken), and feature 2's `errors.ts` already classifies them. The cost is a slightly inaccurate class name; we accept it rather than duplicate the classification.

### `uploader.ts`

- `assertKeyUsable` and the common options move to `ssh.ts`. `UploadOptions` stays as it is (it is structurally compatible with `SshTarget` plus `remotePath`).
- No behavior change: the existing tests must pass unchanged. This is the "no refactor beyond what is needed" rule: the move is needed so `ssh` and `scp` share one key check.
- `scp` uses the **local** file's base name as the remote name. So the document must be written locally **under its sanitized name** (`join(tempDir, safeName)`); otherwise the Kindle would receive a different name than the one checked and confirmed (R3.5).

### `document.ts`

```ts
/** Telegram's limit for bots downloading files (official Bot API). Not config: it is Telegram's, not ours. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export type DocumentInfo = { file_name?: string; file_size?: number };   // slice of grammY's Document

export type DocumentCheck =
  | { ok: true; safeName: string; extension: string; folder: string }
  | { ok: false; reason: "unsupported-format" }
  | { ok: false; reason: "too-big"; sizeBytes: number };

export function validateDocument(doc: DocumentInfo, folders: ReadonlyMap<string, string>): DocumentCheck;

export function sanitizeFileName(name: string): string | undefined;
```

`validateDocument`, in this order:

1. No `file_name` → `unsupported-format` (R2.3).
2. `sanitizeFileName(file_name)` → `undefined` → `unsupported-format` (R3.4).
3. Extension: `extname(safeName)` without the dot, lower-cased. Not in `folders` (`Map.has`) → `unsupported-format` (R2.2). An animation (`.mp4`, `.gif`) falls here (R2.6).
4. `file_size` present and `> MAX_DOWNLOAD_BYTES` → `too-big` (R2.5).
5. Otherwise `ok`, with `folder = folders.get(extension)`.

The size goes after the format on purpose: a 30 MB `.zip` should say "unsupported format", not "too big".

`sanitizeFileName`:

1. Keep only the part after the last `/` **or** `\` (R3.1). `path.basename` on macOS only splits on `/`, and a name with `\` would be a FAT-illegal character anyway, but splitting on both gives the same result on any platform.
2. Replace `\ / : * ? " < > |` and control characters (`\u0000`–`\u001f`, `\u007f`) with `_` (R3.2).
3. Remove trailing dots and spaces (R3.2).
4. Return `undefined` if what is left is empty, or if its part before the extension is empty or only dots and spaces (`.pdf`, `..pdf`) (R3.4).
5. Accents and other Unicode letters are left untouched (R3.3). The string is normalized to **NFC**: macOS and iOS may send `ó` as `o` + combining accent (NFD), and the same visible name in two forms would make `test -e` miss an existing file.

### `telegram-file.ts`

```ts
export type TelegramFileDeps = {
  getFile: (fileId: string) => Promise<{ file_path?: string }>;   // bot.api.getFile in production
  fetch: typeof fetch;
};

export class TelegramFileTooBigError extends Error {}

export class TelegramDownloadError extends Error {
  readonly reason: "get-file" | "no-path" | "http" | "timeout" | "network" | "empty";
}

/** Downloads a Telegram file to `destPath`. Never puts the token or the URL in an error. */
export async function downloadTelegramFile(
  fileId: string,
  destPath: string,
  opts: { token: string; timeoutMs: number },
  deps: TelegramFileDeps,
): Promise<void>;
```

- Steps: `getFile` → `file_path` (missing → `no-path`) → URL `https://api.telegram.org/file/bot<token>/<file_path>` → `fetch(url, { signal: AbortSignal.timeout(timeoutMs) })` → status not 2xx → `http` (with the status code) → `pipeline(Readable.fromWeb(body), createWriteStream(destPath, { flags: "wx" }))` → `stat` size 0 → `empty` (R6.1–R6.3).
- `"wx"` makes the write fail if the file already exists: inside a fresh temporary directory it never should, and if it does it is a bug, not something to overwrite silently.
- **The token rule (R6.5) is enforced by construction.** Every error is built here with a message that names only `file_path` and, for network failures, only the error's `name`/`code` (`ECONNRESET`, `AbortError`). The original error is **not** attached as `cause`: the logger prints errors whole, and a `fetch` error's `cause` could carry the URL. A test sends each failure through the real logger's formatter and asserts the token is not in the output.
- **Too big (R6.4):** when `getFile` rejects with a `GrammyError` whose description says the file is too big, `TelegramFileTooBigError` is thrown, which maps to the same message as R2.5. The exact text has to be confirmed by hand (research.md); the match is done in one small function, `isTooBigError(err)`, so it is a one-line fix if the text differs.
- The timeout covers both `getFile` and the transfer (one `AbortSignal` for the whole call).

### `pending.ts`

```ts
export type PendingOverwrite = { fileId: string; safeName: string; folder: string };

export type PendingStore = {
  /** Stores an entry and returns its short id. Drops expired entries first. */
  add(entry: PendingOverwrite): string;
  /** Removes and returns the entry; undefined if it never existed, was taken, or expired. */
  take(id: string): PendingOverwrite | undefined;
};

export function createPendingStore(opts: { ttlMs: number; now?: () => number; newId?: () => string }): PendingStore;
```

- `Map<string, { entry, createdAt }>`. `ttlMs` = 10 minutes (R5.8), a constant in `document-flow.ts` (not config: it was not asked to be configurable).
- **Expiry without timers:** `take` refuses an entry older than `ttlMs` (R5.9), and `add` sweeps out expired entries. Zero work at rest and no timer to cancel, in line with the principle "no unnecessary polling". Memory is bounded by how many documents the owner sends in 10 minutes.
- `take` removes the entry whatever happens next, so a double tap on "Replace" delivers once and the second tap gets `confirmationExpired` (R5.7, R5.9).
- Ids: `randomBytes(6).toString("base64url")` (8 characters, `[A-Za-z0-9_-]`). Injectable (`newId`) for tests.
- Not persisted (R5.10).

### `document-flow.ts`

```ts
export type DocumentConfig = Pick<
  ResolvedConfig,
  | "telegramToken" | "documentFolders" | "downloadTimeoutMs" | "uploadTimeoutMs"
  | "sshConnectTimeoutSec" | "kindlePort" | "sshKeyPath" | "kindleUser" | "kindleHost"
>;

export type DocumentDeps = {
  exists: typeof existsOnKindle;
  download: (fileId: string, destPath: string) => Promise<void>;   // downloadTelegramFile, bound
  upload: typeof uploadToKindle;
  pending: PendingStore;
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  logger: Logger;
};

/** What the flow needs from the chat, so tests need no grammY context. */
export type ChatIO = {
  reply: (text: string) => Promise<unknown>;
  askOverwrite: (text: string, id: string) => Promise<unknown>;   // reply with the two buttons
};

export function createDocumentFlow(config: DocumentConfig, overrides?: Partial<DocumentDeps>): {
  onDocument(doc: DocumentInfo & { file_id: string }, io: ChatIO): Promise<void>;
  onDecision(id: string, action: "replace" | "cancel", io: ChatIO): Promise<void>;
};
```

- Same shape as `createRequestHandler`: dependencies injectable, both functions **never throw** (every failure becomes a message plus a log line), and a failed Telegram send is logged and ignored (`say`).
- `onDocument` follows the flow diagram above. When the file exists, it calls `pending.add` and `askOverwrite`, and **returns** (R5.4).
- `onDecision` only does `pending.take` and then either replies or calls `deliverDocument` (R5.5, R5.6, R5.9).
- `deliverDocument(entry, io)`: `makeTempDir` → `download(fileId, join(dir, safeName))` → `upload(localPath, { ...uploadOptions, remotePath: folder })` → `docDelivered` / `documentFailureMessage` → `removeDir` in `finally` (R7.1–R7.5). The folder comes from the entry, so the folder chosen at validation time is the one used, even if a confirmation is answered minutes later.
- **Logs:** `fileUniqueId`, `safeName`, `extension`, `folder`, size, outcome. Never `file_id`'s download URL or the token.
- **Blocking, consciously:** "Replace" downloads and uploads inside the callback handler, so other updates wait for that transfer, exactly as in feature 1 with fics. What must never block is waiting for the owner's decision, and that is what the split prevents.
- **After feature 2:** if feature 2 changes what `uploadToKindle` rejects with (classified errors), only `documentFailureMessage` adapts. Documents treat every upload failure as "report", transient or permanent; the difference is only the text.

### `bot.ts`

```ts
bot.use(ownerOnly(config.ownerId));                 // also filters documents and callback queries (R1.1)
bot.on("message:text", …);                           // unchanged
bot.on("message:document", (ctx) => docs.onDocument(ctx.message.document, chatIO(ctx)));
bot.callbackQuery(OVERWRITE_DATA, async (ctx) => {
  await ctx.answerCallbackQuery().catch(logWarn);           // R5.7: stop the spinner
  await ctx.editMessageReplyMarkup().catch(logWarn);        // R5.7: remove the buttons
  const [, id, action] = ctx.match;
  await docs.onDecision(id, action === "y" ? "replace" : "cancel", chatIO(ctx));
});
```

- `OVERWRITE_DATA = /^ow:([A-Za-z0-9_-]{8}):(y|n)$/`. `callback_data` is `ow:<id>:y` (13 bytes, far under the 64-byte limit, R5.3). The `ow:` prefix namespaces it: feature 4's "Follow" button will use its own prefix on the same mechanism.
- A `callback_query` that does not match any pattern is answered (to stop the spinner) and otherwise ignored.
- `chatIO(ctx)` builds the `ChatIO`: `reply` = `ctx.reply`, `askOverwrite` = `ctx.reply(text, { reply_markup: new InlineKeyboard().text("Replace", "ow:<id>:y").text("Cancel", "ow:<id>:n") })`.
- `index.ts` does not change: `createBot` still receives the full config.

### `messages.ts`

New entries, plain text like the rest (R9.1):

| Key | Text (draft) | Req. |
|---|---|---|
| `docAck` | `Got it, checking your Kindle…` | R9.2 |
| `unsupportedFormat(formats)` | `I can't send that kind of file. Send me one of: EPUB, MOBI, PDF.` (list built from the config's keys, upper-cased) | R2.3 |
| `tooBig(mb)` | `That file is 25.3 MB; I can only fetch files up to 20 MB from Telegram.` (when the size is unknown: without the number) | R2.5, R6.4 |
| `alreadyExists(name)` | `“name” is already on your Kindle. Replace it?` | R5.1 |
| `overwriteCancelled(name)` | `OK, I left “name” as it was. Nothing was sent.` | R5.6 |
| `confirmationExpired` | `That request is no longer pending. Send me the file again.` | R5.9 |
| `docDelivered(name)` | `Delivered “name” to your Kindle.` | R7.2 |
| `docDownloadFailed(detail)` | `I couldn't get that file from Telegram: <detail>` | R6.3 |
| `docSendFailed(name, detail)` | `I couldn't send “name” to your Kindle (<detail>). Is it awake and on the Wi-Fi? Send me the file again when it is.` | R4.7, R7.3 |

- `uploadConfig` is reused as is for key and binary problems (R4.4, R4.8, R7.4).
- `documentFailureMessage(err, name)`: the documents' equivalent of `failureMessage`, the single place where a document failure becomes text. `TelegramFileTooBigError` → `tooBig`, `TelegramDownloadError` → `docDownloadFailed`, `UploadConfigError` → `uploadConfig`, `UploadFailedError` → `docSendFailed`, anything else → `unexpected`. A separate function (instead of more branches in `failureMessage`) because the existing texts talk about fics and titles ("I downloaded “title” but couldn't send it… share the link again").

## Error handling, summarized

| Where | What happens | Message | Downloaded? |
|---|---|---|---|
| validation | no name / sanitized away / extension not in the map | `unsupportedFormat` | no |
| validation | `file_size` > 20 MB | `tooBig` | no |
| existence check | key unusable / `ssh` not launchable | `uploadConfig` | no |
| existence check | exit ≠ 0/1, or timeout | `docSendFailed` | no |
| button | unknown, taken or expired id | `confirmationExpired` | no |
| button | "Cancel" | `overwriteCancelled` | no |
| download | `getFile` says too big | `tooBig` | no |
| download | `getFile` / HTTP / network / timeout / empty file | `docDownloadFailed` | partly, deleted |
| upload | key unusable / `scp` not launchable | `uploadConfig` | yes, deleted |
| upload | `scp` failed or timed out | `docSendFailed` | yes, deleted |
| anything else | a bug | `unexpected` (+ full log) | deleted |

In every row with a temporary directory, it is deleted in a `finally` (R7.5). Nothing is ever enqueued (R7.3).

## Testing approach

Same as features 1 and 2: Vitest, no network, no Kindle, no real Telegram.

- `config.ts`: default when absent; replace-not-merge; every invalid case of R8.4 names its entry; trailing `/` added; the resolved value is a `Map` (a `constructor` extension is not accepted).
- `document.ts`: each format, case-insensitivity, unknown format, no name, size limit, format-before-size order, path traversal (`../../x.pdf`, `a\b.pdf`), FAT characters (`Dune: Messiah.epub`), trailing dots/spaces, accents kept, NFD → NFC, names that sanitize to nothing.
- `ssh.ts`: `shellQuote` with `'`, `$()`, backticks, spaces, newlines, empty string (round-trip through a real `sh -c 'printf %s …'`, which runs locally and needs no Kindle; in its own test file, because the `existsOnKindle` tests mock `spawn`); `existsOnKindle` with `spawn` mocked (`vi.mock("node:child_process")`, the pattern `uploader.test.ts` uses for `scp`): the exact arguments, exit 0 → true, 1 → false, 255 → `UploadFailedError`, hang → timeout, missing binary → `UploadConfigError`; port is `-p`.
- `uploader.ts`: existing tests unchanged, plus one asserting the port is still `-P`.
- `telegram-file.ts`: fake `getFile` and `fetch`: success writes the bytes; each failure reason; too-big detection; **the token never appears** in any error message, its `cause`, or the formatted log line.
- `pending.ts`: add/take, take twice, expiry at 10 min with an injected clock, sweep on add.
- `document-flow.ts`: the event-order style of `bot.flow.test.ts`: not existing → delivered with no question; existing → question, no download; replace → download + upload to the right folder under the safe name; cancel; expired; Kindle unreachable on the check → nothing downloaded; temp dir always removed; a failed `reply` does not abort the delivery.
- `bot.ts`: a document from a stranger and a button tap from a stranger get no reply; the callback is answered and the buttons removed even when the id is unknown.

## What this design deliberately leaves out

- **No configurable size limit or confirmation TTL.** The size limit is Telegram's, and nobody asked for the TTL to be configurable. Both are named constants, so making them config later is a small change.
- **No per-format behavior.** `documentFolders` only chooses the folder. If one day a format needs different handling (convert, rename), that is code, and it is out of this feature.
- **No file-name length limit.** FAT allows 255 characters and Telegram names are far shorter in practice. If one fails, `scp` reports it as a send failure.
- **No check that the folders exist at startup.** It would need the Kindle awake at boot. A missing folder fails the send with a clear `scp` message (R7.1a).
- **No reuse of `createRequestHandler`.** Both flows have the same skeleton (`say`, temp dir, `finally`), but forcing them into one function would mix AO3 and Telegram concepts. The duplication is about ten lines.
