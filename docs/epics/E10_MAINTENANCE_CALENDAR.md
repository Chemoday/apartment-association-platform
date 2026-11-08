# E10. Maintenance calendar and log

- **Phase:** 2. **Status:** designed with the owner (2026-11-08); part A (tasks M1-M3) in one
  pull request; part B (equipment, contractors, the residents' emergency contacts) later.
  Builds on E8 (the board's micro-forum), E1 (notifications) and E9 (building settings).
  **Epic issue:** [#110](https://github.com/Chemoday/apartment-association-platform/issues/110). Planning record:
  docs/cli_planning/2026-11-08-maintenance-calendar.md.
- **Goal:** recurring maintenance of the building (fire extinguishers, gutters, the heating
  substation) lives in the service, not in one chairman's mailbox: the board is reminded in time
  and again while a task is overdue, residents get a notice when the work concerns them, and
  every "done" is in a log that survives a change of the board.

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/FRONTEND_GUIDE.md) in its first commit; where they differ,
the contract wins.

## 1. Owner decisions

From 2026-11-04 (local backlog idea L-4):
- **The calendar is a separate feature with its own data**, not forum posts: recurring rules,
  due dates and "done" marks are structured data.
- **The board enters the tasks itself:** "repeat every <period>" something, with a first due
  date and a lead time.
- **Delivery goes through the forum model:** the calendar decides *when*; when a task is due it
  publishes a post, and the post's target decides *who* sees it: a reminder for the board is a
  board topic (epic E8, task P4), a notice for residents an official notice to the whole
  building, an entrance or a list of apartments.

From 2026-11-08:
- **Part A is the calendar and the log.** Equipment, contractors and contracts, and the public
  emergency-contacts page come in part B and attach to the tasks.
- **Period:** every N days, months or years. A seasonal task is "every 12 months from 15 April".
- **The next date is counted from the planned date** (a fixed rhythm), not from the day the work
  was done.
- **Residents see only the published notices**, never the calendar itself.
- **Overdue:** the date moves only when the board marks the task done (or skips it). An overdue
  task stays overdue and reminds the board again, by default every 7 days (a chairman's setting).
- **Notifications:** the board is told "a maintenance task is due" (in the app by default; the
  task title may leave the app, it is the board's own text and goes to the board only).
  Residents are told "new notice from the board" with a link and no text, for every official
  notice, the hand-written ones included; on every channel by default.
- **The log:** the done date, who, a short note and an optional cost (exact euros). The
  accountant reads the log, costs included, but not the tasks and their internal notes.
  Residents see nothing of it.
- **Skip:** the board may skip one occurrence with a required note ("no gutter cleaning this
  autumn, the roof is being replaced"); the log shows it as skipped.

## 2. Module `maintenance`

A new module with its own tables (`maint_*`). It reads users and badges through
`PropertyService`, its settings through `BuildingSettings`, and publishes posts through
`CommunicationService` (service and DTOs only).

## 3. A task and its occurrences

- **Task:** title, internal instructions (how, where the keys are, who to call; board only),
  the period (unit `DAY` / `MONTH` / `YEAR` and a count), the lead time in days, the anchor date
  (the first due date: the rhythm is counted from it, so the 31st of a month never drifts), and
  an optional notice for residents (title, text, category, target). Status `ACTIVE`, `PAUSED` or
  `ARCHIVED`.
- **Occurrence:** one planned date of a task, with its own state: open, done, skipped or
  cancelled (when the task is archived). One task has at most one open occurrence.
- **Shown state of the open occurrence:** upcoming (before due - lead), due (published or in its
  lead time, not yet past), overdue (past its date), paused (the task is paused).
- **Next date after done or skip:** the first date of the rhythm that is later than both the
  planned date and the day it was done. A task done very late does not leave a chain of missed,
  instantly overdue dates behind; a task done early keeps its rhythm.

## 4. Publishing

- At due - lead (and only between 09:00 and 21:00 local time), the calendar publishes:
  - one **board topic** per occurrence: "Maintenance: {title}, due {date}", with the internal
    instructions; it is marked as an automatic reminder;
  - one **official notice** per occurrence for a task that has a notice: the board's text as
    written, plus the planned date, to its target. If the target is no longer valid (an entrance
    or apartment removed), the notice is not published and the board topic says so.
- While the occurrence is overdue, every N days a comment on the same board topic: "Still not
  done: overdue since {date}". A deleted topic is published again.
- **Who is the author:** a post always has a real author. The task's creator if still on the
  board, else the chairman, else a board member; with nobody, the calendar waits.
- **"Due and not published yet"**, never "due date is today": a day of downtime loses nothing.

## 5. Notifications (E1)

| `event_type` | Recipients | Default | Mandatory |
| :--- | :--- | :--- | :--- |
| `MAINTENANCE_DUE` | the chairman and the board, when a task is published and at each overdue reminder | in-app on, external off | no |
| `NOTICE_PUBLISHED` | the people the official notice is for, never its author; for every official notice | every channel | no |

## 6. Tasks

| Task | What | Done when |
| :--- | :--- | :--- |
| M1 ([#107](https://github.com/Chemoday/apartment-association-platform/issues/107)) | Module `maintenance`: tasks, occurrences, the log, the board's API, the accountant's read of the log; the contract | the board creates, edits, pauses, resumes and archives tasks, marks an occurrence done or skipped with a note and a cost; the accountant reads the log; residents get 403, another building 404; the rules (month ends, leap years, very late done) and two concurrent "done" are tested |
| M2 ([#108](https://github.com/Chemoday/apartment-association-platform/issues/108)) | The publisher: board topics, notices and overdue reminders; the automatic-post flag; the event of every official notice; demo data | one topic per occurrence across ticks, nothing early or at night, catching up after downtime, weekly overdue comments, paused tasks ignored, the author fallback, an invalid notice target, two concurrent ticks, a deleted topic; tests with an injected time |
| M3 ([#109](https://github.com/Chemoday/apartment-association-platform/issues/109)) | Notifications `MAINTENANCE_DUE` and `NOTICE_PUBLISHED`; frontend guide; handoff | the right people are told once, the send-time checks skip outdated messages, texts in en, ru, et; tests |

M1-M3 go into one pull request (one pull request per large feature).

## 7. Open

- Part B: equipment, contractors and contracts (with end-date reminders), the public
  emergency-contacts page, linking issues of epic E9 to contractors.
- Fixed-date periods ("every spring") if the "every 12 months from" form is not enough.
- Residents who got a notice are not told when the board later moves, skips or cancels that
  occurrence (the board topic gets a comment); a follow-up notice could come with part B.
- A yearly report of the log and its costs for the general meeting.
