# E9. Building issue tracker

- **Phase:** 2. **Status:** designed with the owner (2026-11-08); tasks I0-I3 below in one pull
  request, photos (I4) after the shared file storage. Builds on E1 (notifications), E7 (login)
  and E8 (the board <-> apartment thread for problems inside a flat). **Epic issue:**
  [#104](https://github.com/Chemoday/apartment-association-platform/issues/104). Planning record:
  docs/cli_planning/2026-11-08-issue-tracker.md.
- **Goal:** a broken light or door closer in a common area is reported once, everyone can see
  that it is known and how it is going, and the board works through the reports in one place
  instead of the forum.

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/FRONTEND_GUIDE.md) in its first commit; where they differ,
the contract wins.

## 1. Owner decisions (2026-11-08)

- **Common areas only.** An issue is about the entrance, stairs, basement, roof, yard or another
  shared place. A problem inside a flat ("leak from the ceiling in flat 14") reveals who reported
  it, so it goes to the private board <-> apartment thread of E8 instead; the report form says so.
- **The whole building sees every issue:** active ones, and those that ended in the last 30 days,
  so a resident sees that a problem is already known. The location names the entrance.
- **The reporter is visible to the board only.** Nobody else learns who reported an issue or who
  pressed "+1".
- **No comments and no notes.** Residents press "+1 / I see it too" to show urgency; the board
  changes only the status. Anything to discuss goes to the forum or the thread.
- **Statuses:** Reported -> In progress -> Resolved, plus Waiting for contractor and Duplicate.
- **A duplicate is merged into the original:** its reporter and its "+1" people start following
  the original and are notified about it from then on.
- **Notifications:** the reporter and everyone who pressed "+1" are told when the status changes.
- **Limits and the "urgent" flag are the chairman's settings**, not fixed in code: how many
  reports an apartment may file per day (default 3, whoever in the apartment files them),
  whether residents may mark a report urgent (default off) and how many urgent ones an apartment
  may file per day (default 1). An urgent report notifies the board
  on every channel, mandatorily. The settings live in a new building settings page (section 2a,
  task I0) that later features reuse.
- **No photos in the first version.** They come as task I4 after the shared file storage (local
  backlog L-8: size limits, re-encoding, EXIF and GPS removed).

## 2. Module `issues`

A new module with its own tables (`iss_*`). It reads apartments, memberships and badges only
through `PropertyService` and DTOs; it does not use the forum (`communication`): an issue has a
status machine, a location and followers, which posts and comments do not have.

## 2a. Building settings (task I0)

The chairman's page of settings for the association, stored in the database per building and
changed in the app, not in the server's `.env`.
- **Store:** one row per building and setting (key, JSON value, who changed it and when), in
  `core` so every module can declare its own settings without `property` knowing them.
- **Declaration:** each module registers its settings in code (key, type, default, bounds), like
  domain events are registered; only the chairman changes them. Unknown keys are rejected; a
  missing row means the default, so a new setting needs no migration.
- **Reading:** a module asks for its building's value (typed); the request reads it once.
- **API:** `GET /api/v1/settings` (chairman and board: every setting with its value, default and
  bounds), `PUT /api/v1/settings` (chairman only, a partial map; `422` for an unknown key or a
  value out of bounds). Every change is logged (old value, new value, who, when).
- **The first settings (E9):**

| Key | Type | Default | Bounds |
| :--- | :--- | :--- | :--- |
| `issues.reports_per_apartment_per_day` | integer | 3 | 1..20 |
| `issues.urgent_enabled` | boolean | false | |
| `issues.urgent_per_apartment_per_day` | integer | 1 | 1..5 |

- Later candidates: `MAX_TENANTS_PER_APARTMENT` (today in `.env`), the reading reminder days, the
  chairman's info header (local backlog L-5).

## 3. An issue

- **Category** (fixed list, extended without changing the rest): `LIGHTING`, `DOORS_AND_LOCKS`,
  `LIFT`, `HEATING`, `WATER_AND_SEWAGE`, `ELECTRICITY`, `CLEANING`, `WASTE`, `YARD`,
  `ROOF_AND_FACADE`, `OTHER`.
