# Requirements — Feature 5: Follow + chapter tracking

See the [project principles](../_principles.md) and the specs of features [1](../01-standalone-send/requirements.md), [2](../02-retry-queue/requirements.md) and [3](../03-document-send/requirements.md). The findings behind each decision are in [research.md](./research.md).

> **Status: requirements approved by the owner on 2026-11-22; open questions resolved. Next: design.**

## Goal

When an AO3 fic is delivered to the Kindle, the delivery message offers a "Follow" button. Following a fic stores it, together with the number of chapters that were delivered and whether the fic is complete, so that feature 6 (daily update check) knows what to check and from which chapter on. The owner can stop following a fic with an "Unfollow" button, and a followed fic is unfollowed automatically when it becomes complete. This feature does **not** check AO3 for updates.

## Decisions made (2026-11-22)

- **Numbering:** feature 5 is Follow + chapter tracking; the daily update check is feature 6; `/list`, `/drop`, `/status` are feature 7 (as in feature 4's spec).
- **Follow is offered only on in-progress AO3 fics.** A fic that is already complete when delivered has no Follow button.
  - _Changed 2026-11-22: first it was offered on every fic, complete or not (for epilogues); changed when the owner decided that a fic that becomes complete is unfollowed._
- **A followed fic that goes from In-Progress to Completed is unfollowed automatically**, and the owner is told in the delivery message.
- **The Follow button stays usable for the last 10 delivered fics** (10 fics, not chapters; one record per work id, re-delivering a fic replaces its record). Followed fics do not count towards the 10.
- **Unfollow is part of this feature**, as an inline button.
- **Sending the link of a fic that is already followed updates its stored chapter count and status** with those of the new delivery.
- **No extra AO3 request:** the chapter count and status come from the same FanFicFare run that downloads the fic (research §1, §2).
- Documents (feature 3) are never followable.

## Scope

- A single recipient (the owner's Telegram ID).
- AO3 fics delivered by feature 1 (new request) or feature 2 (queue retry).
- Messages and button taps are processed one at a time, in arrival order, as in features 1 and 3.

## Requirements (EARS)

### R1 — Owner filtering

- R1.1: When the daemon receives a "Follow" or "Unfollow" tap whose `from.id` is not the owner's, the system shall ignore it without replying. (The existing `ownerOnly` middleware already covers it.)

### R2 — Chapter metadata

- R2.1: When FanFicFare downloads a fic, the system shall obtain from that same run the fic's published chapter count (`numChapters`) and status (`status`: `Completed` or `In-Progress`), without any additional request to AO3.
- R2.2: The system shall accept `numChapters` whether FanFicFare writes it as a number or as a string, and shall treat it as valid only when it is a positive integer.
- R2.3: When the metadata is missing, cannot be parsed, or has no valid `numChapters`, the system shall still deliver the fic as before, log a warning with the work id, and send the delivery message **without** the Follow button.
- R2.4: A `status` other than `Completed` or `In-Progress` shall be treated as unknown. A fic with unknown status shall not be offered Follow (R3.1), and an unknown status on a re-delivery shall not unfollow a followed fic (R6.4).
- R2.5: When a fic is enqueued after its download succeeded (feature 2, send stage), the system shall keep its chapter metadata with the queue item, so that the delivery on retry can offer Follow.
- R2.6: Queue items written before this feature (without chapter metadata) shall still be delivered; their delivery message shall not offer Follow (R2.3).

### R3 — The Follow button

- R3.1: When an AO3 fic is delivered (new request or queue retry), its chapter metadata is valid, its status is `In-Progress`, and the fic is not followed, the system shall attach a "Follow" inline button to the delivery message.
- R3.1a: When the delivered fic's status is `Completed` or unknown, the delivery message shall carry no Follow button.
- R3.2: The button's `callback_data` shall be at most 64 bytes and contain only an action prefix and the AO3 work id, never the title.
- R3.3: When the owner taps "Follow", the system shall answer the callback query, store the follow (R5), replace the button with "Unfollow", and reply that the fic is now followed, stating the chapter count stored (for example "Following *Title* — 12 chapters delivered").
- R3.4: When the owner taps "Follow" on a fic that is already followed, the system shall not create a second entry; it shall reply that it is already followed and show "Unfollow".
- R3.5: The system shall keep, in the follows file, the metadata (work id, URL, title, author, chapters, status) of the **last 10 delivered fics** that offered Follow, one record per work id, so that a Follow tap keeps working after a daemon restart. Re-delivering a fic replaces its record and makes it the most recent; when an 11th fic is added, the oldest record is dropped. Followed fics are kept separately and never dropped by this limit.
- R3.6: When the owner taps "Follow" and the fic is neither followed nor among those 10 records, the system shall reply that the fic should be sent again to follow it, and shall store nothing.

### R4 — Unfollow

- R4.1: When the owner taps "Unfollow", the system shall answer the callback query, remove the follow, remove the button from the message, and reply that the fic is no longer followed, naming its title.
- R4.2: When the owner taps "Unfollow" on a fic that is not followed (already removed), the system shall reply that it was not being followed and change nothing.
- R4.3: The "Unfollow" button's `callback_data` shall follow R3.2.

### R5 — Followed fics state

- R5.1: The system shall store followed fics in a local JSON file, one entry per AO3 work id, with at least: work id, work URL, title, author, chapters delivered, status, date followed and date last updated.
- R5.2: The file shall be written atomically and carry a version number, with the same guarantees as feature 2's queue state (R2 of feature 2): a crash never leaves a half-written file, and a corrupt file is set aside (`<path>.corrupt-<timestamp>`), logged, and replaced by an empty state instead of stopping the daemon.
- R5.3: Followed fics shall survive daemon restarts.

### R6 — Re-delivery of a followed fic

- R6.1: When an AO3 fic that is already followed is delivered again (the owner sent its link again), and its metadata is valid, the system shall update its stored chapter count, status, title and date last updated with those of the new delivery.
- R6.2: In that case the delivery message shall say that the follow was updated, with the new chapter count, and shall carry the "Unfollow" button instead of "Follow".
- R6.3: When the metadata of that re-delivery is not valid (R2.3), the system shall leave the stored follow unchanged.
- R6.4: When a followed fic is re-delivered with status `Completed`, the system shall remove the follow and say in the delivery message that the fic is complete and is no longer followed, with no button. When the status is unknown, the follow shall be updated as in R6.1 and kept.
- R6.5: This feature applies R6.4 only on re-deliveries; feature 6 shall apply the same rule when its daily check finds a followed fic completed.

### R7 — Configuration

- R7.1: The system shall accept a new optional config field, `followsPath`, the path of the followed fics file, defaulting to `~/.bookcarrier/follows.json` (next to `queuePath`).
- R7.2: The system shall validate `followsPath` like `queuePath`, and shall not start, naming the field, when it is invalid.
- R7.3: `config.example.json` and the README's config table shall document the field and its default.

### R8 — Messages

- R8.1: Every new text for the owner shall live in `messages.ts`, in plain text (no `parse_mode`), as in feature 3.

## Out of scope for this feature

- Checking AO3 for new chapters, on a schedule or on demand (feature 6).
- Listing followed fics, `/drop`, `/status` (feature 7).
- Following a fic without delivering it first (for example, a `/follow <link>` command).
- Following documents (feature 3) or fics from sites other than AO3.
- Bulk import of followed fics (from AO3 subscriptions or bookmarks).

## Acceptance criteria (Given/When/Then)

1. **Given** an in-progress fic with 12 published chapters, **when** it is delivered, **then** the delivery message carries a "Follow" button.
2. **Given** that message, **when** the owner taps "Follow", **then** the fic is stored with 12 chapters and status In-Progress, the button becomes "Unfollow" and the bot confirms "12 chapters".
3. **Given** a complete fic, **when** it is delivered, **then** the delivery message has no "Follow" button.
4. **Given** a followed fic, **when** the owner taps "Unfollow", **then** it is removed from the file and the button disappears.
5. **Given** a followed fic stored with 12 chapters, **when** the owner sends its link again and the new download has 14, **then** the stored count becomes 14 and the delivery message says the follow was updated and shows "Unfollow".
6. **Given** FanFicFare produces no usable metadata, **when** the fic is delivered, **then** it reaches the Kindle as before, a warning is logged, and no Follow button is shown.
7. **Given** a fic was delivered on a queue retry after its download succeeded earlier, **when** the retry delivers it, **then** the message offers "Follow" with the chapter count from that download.
8. **Given** some fics are followed, **when** the daemon restarts, **then** they are still followed.
9. **Given** the follows file is corrupt, **when** the daemon starts, **then** it starts with no followed fics, the corrupt file is kept aside and the problem is logged.
10. **Given** someone who is not the owner taps "Follow" or "Unfollow", **when** the daemon receives it, **then** it does not reply and changes nothing.
11. **Given** a document (feature 3) is delivered, **when** the delivery message is sent, **then** it has no Follow button.
12. **Given** any delivery, **when** the fic is followed or updated, **then** no request to AO3 is made beyond the download itself.
13. **Given** a followed fic stored as In-Progress, **when** the owner sends its link again and the new download says Completed, **then** the follow is removed and the delivery message says the fic is complete and no longer followed.
14. **Given** 10 in-progress fics delivered after fic A and none followed, **when** the owner taps A's old "Follow" button, **then** the bot replies that A should be sent again, and nothing is stored.
15. **Given** fic A was delivered, **when** the daemon restarts and the owner then taps A's "Follow" button, **then** A is followed.
