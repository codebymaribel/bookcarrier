# Prior Manual Tests — Feature 1

These three tests are **blocking for T1–T7** (the business logic), not for Step 0.

Step 0 — project, TypeScript, Vitest, `logger.ts`, `config.ts` and `config.example.json` — can be done earlier: it does not depend on any result from here, because these tests define _values_ and _behaviors_, not the shape of the scaffolding. Doing it earlier also leaves everything ready to start T1 as soon as there are results.

What these tests do block is any code that depends on how FanFicFare, scp or Android's share menu behave. They are run in the Mac's Terminal (they cannot be automated: AO3 is outside the network allowlist in sandbox environments, and the Kindle is only reachable from the home local network).

Run them in a scratch directory, not in the repo.

---

## Test 1 — FanFicFare

### Installation

```bash
brew install fanficfare
fanficfare --version    # expected: 4.63.0 or higher
```

### Download with our file name

```bash
cd "$(mktemp -d)" && pwd

fanficfare 'PASTE_AO3_URL_HERE' -f epub -o output_filename='${storyId}-${title}${formatext}'
echo "exit code: $?"

ls -la
```

> **Mind the quotes:** `${storyId}` must go in **single** quotes. With double quotes, the shell tries to expand it as its own variable and FanFicFare receives it empty.

### What to confirm

- [x] The file comes out as `<storyId>-<title>.epub` (e.g. `12345678-Some Fic Title.epub`).
- [x] What `exit code` it returns in the success case (expected: 0).
- [x] That the download works with AO3 in its current post-incident state. **This is the most valuable point of the test** — if AO3 added anti-bot measures when restoring the service, we find out now and not after writing the daemon.
- [x] How accents end up in the name (expected: converted to `_`, e.g. `Coraz_n`). If it is a nuisance in the bot's confirmation message, the extra `-m` step has to be decided.

### If it fails

Save the full stderr output. Expected errors are 403/429 (transient, retry) or something about login for restricted works. According to the research, FanFicFare already retries on its own with backoff — in the logs it shows as `sleeptime(0)`, `sleeptime(0.5)`, `sleeptime(4)`.

---

### Test 2 — scp

**Purpose:** find out what exit code and stderr `scp` returns when the Kindle is
unreachable, and confirm that `ConnectTimeout` is respected. T5 needs it to
distinguish R5.3 (Kindle unreachable) from any other failure, and feature 2's `errors.ts` uses that code.

**Before starting:** Kindle on, with WiFi and KOReader's SSH active.
Have at hand the IP, the key path and an `.epub` from Test 1.

**a) Normal copy (Kindle on)**

```bash
ls -l ~/.ssh/KEY
time scp -P 2222 -o ConnectTimeout=10 -o BatchMode=yes -i ~/.ssh/KEY \
  *.epub root@KINDLE_IP:/mnt/us/documents/books/
echo "exit code: $?"
```

Expected: exit code 0 and the file visible on the Kindle.

**b) Kindle off or without WiFi**
Repeat the same command and save the full stderr.

```bash
time scp -P 2222 -o ConnectTimeout=10 -o BatchMode=yes -i ~/.ssh/KEY \
  *.epub root@KINDLE_IP:/mnt/us/documents/books/ 2> scp-error.txt
echo "exit code: $?"
cat scp-error.txt
```

Expected: fails at around 10 s (if it takes much longer, `ConnectTimeout` is not respected).

**c) Key with wrong permissions**

```bash
chmod 644 ~/.ssh/KEY
# repeat the command from (a)
chmod 600 ~/.ssh/KEY   # restore
```

Expected: scp rejects the key. Note whether the exit code and message differ from those of (b).

**Record:**

- exit code and stderr of (a), (b) and (c)
- actual time of (b) (`time`)
- whether the exit code of (b) and that of (c) can be told apart

---

## Test 3 — The Telegram bot responds

Dual purpose: confirms that long polling works **and** tells you your Telegram ID, which the config needs.

### Setup

```bash
mkdir -p ~/scratch/ficarrier-smoke && cd ~/scratch/ficarrier-smoke
pnpm init
pnpm add grammy
pnpm add -D tsx typescript @types/node
```

### Script

Save as `smoke.ts`. **It is not production code** — it is only for this verification.

```ts
import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is missing");

const bot = new Bot(token);

bot.on("message", (ctx) => {
  console.log("from.id:", ctx.from?.id, "| text:", ctx.message.text);
  ctx.reply(`Received. Your Telegram ID is: ${ctx.from?.id}`);
});

bot.start();
console.log(
  "Bot started with long polling. Write something to it from Telegram.",
);
```

### Run

```bash
BOT_TOKEN='THE_BOTFATHER_TOKEN' pnpm tsx smoke.ts
```

Then write anything to @ficarrier_bot from your phone.

### What to confirm

- [x] The bot replies with your ID.
- [x] **Note that ID**: it is the config's `ownerId` (R6.1 of feature 1).
- [x] That no port had to be opened and no webhook configured — long polling just works.
- [x] Also try sharing an AO3 link from Android's share menu to the bot, and see in the console **exactly** how the text arrives. This matters for link extraction (T2): Android's share menu sometimes adds the fic's title before the URL, instead of sending the URL alone.

