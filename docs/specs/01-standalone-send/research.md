# Research — Feature 1: Standalone Send

Date: 2026-11-15

## FanFicFare CLI

- It is a Python package; install on Mac with `brew install fanficfare` (there is a bottle for Apple Silicon) or `pip install FanFicFare`. We prefer Homebrew to avoid mixing with the system Python.
- Basic usage: `fanficfare [STORYURL] -f epub` downloads a fic as EPUB into the current directory. **The output name IS configurable** — see the 2026-11-17 verification below, which corrects what we had assumed here.
- `-u` / `--update-epub`: appends new chapters to an existing EPUB, given the file or the URL. This is key for feature 4 (updates), not for this feature, but we note it here.
- `-m` / `--meta-only`: fetches metadata without downloading chapters — useful to extract id/title/chapter count without downloading the full EPUB (useful for feature 3).
- There is no clearly documented, stable exit code in the CLI; in practice, it is best not to rely only on the exit code but also to check that the output file exists and has size > 0, and to parse stderr for messages such as "HTTP Error", "403", "429" / "too many requests".
- FanFicFare already has its own retry handling with backoff on network errors (visible in the logs as `sleeptime(0)`, `sleeptime(0.5)`, `sleeptime(4)`, `sleeptime(9)` — its own exponential backoff). This means we probably **do not need to implement our own backoff for AO3**: it is enough to give the subprocess a generous timeout and let FanFicFare retry internally. If we see real 429s we would have to look into `personal.ini` (`[overrides]` section) to tune the delay between requests.
- AO3 specifically may return 403/429 under heavy site load (not only because of our own abuse) — these are transient and it is best to retry the whole request later (feature 2, the queue, covers this better).

**Decision for this feature:** install with Homebrew, invoke `fanficfare <url> -f epub` as a subprocess with a timeout, trust FanFicFare's internal backoff, and verify success by (a) exit code 0 and (b) existence + size of the resulting EPUB.

### Verification against the real package (2026-11-17, FanFicFare 4.63.0)

Done by inspecting the installed package (`pip install FanFicFare`) and its `defaults.ini` / source code, not by searching the internet. It does **not** include a real download from AO3 (see "To test by hand").

- **The output name is configurable**, contrary to what we had assumed. `defaults.ini` defines:
  ```
  output_filename: ${title}-${siteabbrev}_${storyId}${formatext}
  ```
  and the CLI allows overriding any option with `-o NAME=VALUE` / `--option NAME=VALUE`.
- For AO3, `siteabbrev` is `ao3` (set by the `adapter_archiveofourownorg.py` adapter), and the `[archiveofourown.org]` section of `defaults.ini` does **not** redefine `output_filename`, so the global default applies. Therefore, with nothing configured, an AO3 fic comes out as `<title>-ao3_<storyId>.epub`.
- **We can ask directly for the name we want:**
  ```
  fanficfare <url> -f epub -o output_filename='${storyId}-${title}${formatext}'
  ```
  This makes it unnecessary to rename or parse the name after the download.
- **FanFicFare already sanitizes the file name itself.** The `output_filename_safepattern` option defaults to:
  ```
  (^\.|/\.|[^a-zA-Z0-9_\. \[\]\(\)&'-]+)
  ```
  and in `story.py` (`get_filename_safe_metadata`) each metadata value goes through `re.sub(pattern, '_')`. That is: anything that is not an ASCII letter, digit, `_`, `.`, space, `[ ]`, `( )`, `&`, `'` or `-` is replaced by `_`.
- **Consequence to keep in mind:** accents and non-ASCII characters become `_`. A title like "Corazón partido" ends up as `Coraz_n partido`. If that is a nuisance, a more permissive custom `output_filename_safepattern` can be passed; for now we leave the default, which guarantees valid names.
- `formatFileName` in `story.py` confirms the fallback to the same pattern by default, so the behavior is consistent.

**Revised decision:** we do not build or sanitize the name ourselves — we ask FanFicFare for it with `-o output_filename=...`. And to know which file to copy, we download into an empty temporary directory per request and look for the only `*.epub` left there, instead of predicting the name (predicting it would mean reimplementing the safepattern and falling out of sync if it changes).

## Telegram bot: grammY vs Telegraf

- Both are TypeScript-first today; historically Telegraf was JS with incomplete types, but its 4.x version is already TS.
- grammY has its own complete documentation (with explanations), while Telegraf was left with only a generated API reference, no guides. For someone starting from scratch with Telegram bots, grammY has a better learning curve because of this.
- Both natively support long polling (no need to open ports, which is a project requirement) and inline buttons (`InlineKeyboard`), which we will need in feature 3 ("Follow").
- grammY is the one being recommended as "the new thing" in 2026 in tutorials and comparisons; Telegraf is still valid but with less momentum.

