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

- [ ] T1 skeleton + `job_state` + `status` — S1, S6 — writer A (ctl) — commit:
- [ ] T2 `start`, `stop`, `restart` — S2 — writer A (ctl) — commit:
- [ ] T3 `install`, `uninstall` — S3 — writer A (ctl) — commit:
- [ ] T4 `logs`, usage, errors — S4, S6 — writer A (ctl) — commit:
- [ ] T5 SwiftBar plugin template (+ `menubar install` in ctl, by writer A) — S5 — writer B (plugin) — commit:
- [ ] T6 docs (README EN/ES: LaunchAgent install, "Restart the daemon" → ctl commands, "Control panel" section, roadmap) — S5, S7 — parent — commit:
- [ ] Manual checks by the owner (T1 `LastExitStatus` after `kill -9`; T5 `--` submenus, light/dark look) — owner — pending
- [ ] Manual verification list (tasks.md) — owner — pending

## Log

- L1: "tengo un branch, feature/07-control-panel con los docs del feature 7, podemos hacer ese como el 4? Es decir, moverlo al proximo feature a realizara" → branch renamed to `feature/04-control-panel`, rebased on origin/main, spec folder moved to `04-control-panel`, roadmap renumbered (4 control panel, 5 Follow, 6 daily check, 7 commands); commit 36508a2.
- L2: "vale" (to: add the feature 3 "Restart the daemon" README section to T6 and start feature 4). T6 in tasks.md updated accordingly.
- L3: Routing: two independent units launched together — writer A owns `bin/bookcarrierctl` + `test/bookcarrierctl.test.ts` (T1–T4 and the `menubar install` subcommand of T5); writer B owns `swiftbar/bookcarrier.10s.sh.template` + `test/swiftbar-plugin.test.ts`. The plugin only depends on the porcelain contract of design.md, tested with a fake ctl. Risk: item 5 (installer writing a LaunchAgent into ~/Library and loading it) → independent verify after integration.