---

## Results

Record here whatever comes out, with the date. Whatever contradicts the spec is corrected in `research.md` / `design.md`.

### Test 1 — FanFicFare

> **2026-11-18 — PASSES** (ran directly, FanFicFare 4.63.0 from Homebrew).
>
> Evidence: `65164981-Title_ Fooled Around (And Fell in Love).epub` (works/65164981, via a `/chapters/…` URL, which downloads the whole work), and
> `62024398-Somewhere Only We Know _ A Professor AU.epub` (30 chapters, 237,847 words, 587 KB).
>
> - **Exit code 0** in both runs; stdout and stderr were **empty** on success. A failure sample has not been captured yet (planned, see research.md).
> - **Duration:** the long fic took ~2 min 10 s (~4 s per chapter), so `downloadTimeoutMs` = 600000 covers roughly 150 chapters. The first run (2 chapters) took ~3 min, so that slowness is not per chapter — probably first launch after install or a slow moment at AO3.
> - `:` and `~` in titles became `_`.
>
> - The `<storyId>-<title>.epub` pattern works: `-o output_filename='${storyId}-${title}${formatext}'` does what we expected.
> - The `_` after "Title" is a `:` from the original title, sanitized by `output_filename_safepattern` — confirms the behavior documented in research.md.
> - Parentheses are preserved, because they are in the allowed charset (`a-zA-Z0-9_. []()&'-`).
> - **AO3 downloads fine despite the site's post-incident state.** It was the project's biggest risk and it is now ruled out.
>
> - **Failure sample (incidental, 2026-11-18 14:35, via T4's real run):** AO3 answered `HTTP 525` (a Cloudflare SSL-handshake error on AO3's side) and FanFicFare exited with **code 1**, a long Python traceback on stderr and an empty output directory. Its last stderr line was `fanficfare.exceptions.HTTPErrorFFF: HTTP Error in FFF '525 Server Error: <none> for url: …'(525)`. The same fic had downloaded fine earlier that day, so it was transient. Useful for feature 2's `errors.ts`: the HTTP status appears in that final line. A deliberate test with a nonexistent work is still pending.
>
> **Deferred (2026-11-19):** no accented title has been tried yet. It would only decide whether the `-m` variant is worthwhile, which is cosmetic; it is listed under "Deferred" in tasks.md.

### Test 2 — scp

> **2026-11-18 — PASSES, with one contradiction to the spec (already corrected).**
>
> - Host: `192.168.1.50`, user `root`, key with `600` permissions.
> - **The SSH server is KOReader's and listens on port 2222; 22 does not respond.** The spec assumed the default port in R5.1, in `uploader.ts`'s invocation, in `UploadOptions` and in `Config`. Corrected 2026-11-18: `kindlePort` field (default 2222) + `-P` in the invocation (R5.8).
> - `ssh` with `BatchMode=yes` connects and `/mnt/us/documents/books/` exists.
> - **Speed:** 16 KB in 0.44 s; 587 KB in 0.75 s (~780 KB/s). Exit code 0.
>   → KindleMOD's problem (scp at ~0.3 KB/s because of a hung Docker) **is not present**. The 2-minute `uploadTimeoutMs` is comfortable: at this speed a typical EPUB takes under a second.
> - **File names with spaces and parentheses work**, with no special escaping.
> - **Kindle unreachable** (SSH server off): fails at 10.0 s — `ConnectTimeout=10` is respected — with **exit code 255**, and does not hang.
> - There is an `AO3/` folder inside `books/`, from earlier sends.
> - **A second flavour of "Kindle unreachable" (2026-11-18, via T5's real run):** with the Kindle asleep, `scp` did not wait for `ConnectTimeout`: the OS answered `Host is down` at once and `scp` exited **255 in ~14 ms**, stderr `ssh: connect to host 192.168.1.50 port 2222: Host is down` + `scp: Connection closed`. So there are two shapes: timeout at 10.0 s (host awake, SSH server off) and instant `Host is down` (asleep). Both exit 255 and both fall under R5.7 as a send failure.
>
> **Pending from this test:** the comparison with the "broken key" case (`chmod 644`) to confirm it gives the same 255 as the unreachable host. It does not block: R5.2's prior check is correct anyway, because it is strictly safer than depending on the exit code.

### Test 3 — Bot

> **2026-11-18 — PASSES.** grammY 1.46.0, long polling with no ports opened and no webhook.
>
> - `ownerId` obtained (it goes only in the real config file, outside the repo).
> - A simple message ("Hola") arrives as plain text.
> - Sharing from Android sends **two lines**, not the URL alone:
>   `Rio, Rio - carsynmerrill (onthepitch) - Agatha All Along (TV) [Archive of Our Own]`
>   `https://archiveofourown.org/works/61265059`
>   → T2 has to find the URL inside the text (multi-line), not require the whole message to be the URL. Used as a test case in T2.
