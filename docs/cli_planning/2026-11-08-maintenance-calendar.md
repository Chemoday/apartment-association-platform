# 2026-11-08: The maintenance calendar and log (epic E10)

A record of a planning session with the coding agent (Claude Code CLI) after epic E9 (the
building issue tracker) was merged (#105) and handed over to the frontend.

## 1. Where we were
- E9 is done: the chairman's building settings, the issue tracker, the board's work on issues and
  their notifications.
- Next was the local backlog idea "Building passport and maintenance calendar" (L-4). Its core
  was decided on 2026-11-04: a calendar with its own data that publishes forum posts (board
  topics for the board, official notices for residents).

## 2. Decisions of the owner
- **Scope of part A:** the calendar and the maintenance log. Equipment, contractors, contracts and
  the residents' emergency-contacts page wait for part B. Calendar-only was rejected: without
  "done" marks the next date would move with the calendar and a missed inspection would be lost.
- **Period:** every N days, months or years. Fixed dates ("every spring") were rejected as more
  complex to explain and test.
- **Next date:** from the planned date, a fixed rhythm. The agent recommended counting from the
  done date (as inspections often are); the owner chose the fixed rhythm.
- **Residents** see only the published notices. A residents' list of planned works was rejected.
- **Overdue:** stays overdue and reminds the board again weekly. A single reminder was rejected.
- **Notifications:** the board gets "a maintenance task is due"; residents get "new notice from
  the board" for every official notice, the hand-written ones included (official notices notified
  nobody before), on every channel by default. The task title may appear in the board's external
  messages.
- **The log** has an optional cost. The accountant reads the log with its costs (not the tasks).
- **Skip:** one occurrence may be skipped with a required note.

## 3. Found in the code
- Every post needs a real author, and only `CommunicationService.create_post` writes posts. The
  calendar publishes through it as a current board member instead of adding a system writer.
- Official notices and board topics emitted no domain event; notifications learned nothing of
  them.
- The notifications scheduler already follows "due and not handled yet"; the publisher copies it,
  but runs one transaction per task, because an event added inside a rolled-back savepoint would
  still be published.
- No month arithmetic existed; it is a pure helper with day clamping, always from the anchor date.

## 4. Order of work
M1 module, API and log -> M2 the publisher and the automatic posts -> M3 notifications and the
frontend handoff, in one pull request.