- **Location:** the entrance (a number of the building's entrances, or none for the yard, the
  roof or the whole building) and a short place text ("3rd floor landing", 1..200 characters).
- **Title** (1..120 characters) and an optional **description** (up to 2000).
- **Urgent** flag, only when the chairman allowed it (see section 6).
- **Reporter:** the user (internal), and the apartment they report from (for the limits and the
  board's "Write to the apartment" link to the E8 thread). A resident with one apartment reports
  from it; with several, they choose one (`apartment_id`, like answering a poll). The chairman and
  a board member may report without an apartment.
- Kept on the issue: `created_at`, `updated_at`, `resolved_at` / `ended_at`, the number of
  followers, and a status history (section 4).

## 4. Statuses and the board's work

| Status | Meaning | Ended |
| :--- | :--- | :--- |
| `REPORTED` | New, not looked at yet | no |
| `IN_PROGRESS` | The board is on it | no |
| `WAITING_FOR_CONTRACTOR` | Ordered, waiting for a company | no |
| `RESOLVED` | Fixed | yes |
| `DUPLICATE` | Merged into another issue (`duplicate_of`) | yes |
| `DECLINED` | Not a common-area issue, or not the association's to fix | yes |
| `WITHDRAWN` | The reporter took it back while it was `REPORTED` | yes |

- Only the chairman and the board change the status (an accountant does not). An open status
  may move to `IN_PROGRESS`, `WAITING_FOR_CONTRACTOR`, `RESOLVED`, `DUPLICATE` or `DECLINED`;
  never back to `REPORTED`, which belongs to the reporter (editing and withdrawing). The board may
  reopen an ended issue (except `WITHDRAWN`) to `IN_PROGRESS` within 30 days of its end.
- `DECLINED` covers the report about a flat interior: the board then writes to the apartment in
  the E8 thread.
- `DUPLICATE` needs the original: another issue of the same building that residents can still
  see (open, or ended within 30 days) and that is not itself a duplicate or withdrawn. Its
  followers are added to the original's (once each); the duplicate keeps its own history and
  points to the original.
- Reopening a duplicate clears `duplicate_of`; the followers already added to the original stay
  there (they may stop following it).
- Every change is stored: from, to, when, by whom. Everyone sees the timeline of statuses with
  their dates; only the board sees who changed them (the board's action log).
- The board may also clear the "urgent" flag (a false alarm); that is logged too.
- The reporter may withdraw their own issue while it is `REPORTED` and edit its text while it is
  `REPORTED` (a typo); after that the text is fixed.

## 5. Who sees what

- **List and detail:** every active user of the building with an active membership, the chairman
  and the board. An accountant without an apartment does not see issues. Another building:
  never (404).
- Shown: active issues, and ended ones for 30 days after they ended (`RESOLVED`, `DUPLICATE`,
  `DECLINED`). `WITHDRAWN` issues only to their reporter and the board. The board sees every
  issue at any age (with a filter).
- Everyone sees: category, location, title, description, status and its timeline (dates only),
  `urgent`, the number of followers, and for themselves `i_reported` and `i_follow`.
- **The board also sees** the reporter as the privacy badge (`PropertyService` masker, the same as
  forum authors, never a raw name or contacts), the apartment it was reported from, and who
  changed each status.
- Never shown to non-board users: the reporter, the followers, who changed a status.

## 6. "+1", following and urgent reports

- **"+1 / I see it too":** any user who sees an open issue may press it once and take it back.
  It makes them a follower. The reporter is a follower from the start; they may stop following
  and follow again (docs/API.md section 10). The list may sort by the number of followers.
- **Urgent:** only when the chairman turned on `issues.urgent_enabled`. The reporter ticks it for
  something that cannot wait (no light on the whole staircase at night, water in the basement, a
  door that does not lock). It notifies the board mandatorily on every channel (section 7). The
  board can clear the flag. While the setting is off, the form has no flag and the API refuses it
  (`422 VALIDATION_ERROR`).
- **Limits per apartment:** at most `issues.reports_per_apartment_per_day` reports from one
  apartment in the last 24 hours, whoever in it filed them, of them at most
  `issues.urgent_per_apartment_per_day` urgent (`429 RATE_LIMITED` with `retry_after_seconds`,
  as for sign-in). Withdrawn reports still count. The chairman and the board are not limited,
  also when they report from their own apartment; their reports still count for that apartment.
  The count runs under a lock on the apartment, so two reports at the same moment cannot both
  take the last free slot. The board sees all reports, so harassment shows.

## 7. Notifications (E1)

| `event_type` | Recipients | Default | Mandatory |
| :--- | :--- | :--- | :--- |
| `ISSUE_REPORTED` | the chairman and the board, never the reporter | in-app on, external off | no |
| `ISSUE_URGENT` | the chairman and the board, never the reporter | every channel | yes |
| `ISSUE_STATUS_CHANGED` | the followers (reporter and "+1"), never the board member who changed it | every channel | no |

- An urgent report sends `ISSUE_URGENT` instead of `ISSUE_REPORTED`, not both.
- Texts are system texts (E1 rule): the category, the entrance and the new status, never the
  title or the description, which are written by residents. "Lighting, entrance 2: in progress."
  The link opens the issue (a new subject type `issue`).
- Merging a duplicate tells the moved followers once: "The issue you follow was merged into
  another one" with the link to the original.
- Right before an external message is sent, an issue the recipient no longer sees (moved out) is
  skipped (`SUBJECT_NOT_FOUND`), as for threads.
- Driven by durable domain events (ids only): `IssueReported`, `IssueStatusChanged`,
  `IssueMerged`.

## 8. API sketch (`/api/v1/issues`)

| Endpoint | Who | What |
| :--- | :--- | :--- |
| `POST /issues` | residents, board | Report an issue |
| `GET /issues`, `GET /issues/{id}` | everyone who sees it | List (open first, then the newest; filters: status, category, entrance) and detail with the timeline |
| `PATCH /issues/{id}` | reporter while `REPORTED` | Fix the text |
| `POST /issues/{id}/withdraw` | reporter while `REPORTED` | Withdraw |
| `PUT` / `DELETE /issues/{id}/follow` | everyone who sees it | "+1" and take it back |
| `POST /issues/{id}/status` | board | Change the status (`duplicate_of` for `DUPLICATE`) |
| `POST /issues/{id}/urgent/clear` | board | Clear the urgent flag |

## 9. Tasks

| Task | What | Done when |
| :--- | :--- | :--- |
| I0 ([#99](https://github.com/Chemoday/apartment-association-platform/issues/99)) | Building settings: the store, the declaration of settings per module, the chairman's API and its log; the three E9 settings | the chairman reads and changes settings, the board reads them, others get 403; bounds and unknown keys refused; a missing value is the default; tests |
| I1 ([#100](https://github.com/Chemoday/apartment-association-platform/issues/100)) | Module `issues`: report, list, detail, edit and withdraw, "+1", visibility; the contract | residents report and "+1", see every issue of the building and nothing about who reported; the board sees the reporter badge; another building gets 404; limits; tests |
| I2 ([#101](https://github.com/Chemoday/apartment-association-platform/issues/101)) | The board's work: statuses, the timeline and action log, duplicates merged, declined, reopen, clear urgent | every transition and its rules; followers move to the original once; tests |
| I3 ([#102](https://github.com/Chemoday/apartment-association-platform/issues/102)) | Notifications `ISSUE_REPORTED`, `ISSUE_URGENT`, `ISSUE_STATUS_CHANGED` and the merge notice, subject `issue`; frontend handoff | the right people are told once, never the actor; urgent is mandatory; texts in en, ru, et; tests |
| I4 ([#103](https://github.com/Chemoday/apartment-association-platform/issues/103), later) | Photos, after the shared file storage (L-8) | up to 3 images per report, re-encoded, metadata removed |

I0-I3 go into one pull request (owner decision 2026-11-08: one pull request per large feature),
with the contract and the code of each task in their own commits.

## 10. Open

- Linking an issue to a contractor and the maintenance log of the building passport (local
  backlog L-4), when that exists.
- Whether residents should be able to report anonymously even towards the board (today the board
  always sees the reporter, so it can ask back in the thread).
- A public statistics view (issues per month, time to resolve) for the general meeting.
