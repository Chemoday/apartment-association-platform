# Epics

An epic is a large feature made of several tasks. Each epic has a page here (design and
decisions, written before the code) and a GitHub issue with the label `epic` that holds the task
checklist. Each task gets its own issue; an epic (or a part of one) goes into one branch and
one pull request, with the contract and the code of each task in their own commits.

| Epic | Phase | Page | Status |
|---|---|---|---|
| E1 Notifications | 2 | [E1_NOTIFICATIONS.md](E1_NOTIFICATIONS.md) | in-app, e-mail, Telegram, WebPush and reminders done (N2-N6), unsubscribe done (N8); mobile push (N7) next |
| E2 Billing and accounting export | 2 | [E2_BILLING_EXPORT.md](E2_BILLING_EXPORT.md) | idea |
| E3 Governance and voting | 2-3 | [E3_GOVERNANCE_VOTING.md](E3_GOVERNANCE_VOTING.md) | part A done (V1 polls, V2 results, V3 notifications); part B (official decisions) after its planning session |
| E4 IoT readings API | 2 | in docs/ROADMAP_MVP.md | idea |
| E5 Bulk import of apartments and owners | 2 | in docs/ROADMAP_MVP.md | idea |
| E6 AI OCR of meter photos | 3 | in docs/ROADMAP_MVP.md | idea |
| E7 Login | 2 | [E7_LOGIN.md](E7_LOGIN.md) | done (A1-A5): sessions, e-mail link, invitations, password |
| E8 Apartment profiles | 2 | [E8_APARTMENT_PROFILES.md](E8_APARTMENT_PROFILES.md) | done: P1 apartment cards, P2 board-apartment threads, P3 their notifications, P4 board micro-forum; frontend in the frontend backlog |
| E9 Building issue tracker | 2 | [E9_ISSUE_TRACKER.md](E9_ISSUE_TRACKER.md) | done: I0 building settings, I1 the tracker, I2 the board's work, I3 notifications; photos (I4) after shared file storage |
| E10 Maintenance calendar and log | 2 | [E10_MAINTENANCE_CALENDAR.md](E10_MAINTENANCE_CALENDAR.md) | designed (2026-11-08); part A (M1-M3, one pull request) in progress; part B (equipment, contractors) later |
| E11 Shared file storage | 2 | [E11_FILE_STORAGE.md](E11_FILE_STORAGE.md) | designed (2026-11-12); no code yet. Foundation for photos (E9 I4, E6), documents and signed ballots (E3 part B) |

Background for these choices: [docs/cli_planning/2026-10-31-post-course-epics.md](../cli_planning/2026-10-31-post-course-epics.md)
and [docs/cli_planning/2026-11-01-login-and-profiles.md](../cli_planning/2026-11-01-login-and-profiles.md) (E7, E8, N8),
[docs/cli_planning/2026-11-08-issue-tracker.md](../cli_planning/2026-11-08-issue-tracker.md) (E9),
[docs/cli_planning/2026-11-08-maintenance-calendar.md](../cli_planning/2026-11-08-maintenance-calendar.md) (E10),
[docs/cli_planning/2026-11-12-file-storage-and-backups.md](../cli_planning/2026-11-12-file-storage-and-backups.md) (E11).