**Decision for this feature:** use **grammY**. Minimal setup: `bot.command("start", ...)`, filter every update by `ctx.from?.id` against the ID stored in config, and `bot.start()` (long polling) in the daemon's entrypoint.

## scp as a subprocess (Node/TS)

- Confirmed by the previous project (KindleMOD): calling `scp` as a subprocess worked better than using an SSH library in the language (paramiko in that case). We keep the same approach: Node's `child_process`, no SSH libraries.
- With Node, use `spawn` (not `exec`) to avoid going through an intermediate shell and to be able to handle stdout/stderr by streaming without blocking.
- "Cannot be launched" case: if the `scp` binary is not in the PATH or the key does not exist/has wrong permissions, `spawn` emits the `'error'` event (not an exit code) — that event must be listened to explicitly, because if only `'close'`/`'exit'` is handled the error goes unnoticed.
- The subprocess needs its own timeout (`spawn` does not have a native timeout in all Node versions in the same way as `execFile`): if the Kindle is asleep or off the network, `scp` may hang on the connection attempt instead of failing fast. It is best to use SSH's `ConnectTimeout` (`-o ConnectTimeout=10`) in addition to our own timeout as a safety net.
- To test by hand (not researchable by search): confirm that KindleMOD's dedicated key still works the same from this new project, and measure whether the Docker problem that dropped the speed to ~0.3 KB/s is resolved or still needs watching.

**Decision for this feature:** `spawn('scp', ['-o', 'ConnectTimeout=10', '-i', keyPath, localPath, `${remote}:/mnt/us/documents/books/`])`, listening to `'error'` (binary/key) and `'close'` (exit code), with its own timeout in addition to `ConnectTimeout`.

## KOReader and EPUB overwriting

- By default ("doc" mode, which is KOReader's default), the reading position, bookmarks and highlights are stored in a `.sdr` folder **next to the file**, named after the file (`<name-without-extension>.sdr/metadata.epub.lua`). They are not stored inside the EPUB.
- This is good news for the stable name `<fic-id>-<title>.epub` that was already planned: as long as the file name does not change, the `.sdr` folder stays the same and KOReader should keep associating the reading position when the content is overwritten.
- There is an alternative mode ("hash") that stores sidecars in a central folder organized by a hash of the document's **path** (not its content) — it would not break on overwrite either, unless we change the path/name.
- Warning found in forums: some versions also store a `partial_md5_checksum` inside `metadata.epub.lua`, used for cross-device synchronization — it should not affect the "single device, same file overwritten" use case, but there is no 100% documented guarantee for every KOReader version.

**Decision:** we do not block feature 1 on this (overwriting is a feature 4 topic), but the finding validates that the stable-name convention is the right decision. For feature 4 it is advisable to do the manual test (overwrite an EPUB that is being read and confirm the position is kept) before declaring the feature done.

## AO3 security incident (Nov. 2026) and "HTML-only" downloads

- AO3 was down for more than two weeks after a security incident at the end of October 2026; it came back online on November 15, but with several features still restricted, among them: for now works can only be downloaded in HTML format from the site (AO3's own "Download" dropdown, not FanFicFare).
- This **does not affect FanFicFare**: FanFicFare does not use AO3's converter. It scrapes the chapters' HTML directly from the work page and generates the EPUB itself (it supports epub, mobi, html and plain-text output as its own conversion formats). They are two independent paths — in the FanFicFare forums it is mentioned that way: "even if you can't get FFF to download from AO3, there's still AO3's own Download > EPUB feature", treating them as separate alternatives.
- **Decision:** no special handling is needed in the design for this case. `fanficfare <url> -f epub` is still the right path even if AO3's native button is limited to HTML.
- **Risk to watch (not because of the format, but because of the incident itself):** if the post-incident restoration came with more aggressive anti-bot measures (harsher rate limiting, new blocks), that could indeed affect FanFicFare. It is worth using the manual test already planned (`fanficfare <test-url> -f epub`) to confirm it works in this particular context, not just in general.

## To test by hand (not internet research)

- [x] `fanficfare <test-url> -f epub -o output_filename='${storyId}-${title}${formatext}'` from the Mac's terminal, once installed. **It has to be run on the Mac**: AO3 is not reachable from sandbox/CI environments (it is outside the network allowlist), so this verification cannot be automated elsewhere.
- [x] Manual `scp` with the dedicated key to `/mnt/us/documents/books/AO3/` on the Kindle.
- [x] Confirm that @ficarrier_bot responds to `/start` with long polling before writing business logic.
