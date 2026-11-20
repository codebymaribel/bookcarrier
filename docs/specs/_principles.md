# Bookcarrier Principles

Rules that apply to every feature. Each spec references them instead of repeating them.

## Stack

- Node v24 (via nvm), strict TypeScript, no plain JavaScript.
- Package manager: pnpm.
- Test runner: Vitest.
- Telegram bot: grammY.
- State (followed fics, queue) in local JSON; migrate to SQLite if it grows.

## Process

- One feature at a time, without touching files unrelated to the feature in progress.
- Each feature ships with its tests, written together with the code (not afterwards).
- After each block of code, explain every method created and what it does.
- Before writing code for a feature, close its spec (requirements → design → tasks) and research whatever is needed.

## Non-functional (apply whenever relevant)

- Pauses between requests to AO3 and backoff on 429 errors.
- The bot only responds to the owner's Telegram ID (@Maribel).
- Token, IP and SSH key path live in a config file outside the repo; the repo only contains generic values (`config.example`).
- Automatic startup with launchd, plus logs.
- Uploads to the Kindle tolerate it being asleep or off the network.
- Performance and scalability first: no unnecessary polling or blocking work on the main loop (I/O and subprocesses are always async).

## Out of scope (whole project)

- Searching for fics from the bot.
- Sites other than AO3.
- Pull server (WebDAV/OPDS) — possible future fallback, not now.

## Structure of each spec

```
docs/specs/NN-feature-name/
  requirements.md   # requirements in EARS + acceptance criteria
  research.md        # research findings, with date and source
  design.md           # technical decisions, interfaces, error handling
  tasks.md             # task list, each with its test
```
