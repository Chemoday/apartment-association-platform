# Frontend Integration Guide (Task 6)

For the agent that builds the client in `frontend/`. The **contract** is
[`openapi.json`](openapi.json) (generated from the backend, always current) and the **rules** are in
[API.md](API.md). This guide lists what is easy to get wrong from the client side: behaviour that
the schema alone does not show, and places where the backend deliberately differs from what a
client would assume.

Do not change backend code from the frontend task. If the API is missing something, write it down
as a request for the backend (an issue) instead.

Repositories, commits and the way a frontend change reaches dev (Google AI Studio sync) are in
[FRONTEND_GIT_WORKFLOW.md](FRONTEND_GIT_WORKFLOW.md).

---

## 1. Project setup

- **Types from the contract.** `npx openapi-typescript docs/openapi.json -o frontend/src/api/schema.ts`.
  Regenerate whenever `docs/openapi.json` changes; never edit the generated file.
- **Same origin, no CORS.** The backend does not enable CORS. In development, proxy `/api`,
  `/health` and `/docs` to the backend (e.g. the Vite `server.proxy` option) instead of calling
  `http://localhost:8000` directly. Locally the backend listens on `BACKEND_PORT` (default `8000`).
- **Single command (course requirement).** `docker compose up --build` must still start the whole
  application, including the built frontend, and `pytest` must stay green. The image builds
  `frontend/` and the backend serves `dist/` at `/`, answering client routes with `index.html`
  (docs/FRONTEND_GIT_WORKFLOW.md, section 5).
- **Routes the frontend must not shadow:** `/api/v1/...`, `/health`, `/health/ready`, `/docs`,
  `/redoc`, `/openapi.json`. An SPA fallback (`index.html` for unknown paths) must exclude them, or API 404s
  turn into HTML pages.
- **Frontend tests run with one command** and cover the two-popup flow (Task 6 acceptance
  criteria). Mock the API with the generated types, so a contract change breaks the tests.
- **Mobile first:** the layout must work at 375 px.
- **Language:** everything in the repository (code, comments, docs, commit messages) is English.
  Ask the project owner which language the UI texts use before writing them.

## 2. Acting as a user (demo mode)

There is **no login endpoint** in the MVP (sign-in is planned in epic E7, section 12). The UI acts as a seeded user:

1. `GET /api/v1/demo/users` (no auth) returns the role switcher entries:
   `user_id`, `label` ("Owner Apt 14"), `building_role`, `apartment_number`, `relation_type`.
2. Send the chosen id as **`X-Demo-User-Id: <user_id>`** on every `/api/v1` request.
3. Keep the choice client-side (e.g. `localStorage`); default to "Owner Apt 14", where the demo
   story starts.

Rules:
- Read the ids from the endpoint; do not hard-code them.
- `GET /api/v1/demo/users` answers `404` when demo mode is off, and `[]` on an instance without demo
  data. Show a clear message instead of an empty switcher.
- If a request ever also carries `Authorization: Bearer ...`, the token wins over the demo header.
- `401` (`NOT_AUTHENTICATED`, `UNKNOWN_USER`) means the stored id is no longer valid: clear it and
  show the switcher again.

**The public demo is shared.** Every grader acts on the same database. Someone may already have
submitted Apt 14's October reading, acknowledged or resolved the emergency, moved the period to
`REVIEW_BY_BOARD`, or deleted a forum topic. The UI must handle every state the API can return,
not only the freshly seeded one ([API.md, section 5](API.md) describes the initial state). There
is no "reset demo" endpoint.

## 3. What each role sees

Build the navigation from `GET /api/v1/property/me` (`building_role`, `memberships[]` with
`can_submit_readings`), not from the switcher label.

| View | `USER` (resident) | `BOARD` | `CHAIRMAN` | `ACCOUNTANT` |
| :--- | :--- | :--- | :--- | :--- |
| My meters (`/meters/my-dashboard`) | own apartments | own apartments (Apt 15) | none (no apartment) | none |
| Submit a reading | own meters, if `can_submit_readings` | own apartment only; matrix rows are read-only (`403`) | any meter, incl. master meters | any meter, incl. master meters |
| Matrix, history, CSV export | history of own readings | yes | yes | yes |
| Period status, estimate missing | no | no | yes | yes |
| Publish emergency / notice | no | yes | yes | no |
| Resolve an emergency | no | yes | yes | no |
| Delete a forum topic | no | no | yes | no |
| Forum: read, post topics, comment | yes | yes | yes | yes |
| Apartment cards (`/property/apartments`) | no | yes | yes | no |
| Apartment readings (`/meters/apartments/{id}/readings`) | own apartments | every apartment | every apartment | every apartment |
| Messages with the board (`APARTMENT_THREAD`) | own apartments, threads since moving in | every apartment | every apartment | only as a member of an apartment |
| Board micro-forum (`BOARD_TOPIC`): read, post, comment, delete | no | yes | yes | no |
| Polls: create, open, close, extend, cancel | no | yes | yes | no |
| Polls: see | when targeted | all | all | when targeted |
| Polls: answer | when targeted and eligible | when targeted and eligible | when targeted and eligible | when targeted and eligible |
| Building settings (`/settings`): see | no | yes | yes | no |
| Issues: see, report, "+1" | own building | yes | yes | only as a member of an apartment |
| Issues: see the reporter | no | yes | yes | no |
| Maintenance calendar (`/maintenance`): tasks | no | yes | yes | no |
| Maintenance log | no | yes | yes | read |
| Building settings: change | no | no | yes | no |

A user with no apartment gets `apartments: []` from the dashboard; hide the meter card, do not
show an error. `GET /property/me` never returns the user's own name or email: greet with the
switcher label or the membership's `preview_badge`.

