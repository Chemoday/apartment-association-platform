# 2026-11-08: The building issue tracker (epic E9) and the chairman's settings

A record of a planning session with the coding agent (Claude Code CLI) after epic E3 part A
(informative polls) was merged (#98) and handed over to the frontend.

## 1. Where we were
- E3 part A is done: polls, results and the new-poll notification (V1-V3) in one pull request,
  #98. The frontend got items #007-#010.
- Next on the list was the idea "Building issue tracker" from the feature brainstorm of
  2026-11-04 (docs/cli_planning/2026-11-04-feature-brainstorm.md, section 8.2). It was marked
  "needs a planning session".

## 2. Decisions of the owner

**What the tracker is (docs/epics/E9_ISSUE_TRACKER.md)**
- Only common areas. A problem inside a flat goes to the private board <-> apartment thread of
  E8, because it would reveal who reported it.
- Photos come later (task I4), after the shared file storage with strict limits. The first
  version is text only.
- The whole building sees every issue: active ones and those that ended in the last 30 days.
  Seeing only one's own entrance was considered and rejected, because it leads to more
  duplicates.
- Only the board sees who reported an issue. Nobody sees who pressed "+1".
- No comments and no board notes, only statuses. A short public note on each status change was
  offered and rejected: anything to discuss belongs in the forum or in the thread.
- A duplicate is merged into the original. Its reporter and its "+1" people follow the original
  from then on. Simply closing it with a link was the alternative.

**Limits and the "urgent" flag are settings of the chairman**
- The agent first proposed a fixed limit of 10 reports per resident per day. The owner found it
  too high and wanted it configurable. The limit counts per apartment, not per person.
- The owner doubted the "urgent" flag is needed. It became a setting that is off by default.
- This needs a place for such settings, which did not exist: until now every limit lived in the
  server's `.env` (e.g. `MAX_TENANTS_PER_APARTMENT`). That place is task I0, "Building settings":
  - per building, stored in the database and changed in the app;
  - each module declares its own settings;
  - the chairman changes them, the board reads them, and every change is logged.
- First values:
  - 3 reports per apartment per day (1..20);
  - urgent off;
  - 1 urgent report per apartment per day (1..5).

**One pull request per large feature**
- A pull request now carries one large feature, an epic or a part of one. Each task has at least
  one commit, the contract first and then the code, so the pull request can be read commit by
  commit (AGENTS.md section 4).
- E3 part A was the first such pull request. E9 tasks I0-I3 go into one.

## 3. Proposals of the agent accepted with the design
- Two more statuses:
  - `DECLINED`: not a common-area issue, or not the association's to fix;
  - `WITHDRAWN`: the reporter takes the issue back while it is still `REPORTED`.
- The reporter may fix the text while the issue is `REPORTED`.
- The board may reopen an ended issue within 30 days.
- The board's action log:
  - every status change is stored with who made it;
  - everyone sees the timeline with dates only.
- The accountant does not see issues unless they also live in the building.
- Notifications:
  - `ISSUE_REPORTED` to the board, in the app by default;
  - `ISSUE_URGENT` to the board, mandatory on every channel;
  - `ISSUE_STATUS_CHANGED` to the followers.
  - The texts are system texts with the category, the entrance and the status, never the
    resident's words.

## 4. Order of work
I0 building settings -> I1 reporting, the list, "+1" and visibility -> I2 the board's work
(statuses, duplicates, the log) -> I3 notifications and the frontend handoff. I4 photos comes
after the shared file storage (local backlog L-8).
