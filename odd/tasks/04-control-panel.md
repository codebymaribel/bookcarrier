# Feature 4 — Control panel (`bookcarrierctl` + SwiftBar menu bar)

Implements docs/specs/04-control-panel (requirements.md, design.md, research.md, tasks.md). Branch `feature/04-control-panel`, rebased on `origin/main` at 761c381 (features 1–3 merged).
Those spec files are the verbatim source of every requirement; the S# below point at them instead of copying them.

## Specs

- S1: requirements.md R1 (`status`, states, `--porcelain`, exit 0/3, queue count) — verbatim there.
- S2: requirements.md R2 (`start`, `stop` with SIGTERM + 15 s wait and never SIGKILL, `restart`, not-installed message).
- S3: requirements.md R3 (`install`, preconditions, reinstall, `uninstall` keeps logs/queue/spool).
- S4: requirements.md R4 (`logs`, `-f`).
- S5: requirements.md R5 (SwiftBar plugin: icons per state, filtered actions, background actions, open logs/spool/queue, 10 s refresh, error state, `menubar install`).
- S6: requirements.md R6 (any cwd + symlink, absolute system binaries, unknown command → usage, exit 2).
- S7: requirements.md acceptance criteria 1–7, design.md (shape, commands table, messages, plugin output) and tasks.md test lists per task.

## Tasks

- [x] T1 skeleton + `job_state` + `status` — S1, S6 — writer A (ctl) — commit: 7222ad1
- [x] T2 `start`, `stop`, `restart` — S2 — writer A (ctl) — commit: 7222ad1
- [x] T3 `install`, `uninstall` — S3 — writer A (ctl) — commit: 7222ad1
- [x] T4 `logs`, usage, errors — S4, S6 — writer A (ctl) — commit: 7222ad1
- [x] T5 SwiftBar plugin template (+ `menubar install` in ctl, by writer A) — S5 — writer B (plugin) — commit: ad3c8c9 (plugin) + 7222ad1 (menubar install)
- [x] T6 docs (README EN/ES: LaunchAgent install, "Restart the daemon" → ctl commands, "Control panel" section, roadmap) — S5, S7 — parent — commit: 7f9fe2b
- [ ] Manual checks by the owner (T1 `LastExitStatus` after `kill -9`; T5 `--` submenus, light/dark look) — owner — pending
- [ ] Manual verification list (tasks.md) — owner — pending

## Log

- L1: "tengo un branch, feature/07-control-panel con los docs del feature 7, podemos hacer ese como el 4? Es decir, moverlo al proximo feature a realizara" → branch renamed to `feature/04-control-panel`, rebased on origin/main, spec folder moved to `04-control-panel`, roadmap renumbered (4 control panel, 5 Follow, 6 daily check, 7 commands); commit 36508a2.
- L2: "vale" (to: add the feature 3 "Restart the daemon" README section to T6 and start feature 4). T6 in tasks.md updated accordingly.
- L3: Routing: two independent units launched together — writer A owns `bin/bookcarrierctl` + `test/bookcarrierctl.test.ts` (T1–T4 and the `menubar install` subcommand of T5); writer B owns `swiftbar/bookcarrier.10s.sh.template` + `test/swiftbar-plugin.test.ts`. The plugin only depends on the porcelain contract of design.md, tested with a fake ctl. Risk: item 5 (installer writing a LaunchAgent into ~/Library and loading it) → independent verify after integration.
- L4: Writers integrated: `pnpm test` 479/479 (26 files), typecheck 0; the plugin run against the real ctl (fake launchctl) renders running/stopped/crashed/not-loaded correctly. Writer A decisions: porcelain prints `-` for an absent pid/last_exit; `restart` on not-loaded bootstraps; `stop` when not running and `uninstall` when not installed exit 0 with a message; `help` → usage on stderr, exit 0; no args → usage, exit 2; launchctl output hidden behind one-line messages; refresh skipped after `menubar install`. Writer B decisions: *Open spool folder* uses `/usr/bin/open <spool>` instead of design's `href=file://…` (all three Open items alike); `?` queue → "Retry queue unreadable"; error states show the message plus the Open items, never actions; plugin uses Bash builtins only. Known risk: `param` paths unquoted, a space in $HOME would split them in SwiftBar (owner's HOME has none). Slice boundary: ctl 7222ad1 (Risk item 5, own commit), plugin ad3c8c9; branch ~1,870 authored lines, delivery shape is the owner's decision.
- L5: Independent verify (Risk item 5): S1, S2, S4, S5 met; S3/S6 partial. Blocker: `install` over a loaded job did `bootout` and overwrote the plist **before** `plutil -lint`, so a bad template left the owner with no running daemon and an invalid plist. Fixed test-first by the parent: the plist is built and linted in a temp file in LaunchAgents first (a lint failure touches neither the plist nor the job, no launchctl call), then `bootout` → `mv` → `bootstrap`. Should-fixes fixed: REPO/HOME are XML-escaped (`&`, `<`, `>`); `usage` calls `/bin/cat` (R6.2). Nit fixed: `stop` that ends `crashed` now exits 1 saying launchd will restart it. RED 4 tests → GREEN; `pnpm test` 483/483, typecheck 0. Left as known limitations (owner's paths have none of these characters): SwiftBar `bash=`/`param=` values in the plugin are unquoted, so a space in REPO/HOME would split them (untested against the real SwiftBar's quoting rules); `queue_items` passes through plutil's output when `items` is not an array; a `bootstrap` failure right after `bootout` (real launchd race) leaves the job unloaded — owner checks acceptance 1 on the real launchd.
- L6: T6 docs by a writer (context backstop): LaunchAgent section uses `bookcarrierctl install`, "Restart the daemon" uses `bookcarrierctl restart/status/logs`, new "Control panel" section with commands table and SwiftBar setup; anchors checked; `pnpm test` 483/483; commit 7f9fe2b. Open: owner manual checks (T1 `LastExitStatus` after `kill -9`; T5 SwiftBar look, `param` quoting, refresh URL) and the manual verification list in tasks.md.
- L7: Native review due (assess: high, executable bin/bookcarrierctl). Lineage review-14c65b234b7e8178 started on e2c7aa5..HEAD (lenses risk, reliability, resilience; untracked pr1.md/pr2.md excluded). Blocked before any reviewer ran: no model configured for `review-risk` in the agent model routing (~/.gentle-shell/gentle-ai/models.json) — owner configuration.