## 4. Errors

Every error has the same JSON body (`ErrorResponse` in the contract):
`{"error_code": "...", "message": "...", ...extra}`.

- **Branch and localize on `error_code`, never on `message`.** Messages are English developer
  texts and may change. Each endpoint in `openapi.json` lists the `error_code` values per status.
- **`422 VALIDATION_ERROR`** carries `errors: [{"loc": ["body", "value"], "message", "type"}]`.
  Map `loc[1]` to the form field. The submitted values are not echoed back. Other `422` codes
  (`READING_BELOW_PREVIOUS`, `INVALID_TARGET`, ...) have no `errors` list but extra fields.
- **`404` also means "not visible to you".** A post that does not target the caller, or was deleted
  by the chairman, is `404 POST_NOT_FOUND`, the same as an unknown id. Remove such items from lists
  instead of showing a broken page.
- **`413` with an empty body** comes from the edge proxy of the deployed environments: a request
  body over 1 MB (more only on upload routes, docs/API.md section 0). It has no `error_code`;
  treat a bare `413` as "too large" and never parse its body. Normal forms never get near it.
- **`500 INTERNAL_SERVER_ERROR`** carries `trace_id`. Show it in the error message ("Error code:
  …"), so a report can be matched to the backend logs. Every response also has an `X-Trace-Id`
  header; log it with failed requests.

## 5. Meter values are decimal strings

- Values and deltas are **strings in both directions** (`"1254.100"`). A JSON number is rejected
  with `422`. Input pattern: `^[0-9]{1,9}(\.[0-9]{1,3})?$`; responses always have exactly
  3 decimals (`"1254.000"`).
- **Never convert to a JavaScript `number` for arithmetic** (`0.1 + 0.2`), and never round. To
  compare or subtract (e.g. "consumption so far"), use a decimal library or scaled `BigInt`
  (multiply by 1000).
- **Normalize user input before sending:** many locales type a comma (`"128,5"`). Replace it with a
  dot, strip spaces, and reject thousands separators. Sending `"128.5"` is fine; the backend
  returns `"128.500"`.
- Negative values exist in responses: `unallocated_loss` can be below zero (it points to a wrong
  reading). `master_total` and `unallocated_loss` are `null` while a master meter has no reading.
- Show the unit from the payload (`m3`, `kWh`, `MWh`); kWh and MWh are never summed together.

## 6. The two-popup confirmation flow

`POST /api/v1/meters/readings` with `{meter_id, period_code, value, confirmation_level, reason}`.
A resident always sends the meter's `next_submission.period_code` from the dashboard (section 7).

```text
level 0 ──► 200 saved (normal value)                          done
        └─► 409 ANOMALY_CONFIRMATION_STEP_1  → popup #1 "unusually high, are you sure?"
               confirm ──► same value, level 1
                           └─► 409 ANOMALY_CONFIRMATION_STEP_2 → popup #2 "double-check, goes to billing"
                                  confirm ──► same value, level 2 ──► 200, is_anomaly_confirmed = true
any level ──► 422 READING_BELOW_PREVIOUS  → show previous_value, no popup
```

- **Always start at `confirmation_level: 0`.** The backend accepts level 2 directly, so a client
  that skips the popups would silently confirm anomalies. The flow is the UI's job.
- **If the user edits the value between the popups, start again at level 0.** Cancel at any popup
  sends nothing.
- STEP_1 carries `consumption_delta`, `average_delta` and `max_reasonable_delta` for the popup text;
  STEP_2 carries `consumption_delta`. Show the delta with the unit.
- Disable the submit button while a request is in flight; a double click with the same value is
  a harmless no-op on the backend, but a second popup chain is confusing.
- Other outcomes to handle on this form:
  - `409 PERIOD_CLOSED` (residents: their target period itself moved to review) and `409 PERIOD_LOCKED` (board,
    locked period): show "submission closed", refresh the dashboard.
  - `409 READING_SET_BY_BOARD`: the board corrected this reading; the resident cannot change it.
  - `409 LATER_READING_EXISTS`: an older period cannot change any more.
  - `409 WRONG_PERIOD` (residents): the reading belongs to `target_period_code`; refresh the
    dashboard and offer the form for that period.
  - `422 REASON_REQUIRED` (chairman / accountant changing an existing reading): show a required
    "reason" field whenever the cell already has a reading.
  - `403 FORBIDDEN`: a board member on someone else's meter, or a member without
    `can_submit_readings`. Better: do not offer the action.

## 7. Dashboard, matrix and periods

- `GET /meters/my-dashboard` without `period_code` picks the period residents can submit to.
  `period` is `null` when the building has none.
  `reading` is `null` until something was submitted for that meter in the shown period.
- **Which month** (docs/API.md section 2): every meter has `next_submission` with everything its
  form needs: `period_code`, `due_date`, `final`, `previous_value` (what the new value must not go
  below), `average_delta` and `reading` (already submitted for that period). Its period can
  differ from the shown `period` (one meter still due for October, another already for
  November), so the form always uses these fields. Show the month on the form ("Reading for
  November"). When `final` is `true`, the reading is a late one for the previous month: before
  sending, warn "This is your October reading. You cannot change it afterwards; your next
  reading will be for November." `next_submission: null` means nothing can be submitted now (no
  right to submit, or the period is missing or closed): hide the form.
- A user can belong to several apartments: render one card per apartment.
- **Consumption hints**: each dashboard meter has `average_delta` (the 3-period average the anomaly
  check uses) and `previous_delta` (last period's consumption), both decimal strings or `null`.
  Show them before submitting ("usually about 4.2 m³"); a delta far above `average_delta` will
  trigger the popups. There is no building average for residents: do not compute or show one.
- **Period selector and export archive**: `GET /meters/periods` lists every period of the building,
  newest first (`period_code`, `status`, `due_date`). Use it instead of guessing period codes.
- **Association header**: `GET /property/building` returns the name, registry code, address,
  apartment and entrance counts and `heated_area_m2` (a decimal string). Load it once per session.
- **Matrix** (`/meters/periods/{code}/matrix`): apartment status is the most urgent of its meters
  (`MISSING` > `ANOMALY_CONFIRMED` > `AUTO_ESTIMATED` > `SUBMITTED`). `master_meters` holds the
  basement meters with their ids, so the board can submit them from the matrix. The matrix has no
  names; residents are not identified in it.
- **Period status** (`PATCH /meters/periods/{code}/status`): only
  `OPEN_FOR_RESIDENTS ↔ REVIEW_BY_BOARD ↔ LOCKED`, one step at a time. A wrong step is
  `409 INVALID_PERIOD_TRANSITION` with `allowed_statuses`: use them to build the buttons.
- **Estimate missing** works only in `REVIEW_BY_BOARD` (`409 PERIOD_NOT_IN_REVIEW`); running it
  again estimates nothing new (`estimated_count: 0`). Refresh the matrix afterwards.
- **History** (`/meters/readings/{id}/history`): entries are chronological; `changed_by` is a masked
  badge or `null` for the system. Never try to show who it "really" was.
- **CSV export needs the auth header**, so a plain `<a href>` does not work: `fetch` it with
  `X-Demo-User-Id`, turn the response into a `Blob` and download it with the file name from
  `Content-Disposition` (`readings-2026-10.csv`). `404 EXPORTER_NOT_ENABLED` hides the button.
- **Apartment cards** (epic E8, chairman and board): `GET /property/apartments` for the list
  (number, entrance, floor, area, owner / tenant / family counts) and
  `GET /property/apartments/{id}` for one card. Residents are only `{relation_type, since}`:
  show "Owner since 1 Oct 2026", never try to find out who it is. The card's meter block comes
  from `GET /meters/apartments/{id}/readings` (the latest 24 periods, newest first; each meter
  lists only the periods that have a reading, so align them by `period_code`;
  `source: "AUTO_ESTIMATED"` is an estimate). The same readings call works for a resident's own
  apartment and an accountant (who has no cards).
- Periods open by themselves on the 1st of each month, but never close by themselves. `due_date`
  (end of the local deadline day) is shown to users, drives the reading reminders (docs/API.md
  section 6) and ends the time a late reading for the previous month is accepted.

## 8. Emergencies and the forum

- **Banner:** `GET /communication/emergencies/active` returns the alerts that target the caller.
  Show the sticky red banner for items with `acknowledged_at: null`; "Acknowledge" is
  `POST /emergencies/{id}/acknowledge` (idempotent, per user). Poll the endpoint (e.g. every
  30-60 s and on window focus). The notification bell polls separately (section 11).
- The chairman and the board see **every** active emergency, including those targeted at another
  entrance; show the target ("Entrance 2") in their banner.
- **Resolve** (`POST /emergencies/{id}/resolve`, board) ends it for everyone; it stays readable in
  the feed with `is_active: false`.
- **Publishing:** `target_scope` `ALL_BUILDING` (no other target fields), `ENTRANCE`
  (`target_entrance`) or `APARTMENT_LIST` (`target_apartment_ids`, 1..500). Forum topics are
  always `ALL_BUILDING`. Apartment ids and entrances come from `GET /property/apartments`
  (chairman, board) or the chairman matrix (`apartments[].apartment_id`, `entrance`, `floor`).
- **Author badges** are already masked by the backend. Render
  `"<display_label> • <role_badge>"` (`"Apt. 14 • OWNER"`). `display_label` is English text that
  may contain a name the author chose to show; display it as is, do not parse or translate it.
  `role_badge` (`OWNER`, `RESIDENT`, `BOARD`, `ACCOUNTANT`) can be localized.
- **Privacy mode selector:** `PATCH /property/memberships/{membership_id}/privacy` per apartment;
  the response's `preview_badge` is exactly what neighbours will see. Badges are resolved on every
  read, so old posts change too after the switch: reload the feed.
- **Writing on behalf of an apartment:** a user with several apartments may pass
  `author_apartment_id` (one of their own). Without it, forum topics and comments use the first
  apartment; board posts use none.
- **`is_mine`** marks the caller's own posts and comments; there is no other author identity.
- **Feed paging:** `GET /communication/posts?limit=&offset=`, newest first. New posts shift the
  offsets, so de-duplicate by `id` when loading more. Post detail pages its comments with
  `comments_limit` / `comments_offset`; `comments_count` is always the total.
- `comments_enabled: false` hides the comment form (`409 COMMENTS_DISABLED` otherwise).
- **Delete** (`DELETE /communication/posts/{id}`, chairman, forum topics only) answers `204`;
  emergencies and notices answer `409 POST_NOT_DELETABLE`.
- **Free text limits:** title 1..255, post body 1..10000, comment 1..4000 characters after
  trimming. Control characters are rejected. Show a counter and trim before checking "empty".
- **Messages with the board** (`APARTMENT_THREAD`, docs/API.md section 4):
  - A "Messages" page lists `GET /communication/posts?post_type=APARTMENT_THREAD`, sorted by
    `last_activity_at`; show it next to the title. The forum feed (no `post_type`) never contains
    threads. On the apartment card the board adds `&apartment_id=<id>`.
  - New thread: `POST /communication/posts` with `post_type: "APARTMENT_THREAD"`,
    `target_scope: "APARTMENT_LIST"`, `target_apartment_ids: [<one apartment>]`, no
    `author_apartment_id` and `comments_enabled: true`. A resident picks one of their own
    apartments (`GET /property/me`); the board starts from the apartment card.
  - Replies are ordinary comments; omit `author_apartment_id`, the server decides whether the
    caller writes from the apartment or as the board.
  - `422 APARTMENT_HAS_NO_RESIDENTS`: nobody in the apartment has an account yet, so nobody
    could read the thread; say so instead of a generic error.
  - No delete or edit buttons on threads.
- **Board micro-forum** (`BOARD_TOPIC`, chairman and board only; docs/API.md section 4):
  - Its own page, e.g. "Board room": `GET /communication/posts?post_type=BOARD_TOPIC` (newest
    activity first); new topic with `POST /communication/posts` and `post_type: "BOARD_TOPIC"`,
    without target fields and without `author_apartment_id`; replies are comments.
  - Authors appear by full name (`display_label`), on purpose and only here: render the badge as
    elsewhere, do not add anything to it.
  - Every board member may delete a topic (`DELETE /communication/posts/{id}`); ask for
    confirmation. Nothing notifies about new topics, so show the newest activity at the top.
  - The forum feed (no `post_type`) never contains board topics.

## 9. Dates and ids

- Timestamps are ISO 8601 in UTC (`2026-11-04T21:59:59Z`, i.e. 23:59:59 in Tallinn). Display them in the building's local
  time (Tallinn, `Europe/Tallinn`) with `Intl.DateTimeFormat`, not with string slicing.
- All ids are UUID strings; treat them as opaque.

## 10. Privacy checklist for the UI

- Never display, store or log anything that looks like a real name except a `display_label` the
  backend returned.
- Do not put user ids, badges or free text into analytics or URLs beyond what routing needs (post
  ids are fine).
- Do not cache other users' data across a role switch: clear the client cache when the acting
  user changes.

## 11. Notifications: the bell and the feed

Contract: docs/API.md section 6. The backend creates notifications from events; the client only
reads them. There is **no WebSocket and no server-sent events** (owner decision 2026-10-31): the
client polls, which is enough for a building and needs no extra infrastructure. Reaching a user
whose app is closed is the job of the external channels (e-mail, Telegram, WebPush, mobile push),
not of the feed.

- **Badge:** `GET /notifications/unread-count` every **60 s** while the tab is visible
  (`document.visibilityState === "visible"`). Stop the timer while the tab is hidden, and poll at
  once when it becomes visible again and after a role switch (the acting user changed). The user's
  own actions never notify that user, so they need no extra poll. One timer per tab, no parallel
  requests: skip a tick while the previous request is still running.
- **Feed:** load `GET /notifications/feed` when the bell is opened and when the count changed while
  it is open; page with `limit`/`offset`. Do not poll the feed itself.
- **Errors:** on a network error or `5xx` keep the last count and retry on the next tick; do not
  shorten the interval. `404` on these routes means the module is switched off
  (`NOTIFICATIONS_ENABLED=false`): hide the bell.
- **Read:** `POST /notifications/feed/{id}/read` when an item is opened, "mark all read" with
  `POST /notifications/feed/read-all`. Neither response contains the count: after "read all" set the
  badge to 0; after a single read subtract 1 only if the item was unread in the client's list (the
  call is idempotent), or simply fetch `unread-count` again.
- **Texts:** the feed returns codes (`event_type`, `params`), not texts; render them per locale,
  like `error_code`. Load the post (`subject_id`) if the title is needed.
- **Messages with the board** (epic E8): `APARTMENT_MESSAGE` reads "New message from the board"
  when `params.from_board` is `true`, else "New message in your apartment's conversation with the
  board"; `APARTMENT_MESSAGE_TO_BOARD` reads "New message from apartment
  `{params.apartment_number}`". Both open the thread (`subject_id`). In the preferences, the
  board's type is off outside the app by default; show it only to the chairman and the board.
  A notification stays in the feed after its reader moved out or left the board: `404` on the
  thread then means "no longer available", not an error.
- The emergency banner keeps its own polling (section 8); an emergency also appears in the feed.
- **Linking Telegram** (settings page; only when `GET /notifications/preferences` lists
  `telegram` without `CHANNEL_NOT_ENABLED` or `DEMO_MODE`): `POST /notifications/telegram/link-code`
  returns a one-time `code` and a `deep_link`; show the link (and the code for typing
  `/start <code>`), valid 10 minutes. `429 RATE_LIMITED` carries `retry_after_seconds`. After the
  user pressed Start in Telegram, reload `GET /notifications/bindings`; "Unlink" is
  `DELETE /notifications/bindings/{binding_id}`. Chat ids are never shown or sent.
- **Unsubscribe page** `/unsubscribe#<token>` (N8, linked from non-mandatory e-mails; no sign-in
  needed, works in demo mode too):
  1. Read the token from `location.hash` and remove the hash at once
     (`history.replaceState(null, "", "/unsubscribe")`), as on the link page of section 12.
  2. Show "Stop e-mails like this one?" and one button; call
     `POST /api/v1/notifications/unsubscribe?token=<token>` (no body, no auth header) only on its
     click: mail scanners open links but do not click.
  3. On `200`, show the localized name of `event_type` ("Reading reminders by e-mail are off") and
     a link to the notification settings to turn it back on (sign-in needed there). On
     `400 INVALID_LINK`: "This link no longer works; change e-mails in the notification settings."
- **Telegram:** the bot also understands `/stop` (unlinks the chat); the settings page can mention
  it next to "Link Telegram".
- **WebPush** (settings page, "Notify this browser"; only when the preferences list `webpush`
  without `CHANNEL_NOT_ENABLED` or `DEMO_MODE`, and the browser has `PushManager`):
  1. Register a service worker, ask `Notification.requestPermission()` on a click (never on page
     load), get the key from `GET /notifications/webpush/vapid-public-key` and call
     `registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key})`.
  2. Send `subscription.toJSON()` plus a `label` (e.g. "Chrome on Android", 1..100 characters) to
     `POST /notifications/webpush/subscriptions`; keep the returned `binding_id` locally. `201` is a
     new device, `200` an update of this one; call it again after each login and when the
     subscription changes. `409 DEVICE_LIMIT_REACHED`: at most 10 devices, show the bindings list.
  3. The service worker's `push` event carries JSON
     `{"v": 1, "event_type", "title", "body", "url", "tag", "urgent"}`: call
     `showNotification(title, {body, tag, data: {url}, requireInteraction: urgent})`, and on
     `notificationclick` open `url`. The texts are already in the user's language.
  4. **On logout** delete the binding (`DELETE /notifications/bindings/{binding_id}`) and call
     `subscription.unsubscribe()`, so a shared browser stops receiving the previous user's alerts.
  5. **On page load** (logged in) compare `(await registration.pushManager.getSubscription())
     ?.options.applicationServerKey` (an `ArrayBuffer`: encode it as base64url without padding
     first) with the served key. If they differ (the server's key was
     changed), delete the stored binding, call `unsubscribe()` and subscribe again; otherwise the
     device keeps failing and still counts towards the 10 devices.

## 12. Sign-in and accounts (epic E7)

Contract: docs/API.md section 7, all of it in `docs/openapi.json` (the password since task A5).

**Demo mode.** Until an environment leaves demo mode, keep the role switcher of section 2. The
sign-in screens work next to it. Account pages (Security, My residents, People) refuse the demo
header, so they need a real sign-in even in demo mode.

### Tokens
- **Access token in memory only:** a module-level variable, never `localStorage`,
  `sessionStorage` or a readable cookie.
- **Refresh:**
  - On app start, call `POST /auth/refresh` with `credentials: "same-origin"` and
    `X-Requested-With: fetch`. `200` means signed in; `401 SESSION_EXPIRED` means show the
    sign-in screen.
  - Refresh again about a minute before `expires_in` runs out.
  - On `401 INVALID_TOKEN` from any call, refresh once and repeat that call once.
  - `401 UNKNOWN_USER` means the account was closed: drop the token and show the sign-in screen.
  - Allow one refresh at a time per tab. Several tabs at once are fine: the server has a grace
    window.
- **Bearer and demo header:** send `Authorization: Bearer <access_token>`. Once signed in, do not
  send `X-Demo-User-Id`.
- **CSRF header:** send `X-Requested-With: fetch` on every `/api/v1/auth/*` call.

### Screens
- **Sign in:**
  - An e-mail field (at most 254 characters after trimming; the server answers 422 beyond) and
    "Send me a link". After sending, always show "If this e-mail is
    registered, a link is on its way", and allow "Resend" only after 60 seconds.
  - A second tab, "Sign in with a password". On `401 INVALID_CREDENTIALS` show one generic error
    text. On `429` show a countdown from `retry_after_seconds` and suggest the link.
- **Link page** `/login/link#<token>`:
  1. Read the token from `location.hash`, then remove the hash at once with
     `history.replaceState(null, "", "/login/link")`.
  2. Show a "Continue" button, and call `POST /auth/magic-link/redeem` only on its click (mail
     scanners open links but do not click).
  3. Then:
     - `SIGNED_IN`: go to the app;
     - `REGISTRATION_REQUIRED`: show the registration form;
     - `SIGN_IN_TO_ACCEPT`: show the invitation ("You are invited as a tenant of apartment 14").
       First try `POST /auth/refresh`: if the person is signed in, show "Accept" at once.
       Otherwise show "Sign in to accept". Signing in by link opens another tab, so this page
       may be reloaded; the invitation link stays valid, and opening it again is the simple way
       back. "Accept" calls `POST /auth/invitations/accept` with the token. "Not now" only closes
       the page; there is no decline call, and the invitation simply expires;
     - `400 INVALID_LINK`: "This link is used, expired or no longer valid", plus the sign-in
       form.
- **Registration** (after an invitation link):
  - The heading comes from `invitation`, e.g. "You are invited as the owner of apartment 14".
  - Fields: full name, an optional phone, the language, and how the name is shown to neighbours
    (the preview of section 1). Hide the last one for `STAFF`.
  - Submit to `POST /auth/registration` within 30 minutes. After that, open the link again.
  - On `409 EMAIL_ALREADY_REGISTERED`: "Sign in, then accept the invitation".
- **Settings > Security:**
  - `GET /auth/password` tells whether a password is set: show "Set a password", or "Change" and
    "Remove". Fetch it again after a change or a removal.
  - Set, change or remove the password. Ask for the current password, or offer a new sign-in link,
    when the answer is `403 REAUTHENTICATION_REQUIRED`. Rules to show: at least 15 characters; a
    phrase of a few words is fine. Show a character counter and a "show password" toggle, and map
    `PASSWORD_TOO_WEAK.reason` (`TOO_SHORT`, `TOO_LONG`, `TOO_COMMON`) to a hint.
  - Password fields: `autocomplete="current-password"` / `"new-password"`, no autocorrect or
    autocapitalize, and the "show password" toggle on the sign-in form too. Any script is allowed,
    and a wrong keyboard layout is the usual cause of a failed sign-in: the toggle lets the person
    see it.
  - The list of sessions: `device_kind` localized, with "Sign out" per session and "Sign out
    everywhere".
- **Sign out:** first delete the WebPush binding (section 11, it needs the Bearer token), then
  call `POST /auth/logout` and drop the access token from memory.
- **My residents** (owners, one block per owned apartment), from
  `GET /auth/apartments/{id}/residents`:
  - residents, with `invited_email` where the owner invited them, so tenants who all show as
    "Apt. 14" can be told apart;
  - "Invite a tenant" (an e-mail), plus "Replace" and "Remove" for each tenant;
  - "Resend" and "Cancel" for each pending invitation;
  - on `409 TENANT_LIMIT_REACHED`: "At most 3 tenants".
- **Chairman > People:**
  - The list of people comes from `GET /auth/users`: each person with a label, the role and the
    memberships, plus the ids for the actions below. Labels follow the person's privacy mode, so
    the page shows no names a person did not agree to show. `invited_email` helps tell apart
    people you invited, staff included; `is_me` marks your own row (for a handover: make someone
    else chairman, then lower your own role).
  - Invite an owner (an e-mail and the apartment number) or staff (an e-mail and a role).
  - The invitation list with its statuses (`NO_LONGER_VALID` explained). E-mails typed by owners
    appear masked.
  - For each person: change the role (explain `409 LAST_CHAIRMAN`), end a membership, or close
    the account. The confirmation names the effects: signed out everywhere, personal data
    removed. If `account_closed` comes back, say so.

### Privacy
- The API returns e-mail addresses only from invitations: in full to the person who typed them
  in, and masked to everyone else who may see the invitation (co-owners, the chairman, another
  chairman). It never returns phone numbers.
- Do not put e-mails or tokens into analytics, URLs (except the fragment of the link page) or
  logs.

## 13. Polls (epic E3)

Contract: docs/API.md section 8.

- **Notification:** `POLL_OPENED` (`subject_type` `poll`, `params.closes_at`) reads "The board
  started a poll. Please answer by `<local date of closes_at>`" and opens the poll page.
  `params.closes_at` is the deadline at opening; the poll page shows the poll's own `closes_at`,
  which the board may have extended since.
- **Deadline picker:** the board picks a day; send the end of that day in local time (23:59:59),
  so "answer by <date>" names the last day on which answers are taken.

- **Board:** a "Polls" page with drafts, open and closed polls. A draft is edited freely
  (`PUT /governance/polls/{id}`) and opened with `POST .../open`; after that the questions are
  fixed. Close early, extend (`PATCH` with a later `closes_at`) and cancel are on the open poll.
  The form explains who answers (`eligibility`), whether there is one answer per apartment or
  per person (`unit`), and that small groups can hint at who answered what.
- **A question has two settings:** `answer_mode` (pick one, pick several, or own value) and
  `value_type` (text, number, date). Option values and own values are strings: numbers as decimal
  strings, dates as `YYYY-MM-DD`; render both in the reader's language with `Intl`, and send them
  back in the same canonical form. Show a date picker for `DATE`, a number field for `NUMBER`.
- **List:** each item has `can_answer` and `answered`: show "please answer" only when
  `can_answer` is true and `answered` false; a tenant sees an owners-only poll with
  `can_answer: false`.
- **Answering:** show the form when `can_answer` is true; `PUT .../ballot` with `answers` (and
  `apartment_id` when `answerable_apartment_ids` has more than one). Answering again replaces the
  answer. For unit `APARTMENT`, `my_ballots` shows what the apartment answered ("your apartment
  answered"), whoever in the apartment did; never show or ask who.
- **Status:** `OPEN` polls with a passed `closes_at` come back as `CLOSED`; trust `status`, do not
  compare times yourself. A `CANCELLED` poll shows no answers.
- `422 INVALID_ANSWER` names the question (`question_id`) and the `reason`; mark that question.
- **Results:** show a "Results" link when `results_available` is true (the board: from opening,
  live; everyone else: after closing) and load `GET .../results`. Show the participation ("12 of
  30 apartments answered", or people for unit `PERSON`), and per question the bars of `options`
  (labels from the poll's options by `option_id`), the `number` minimum, maximum and average, the
  `dates` counts, or for text answers only `answered` (the board also gets `texts`). Render
  numbers and dates in the reader's language. Percentages are of `answered`.

## 14. Building settings (epic E9)

Contract: docs/API.md section 9.

- **Page:** "Association settings" for the chairman (edit) and the board (read only); nobody else
  sees the menu entry (others get `403 FORBIDDEN`). Load `GET /api/v1/settings`.
- **One control per setting by `type`:** a number field with `minimum` / `maximum` for `INTEGER`,
  a switch for `BOOLEAN`. The label and a one-line help text come from the locales by `key`
  (unknown keys: show the key itself, so a new backend setting is never hidden). Group by the
  prefix (`issues.` = "Issue reports").
- Show "default" next to settings with `is_default: true`, and a "Reset to default" action for
  the others, which sends `null` for that key.
- **Saving:** one `PUT` with only the changed keys. On `422 VALIDATION_ERROR` mark the fields named
  in `errors[].loc[2]`; nothing was saved.
- Changes apply at once to the next request. Residents cannot read this page: a feature that
  depends on a setting tells its own clients (e.g. the issue tracker of task I1 says whether the
  urgent flag is offered).

## 15. Issue tracker (epic E9)

Contract: docs/API.md section 10; notifications in docs/API.md section 6.

- **Page:** "Issues" for everyone with an apartment and for the board (an accountant without an
  apartment gets `403`: hide the menu entry, from `GET /property/me`). Open issues first, then
  recently ended ones; filters by status, category and entrance.
- **Before reporting:** show the open issues of the chosen category and entrance first, so people
  press "+1" instead of reporting again.
- **The form** (`GET /issues/form`): category, entrance (from `entrances`, or "outside / whole
  building" = `null`), place, title, description, and the urgent switch only when
  `urgent_enabled` is true. With several `apartment_ids` ask which apartment reports. Say clearly:
  "Only common areas. For a problem inside your flat, write to the board" (link to the messages
  of section 4).
- **`429 RATE_LIMITED`:** "Your apartment has reached today's limit of reports"; show when it is
  possible again from `retry_after_seconds`. The chairman sets the limit (section 14).
- **Issue page:** status with the timeline (dates), category, location, text, the follower count,
  the "+1 / I see it too" button (`can_follow`; when `i_follow`, "You follow this issue" with
  "Stop following"), and for the reporter "Edit" / "Withdraw" while `can_edit`.
- **Board view:** `reporter` shows the badge and a link to the apartment's card and thread
  (`apartment_id`); nobody else ever sees who reported or who follows.
- `404 ISSUE_NOT_FOUND`: "This issue is not available" (withdrawn, too old, or not yours to see).
- **The board's work** (chairman and board): on the issue page a status menu with "In progress",
  "Waiting for contractor", "Resolved", "Duplicate of..." (pick the original from the open and
  recently ended issues; offer the ones of the same category and entrance first) and "Declined"
  (suggest writing to the apartment when it is inside a flat). On an ended issue, "Reopen" within
  30 days. "Not urgent" clears the flag. Show the action log (`timeline` with `changed_by` and
  `action`) to the board; residents see the timeline with dates only.
- `409 INVALID_ISSUE_TRANSITION`: reload the issue (someone else changed it meanwhile).
- **Notifications** (`subject_type` `issue`, open `/issues/{subject_id}`): `ISSUE_REPORTED` "New
  issue report: {category}, {location}"; `ISSUE_URGENT` "Urgent issue report: ..." (mandatory,
  show it like an emergency in the feed); `ISSUE_STATUS_CHANGED` "The issue you follow
  ({category}, {location}) is now: {status}", or with `merged: true` "... was merged into another
  report of the same problem". `{location}` is "entrance N" or "outside the entrances" for
  `entrance: null`. Never show an issue title in a notification. The preferences matrix now has 40
  rows; show `ISSUE_REPORTED` and `ISSUE_URGENT` only to the chairman and the board, and
  `ISSUE_STATUS_CHANGED` to everyone who can use the tracker.
- **Photos** (up to 3 per issue): section 17.

## 16. Maintenance calendar and log (epic E10)

Contract: docs/API.md section 11.

- **Pages** for the chairman and the board: "Maintenance" with the tasks (next due date, state
  badge: upcoming, due, overdue in red, paused) and "Log". The accountant sees the log only.
  Residents see nothing of it; they get the notices (task M2).
- **Task form:** title, internal instructions, "every N days / months / years", the first due
  date, "remind N days before", and an optional notice for residents (title, text, category,
  target as for notices). Explain that a monthly task from the 31st falls on the last day of
  shorter months.
- **Done / skip:** "Mark done" asks the date (default today), a note and an optional cost (a
  decimal string, render it in the reader's language); "Skip this time" needs a note. Send the
  shown `current.occurrence_id`; `409 OCCURRENCE_CLOSED` means someone was faster: reload.
- **Edit:** changing the period or the next due date continues the rhythm from the new date; say
  so next to the fields. Pause, resume (optionally with a new date) and archive have
  confirmations; archived tasks are read only.
- **Log:** newest first, filters by task and dates, `recorded_by` as the badge it is; costs only
  here, never on a residents' page.
- **Publishing (task M2):** show on the task when its reminder went out (`published_at`, link to
  the board topic `board_post_id`), the residents' notice (`notice_post_id`), a warning when
  `notice_failed` is true ("the notice could not be published: correct its target for the next
  time"), and the number of overdue reminders.
- **Notifications (task M3):** `MAINTENANCE_DUE` (`subject_type` `maintenance_task`, open the task)
  "Maintenance due on {due_date}" or, with `overdue`, "overdue since {due_date}" (load the task for
  its title); shown to the chairman and the board only in the settings. `NOTICE_PUBLISHED`
  (`subject_type` `post`, open the notice) "New notice from the board"; shown to everyone with an
  apartment and to the chairman and the board. The preferences matrix now has 48 rows.
- In the board room and the feed, a post with `origin`
  `MAINTENANCE` gets a small "automatic reminder" (or "automatic notice") label next to the
  author's badge.

## 17. Photos (epic E11; issue reports first)

Contract: docs/API.md section 12 (rules shared by every upload) and section 10 (the photos of an
issue). The server accepts only JPEG of at most 2560 px: **the client scales and converts every
photo before sending it.**

- **Picking:** two buttons, "Take a photo" (`<input type="file" accept="image/*"
  capture="environment">`, opens the camera directly) and "Choose from gallery" (the same without
  `capture`). iPhone photos (HEIC) open in Safari like any image.
- **Scaling, in a Web Worker:** `createImageBitmap(file, {imageOrientation: "from-image"})`, draw
  it on an `OffscreenCanvas` scaled so the long edge is at most **1920 px** (never above 2560),
  then `convertToBlob({type: "image/jpeg", quality: 0.85})`. The canvas drops every piece of
  metadata, so the location of the photo never leaves the phone. Without `OffscreenCanvas` do the
  same on a hidden `<canvas>` with `toBlob`.
- **When scaling or converting fails** (an old browser, a format it cannot open): send nothing and
  say "This photo cannot be used; take one with the camera". Never send the original.
- **Before sending:** at most 3 photos per report (`can_add_photo`); show each picked photo at once
  from `URL.createObjectURL` and revoke the URL when done.
- **Sending:** report the issue as text first (`POST /issues`), then upload each photo on its own
  (`POST /issues/{id}/photos`, body = the JPEG blob, `Content-Type: image/jpeg`) with a fresh
  `Idempotency-Key` (`crypto.randomUUID()`) per photo, kept for its retries. Show progress with
  `XMLHttpRequest.upload.onprogress` (fetch has no upload progress). On a network error retry only
  that photo with the same key; the report itself is already saved.
- **Showing:** fetch `.../photos/{id}?variant=thumb` for lists and the issue page and `display` when
  the photo is opened, with the access token as for every request, and show it from
  `URL.createObjectURL(blob)`. Responses are cacheable for good; a photo never changes.
- **Deleting:** a bin icon where `can_delete` is true.
- **Retention, told to people:** next to the "add photo" button: "Photos are kept while the issue
  is open and deleted 30 days after it is resolved, to save space." On a resolved issue with
  photos, show "Photos will be deleted on {photos_delete_at}". When the board marks an issue as a
  duplicate or declines it, warn in the confirmation: "Its photos will be deleted".
- **Errors:** `400 UPLOAD_INTERRUPTED`, `408 UPLOAD_TIMEOUT`: retry that photo with the same key
  (upload at most 2 files at once); `409 UPLOAD_REMOVED`: "This photo was removed" (never send
  it again, also not with a new key); `409 IDEMPOTENCY_KEY_REUSED`: a bug of the client (a key
  used for two files): fix the client, do not retry blindly; `403 UPLOADS_DISABLED` "Photos are
  switched off in this demo"; `409
  PHOTO_LIMIT_REACHED` "At most 3 photos"; `409 ISSUE_ENDED` "This issue is closed"; `413` (also a
  bare 413 from the edge, docs/API.md section 0), `422 IMAGE_TOO_LARGE`: scale again, smaller;
  `415`, `422 INVALID_IMAGE`: "This photo cannot be used"; `429 RATE_LIMITED`: retry after
  `retry_after_seconds` (the server is busy, or the daily limit); `507`: "There is no room for more
  photos now; tell the board".
- A future native app does the same with the image tools of the system (scale on decoding,
  convert to JPEG) and the same `Idempotency-Key`; the contract is the same for every client.

## 18. Documents of the association (epic E11)

Contract: docs/API.md section 13 (and section 12 for the upload rules).

- **Page "Documents"** for everyone with access (residents, the chairman, the board, the
  accountant): a list with title, category, date, size; a filter by category; a download button
  (`GET .../file`, with the access token, saved from a blob; the server always sends it as an
  attachment). Translate the categories in every locale; show an unknown one as "Other".
- **Uploading** (the chairman, the board, the accountant): pick a PDF (`accept="application/pdf"`),
  enter the title (prefilled from the file name), the category, the audience and optionally the
  date of the document; send the file itself as the body (`Content-Type: application/pdf`) with
  the other values in the query and a fresh `Idempotency-Key`; show the progress. The accountant
  sees only the audience "Board and accountant". Check the size (at most 20 MB) before sending.
- **Audience labels:** `EVERYONE` "Everyone in the building", `BOARD_AND_ACCOUNTANT` "Board and
  accountant", `BOARD` "Board only". Staff see the audience on every document; residents only
  ever see `EVERYONE` ones, so hide it for them.
- **Editing** (the chairman and the board, `can_edit`): title, category, audience, date.
- **Deleting** (the chairman, `can_delete`): confirm "Delete this document for everyone?".
- `uploaded_by` (staff only) is a badge, never a name.
- **Before the form:** `GET /documents/upload-options` says whether to show "Upload" at all
  (`can_upload`), which audiences to offer and the size limit. Prefill the title from the file
  name without the folder and without ".pdf".
- **Editing:** send only the fields the person changed (`PATCH` changes only those), so two board
  members editing different fields at once do not overwrite each other.
- **Errors (their own texts, not the photo ones):** `413` "The file is larger than 20 MB";
  `415 UNSUPPORTED_MEDIA_TYPE` "Only PDF files"; `400 UPLOAD_INTERRUPTED`, `408 UPLOAD_TIMEOUT`
  "The upload broke off; try again" (same key); `409 UPLOAD_REMOVED` "This document was removed
  meanwhile"; `422` on `title` or `document_date` next to the field; `403 UPLOADS_DISABLED`
  "Uploads are switched off in this demo"; `507` "The association's storage is full: delete old
  documents or ask the operator"; `404 DOCUMENT_NOT_FOUND` "This document is not available".

## 19. Storage used by the association (epic E11 task F4)

Contract: docs/API.md section 12 (`GET /api/v1/files/usage`) and section 6
(`STORAGE_ALMOST_FULL`).

- **For the chairman and the board:** on the association settings page (section 14) a block
  "Storage": a bar `used_percent` of the quota, the used and total size, and a line per category
  ("Photos", "Documents"; translate, show an unknown one by its name) with its bytes. Mention
  `pending_deletion_bytes` as "Deleted files waiting to be erased (within 14 days)" when it is
  not zero; they are not part of the used room.
- **The notification** `STORAGE_ALMOST_FULL` (`subject_type` `storage`, open the storage block):
  "The association's files use {used_percent}% of its storage. Delete old documents or ask the
  operator of the server for more room." It comes at 70% and 90% of the
  room for files, before uploads are refused. Show it to the chairman and the board only in the
  preferences; the matrix now has **52** rows (it had 48).

