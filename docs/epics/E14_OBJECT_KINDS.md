# E14. Objects of several kinds: apartments, parking spaces and garages

- **Phase:** 2. **Status:** designed with the owner (2026-11-25) and reviewed by three independent
  CTO reviews the same day (section 9). Five pull requests, each safe for dev on its own
  (section 6). Builds on E8 (apartment profiles), E13 (filling the building, connecting the
  residents), E3 part A (polls) and E10 (maintenance notices). Planning record:
  docs/cli_planning/2026-11-25-object-kinds.md.
- **Goal:** a more varied association. Besides apartments, an association has parking spaces and
  garages. One person may own several such objects, and a parking space or a garage may belong to
  a member of the association who has no apartment in the building. Members are reached by the
  kind of object they hold, so a notice about the garage gate does not go to the whole building.

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/FRONTEND_GUIDE.md) in its first commit; where they differ,
the contract wins. Section 10 collects the work this epic gives the frontend.

## 1. Owner decisions (2026-11-25)

- **A parking space or a garage is an apartment ownership of its own**: its own part of the land
  register, its own share in the common ownership and its own vote (Apartment Ownership and
  Apartment Associations Act, § 22 (1)). Its owner is a member of the association with or without
  an apartment. The same model later serves an association of garages only.
- **Members are reached by kind:** the board addresses the whole building, everything, parking
  spaces, garages, an entrance or a list of objects. The same choice applies to notices,
  emergency alerts, maintenance notices, forum topics and polls. A target naming a kind the
  building has no object of is refused (`422 INVALID_TARGET`, as an entrance that does not
  exist); reading or filtering by such a kind simply returns an empty list.
- **"The whole building" is the apartments only; "everything" is every object** (owner, after the
  third review): `ALL_BUILDING` reaches the people of the apartments, never through a parking
  space or a garage; the new target `ALL_OBJECTS` reaches the people of every object of every
  kind. An owner of a garage without an apartment gets what is addressed to garages, to their
  garage, or to everything; with an apartment they also get the whole building through it.
- **Forum topics can be addressed by kind.** The board addresses any target; a resident addresses
  the whole building when they hold an apartment, or only kinds of which they hold an object (an
  owner of a garage writes to the garages, a resident without a garage does not).
- **A tenant of a parking space or a garage has the least access** (after the first review; the
  owner: "a parking space gives the least access"): what is addressed to their kind, their object
  or everything, and the conversation with the board about their object; not the documents or
  the issue tracker. Owners of every kind and everyone with a membership of an apartment keep
  them (section 3.5). A role decides first: staff keep what their role gives, whatever they
  rent.
- **One notification per person:** a person reached through several objects (an apartment, a
  parking space and a garage) gets one notification of an event per channel (section 3.4).
- **An informal poll is answered per object:** an owner of two objects switches between them and
  answers for each (`BallotRequest.apartment_id`, already in E3 part A).
- **The object a request is made from, when the request names none** (after the second review):
  for an issue report and a ballot, the person's only object; with several, their only
  apartment; otherwise `422` "choose the object" as today. This keeps a client that omits the
  field working for an owner of an apartment who also gets a parking space (section 3.6). The
  author of a post, a comment or a chat message is a different rule (the badge, section 3.2).
- **Official polls (E3 part B, later):** when creating one the chairman chooses how votes count:
  per object, per owner, or by the share in the common ownership. The share is a field of its own
  (as in the land register), not computed from the area: a parking space may have no area, and
  the share is not always proportional to it.
- **A company as an owner needs no change now:** its name fits the full name (255 characters in
  the database, 200 in the join form).
- **The chat is the room of the apartments** (owner, after the third review: the quick talk of
  the house does not concern the garages): one room per building as today, for the people of the
  apartments and the board. An owner or a tenant of a parking space or a garage without an
  apartment does not take part. Built ready for rooms per area: the room has a target, today
  always the whole building, so a room for the garages or the parking spaces later is a room with
  another target (section 3.5; section 7).
- **Labels:** `Apt. 14` stays; a parking space is `P14`, a garage `G12` (section 2.4).
- **Floors:** a parking space or a garage may have a floor (an underground parking is floor -1),
  or none; it is never set to 1 by default.
- **Counts** (after the second review): the limits of invitations and the join codes count
  objects of every kind; the chairman's summaries count per kind.
- **Five pull requests** (after the second review, the owner left the split to the agent):
  section 6.
- **Texts per kind** (owner, 2026-11-26): the agent writes the Russian and Estonian forms with K1
  and K2 without waiting for a review; the owner reviews all translations later in a sprint of
  its own on localization (section 2.4).
- **Not in this epic:** a forum topic for one entrance, a master meter of the garages, an
  entrance for a parking space, and the setup wizard per kind (E13 R7, the first item after this
  epic).

## 2. The model

### 2.1 One table, a kind per row
- `property_apartments` gets `kind`: `APARTMENT`, `PARKING`, `GARAGE` (a named `CHECK` through
  `varchar_enum`, server default `APARTMENT`). Existing rows become `APARTMENT` (migration 037;
  there are no installations yet, so no data has to be carried over).
- **The name stays "apartment"** in the code, the tables and the API. docs/ARCHITECTURE.md gets a
  glossary line: an apartment is an object of ownership of any kind (`kind`). "Unit" is not used:
  it already means the voting unit of a poll (`APARTMENT`, `PERSON`) and the unit of a meter
  (m3, kWh). The screens say "apartment", "parking space" or "garage" by kind.
- **Why not separate tables:** memberships, invitations, join codes, the poll electorate, the
  privacy badges and the connection overview would all have to be built twice. With a column they
  work for every kind at once.

### 2.2 Fields by kind
| Field | `APARTMENT` | `PARKING`, `GARAGE` |
|---|---|---|
| `number` | required | required |
| `entrance` | required | always `NULL` (no staircase) |
| `floor` | required | optional, may be negative (an underground parking is floor -1) |
| `area_m2` | required | optional |
| `on_paper` | as now | as now |

- One `CHECK`: an apartment has an entrance, a floor and an area; another kind has no entrance.
  Every existing row passes it (all three columns are `NOT NULL` today).
- `entrance` and `floor` lose their default of 1 (ORM and server), so an object written without
  them never becomes "entrance 1, floor 1" and is never reached by an entrance target. The
  building template's own default floor of 1 (`src/core/filling/layout.py`) applies to apartments
  only; an empty floor of another kind stays empty.
- **Nullable in every DTO:** `entrance`, `floor` and `area_m2` are nullable wherever an object is
  returned (`ApartmentDTO`, `NewApartment`, `ApartmentSummary`, `MatrixApartment`, the auth and
  meters views): the object fields are typed `AreaAmount | None`, so the serializer never sees
  `None` and the building's `heated_area_m2` stays a required string. Without this one parking
  space without an area makes the board's apartment list fail.
- The number is unique per building **and kind**: `UNIQUE (building_id, kind, number)`, so
  "Apartment 1" and "Garage 1" can both exist. Two objects of one kind whose labels collide
  (`PARKING` `1` and `P1` are both `P1`) are refused where objects are created (the building
  template), since the unique key does not see it.
- The order of objects everywhere: apartments, parking spaces, garages; then entrance (none last)
  and natural order of the number. One sort key (`object_sort_key`), and the SQL order
  (`_APARTMENT_ORDER`: a `CASE` on the kind, `NULLS LAST`, the number `COLLATE "C"`) is kept equal
  to it by a test. The order matters beyond lists: the first membership of a person decides the
  default badge. `COLLATE "C"` is a small change of today's order for numbers that differ only in
  case (`14a`, `14B`); the database image already orders by code point, and K1a states and tests
  it.
- **Area and counts are of apartments only:** the heated area and the number of apartments of
  `GET /property/building`, and the register cross-check of the building template
  (`src/core/filling/compare.py`). The building view adds the number of objects per kind.
- **Consumption per m2** (meters dashboard) counts only objects with an area, in the consumption
  and in the area alike, so a garage meter does not inflate the figure. `apartments_counted` and
  the average per apartment mean "objects with this meter" (written in docs/API.md).

### 2.3 Memberships by kind
- `OWNER` and `TENANT` exist for every kind (renting out a garage or a space is common).
- `RESIDENT` exists for apartments only. Nothing writes `RESIDENT` today: there is no `RESIDENT`
  invitation (docs/API.md section 7, "Family members are not invited") and the demo data writes
  owners and tenants only. So this is a defensive guard in `PropertyService.open_membership` that
  refuses a `RESIDENT` membership of another kind.
- Nothing else changes: a person already holds any number of memberships
  (`property_memberships`, `CurrentUserDTO.memberships`), and an existing account accepts an
  invitation to another object. `ApartmentMembershipDTO` gains `apartment_kind` (the query of
  `get_current_user` already loads the whole apartment row, so it stays one query).

### 2.4 Labels
- The badge names the object by kind, short (owner 2026-11-25): `Apt. 14`, `P14` for a parking
  space, `G12` for a garage. One function, `object_label(kind, number)`, used by
  `format_author_badge` and every caller of it (each loads the kind with the number, also for an
  object the author no longer holds).
- The letter and the number are written without a space; a number that already starts with the
  letter, in any case, is shown as it is: `12` -> `G12`, `G12` -> `G12`, `g12` -> `g12`,
  `P-012` -> `P-012`, `1G` -> `G1G`. The number is stored as the chairman typed it.
- Badges stay language-independent text (docs/FRONTEND_GUIDE.md, "Author badges"), so the short
  labels need no translation; badges are resolved on every read, so no stored data changes. The
  privacy modes are unchanged: `I. P. (G12)`, `Ivan Petrov (G12)`.
- **Texts are not badges:** a notification or a mail does not write "Apartment G12". A name of
  the kind cannot be inserted into a sentence either: Russian and Estonian put the object in a
  case (genitive, elative) and agree the verb with it, and the catalogue loader checks only the
  placeholders, so a broken sentence would pass the tests. So **each sentence that names an object
  gets a variant per kind** (for example `subject.APARTMENT_MESSAGE_TO_BOARD.GARAGE`), chosen by
  `apartment_kind` and falling back to the apartment variant; `target.KINDS` and the affected
  objects of an emergency use plural forms per kind. Catalogues: notifications and auth (the
  maintenance catalogue names no object). The agent writes the Russian and Estonian forms; the
  owner reviews them in a later localization sprint. Stored `params` without a kind mean an
  apartment.

### 2.5 Where the shared pieces live
No module imports `property.policies` today; other modules use `property.service` and
`property.schemas`. So:
- **`property/schemas.py`** (public, pure): `ObjectKind`, `TargetDTO`, `object_label`,
  `parse_object_ref`, `object_sort_key`.
- **`PropertyService`**: `apartment_by_ref(building_id, kind, number)`,
  `target_problem_in_building(building_id, target)` (the consistency and existence checks, today
  copied in communication and governance with the same messages), and `targeting_clause(...)`
  (section 3.1).
- **Two rules for the default object, not one** (the third review; today four copies):
  - `first_object_in(user, target)`: the badge of forum topics, comments and chat messages.
    Today it is the first membership, never a `422`; in K1a it stays exactly that, and from K2
    it is the first object inside the target (section 3.2). Emergencies and notices keep no
    object by default, also the notices the maintenance calendar publishes.
  - `chosen_object(candidates, requested)`: issue reports (over the person's memberships) and
    ballots (over the poll's units the person may answer for): the only one; with several, the
    only apartment (from K1); otherwise `422`.
  - K1a adds characterization tests of all five defaults first, because no existing test pins
    the default of a post or a chat message for a person with two apartments.
- `format_author_badge` stays in `property/policies.py`, used inside property.

## 3. Who is reached

### 3.1 One target rule for everyone
- `TargetScope` gets `ALL_OBJECTS` and `KINDS` (with `target_kinds`, a non-empty set of kinds).
  The rule is per object, so a person is reached through every object of theirs that the target
  holds, and only through those.
  - `ALL_BUILDING` ("the whole building"): every apartment. The meaning of today's value stays:
    the building has only apartments today.
  - `ALL_OBJECTS` ("everything"): every object of every kind.
  - `KINDS`: every object of the given kinds.
  - `ENTRANCE`: the apartments of that entrance only (other kinds have none).
  - `APARTMENT_LIST`: the given objects, of any kind.
- `ALL_OBJECTS` is a target of its own rather than `KINDS` with every kind, so that a stored
  target (a recurring maintenance notice, a poll) keeps meaning "everything" when the building
  later gets a kind it did not have.
- **One copy of the rule:** the target DTO (`TargetDTO`: scope, entrance, apartment ids, kinds);
  one consistency check; `apartment_in_target(target, *, apartment_id, kind, entrance)`; and one
  SQL expression,
  `PropertyService.targeting_clause(user, *, scope, entrance, apartment_ids, kinds, member_only)`.
  The caller passes its own column expressions (`Post.target_*`, `Poll.target_*`) and gets a
  SQL condition back, so property never imports another module's models. `member_only` keeps a
  difference that exists today: a poll is visible only through a membership, while a post to the
  whole building is visible to staff without one (an accountant). That staff clause covers
  `ALL_BUILDING`, `ALL_OBJECTS` and a `KINDS` target that includes apartments (it reaches at least
  the whole building).
- **Equality tests:** the feed, the emergency banner, the polls and the notification recipients
  are tested against `apartment_in_target` over every scope and kind. For recipients this is the
  SQL of `can_read_post` against `resolve_recipients` (recipients already use the rule in
  Python), compared for members only: the staff see whole-building posts but are not their
  recipients. It matters most for emergencies: the dispatcher re-checks a notice and a thread
  message against SQL when it sends them, but sends an emergency's title and body after checking
  only that the alert is still active; an optional re-check of `can_read_post` for
  `EMERGENCY_PUBLISHED` is part of K2.
- **Enum members and migrations go together:** the scope `CHECK`s are generated from the enum
  (`varchar_enum`) and the migration catalogue test compares them exactly, so `ALL_OBJECTS` and
  `KINDS` appear only in the commit with migration 038, and the `ObjectKind` column check only
  with 037. Migrations write literal check texts, never the model constants. The same commit
  carries the validation and the targeting of both: the request models share `TargetScope`, and
  today's target checks treat an unknown scope like `APARTMENT_LIST`, so an enum member without
  them would let such a post reach the database and fail there with a 500.
- The tables with a target get `target_kinds` (JSONB array, set exactly for `KINDS`):
  `comm_posts`, `gov_polls` and the notice of a maintenance task (`maint_tasks`,
  `notice_target_kinds`). Their checks are rebuilt in migration 038 with the same text as the
  models: `ck_comm_posts_target_consistent`, `ck_comm_posts_target_scope`,
  `ck_comm_posts_forum_whole_building` (it becomes "a forum topic is `ALL_BUILDING`, `ALL_OBJECTS`
  or `KINDS`"),
  `ck_gov_polls_target_consistent`, `ck_gov_polls_target_scope`, and `ck_maint_tasks_notice_target`
  (the maintenance scope column has no enum check of its own). The checks also validate the
  values: `target_kinds` is a non-empty array of known kinds for `KINDS` and `NULL` otherwise, as
  the posts check validates the ids of `APARTMENT_LIST`; one unknown string would break every read
  of that row.
- **Stored data keeps decoding:** what is stored is the payload of domain events
  (`core_domain_events`: `EmergencyAlertPublished`, `OfficialNoticePublished`,
  `JoinRequestSubmitted`) and the `params` of notifications (`notif_deliveries`). They get the new
  fields with defaults (`target_kinds = ()`, `apartment_kind = APARTMENT`), so rows written before
  the epic still decode (events are read through a pydantic adapter, `core/events_registry.py`).
  `EmergencyRefDTO` is not stored but carries `target_kinds` too, and a resolved emergency copies
  them.

### 3.2 Communication
- `EMERGENCY` and `OFFICIAL_NOTICE`: the board may address `ALL_OBJECTS` and `KINDS`. A fire or a
  water cut that concerns the garages too is addressed to everything: the whole building does not
  reach an owner of a garage without an apartment.
- `FORUM_TOPIC`: `ALL_BUILDING` as today, `ALL_OBJECTS` or `KINDS`. The board may name any of
  them; anyone else `ALL_BUILDING` only with a membership of an apartment, and `KINDS` only with
  kinds of which they hold an active membership; `ALL_OBJECTS` is for the board; else
  `403 FORBIDDEN`. That check comes before any `422` (including the
  target check), so a resident learns nothing about objects they do not hold. Comments are seen
  by whoever sees the topic.
- **The badge context must stay inside the target** (a privacy rule, for posts and comments): a
  comment signed `Apt. 14` under a topic for the garages would tell everyone that Apt. 14 holds a
  garage. It comes with K2, together with the first targets by kind (a notice to the parking
  spaces has comments too), not one pull request later.
  - Omitted `author_apartment_id` of a forum topic or a comment: the author's first object inside
    the target (in the order of section 2.2); none, for a board member without an object there.
    Emergencies and notices keep no object by default.
  - An `author_apartment_id` outside the target of the post is `422 INVALID_AUTHOR_APARTMENT`, for
    posts and comments. This also tightens existing `ENTRANCE` and `APARTMENT_LIST` posts, where an
    object outside the target is accepted today: a contract change, listed in K2.
- `APARTMENT_THREAD` (the board and one object) works for every kind unchanged.

### 3.3 Polls
- The same targets. The electorate fixed when a poll opens holds the objects of the target; with
  unit `PERSON` a person counts once, even with an apartment and a garage.
- `eligibility` `RESIDENTS` = every active member of a targeted object; `OWNERS` = its owners.
- **The electorate holds only the objects of the target** (the third review): a whole-building
  poll has apartments only, so tenant X of Apt. 1 who also rents `P-2` is offered Apt. 1 only,
  and a tenant of `P-2` alone is neither offered the poll nor notified of it. The third review
  found that with a whole building of every kind, X would be offered `P-2` through its owner and
  could overwrite the owner's ballot; with the rule per object (section 3.1) this cannot happen,
  and a test keeps it so for `_caller_units`, `may_answer` and `get_poll_audience`.
- A poll every owner must answer, also of garages without an apartment, is addressed to
  everything (`ALL_OBJECTS`). Official polls of a general meeting (E3 part B) will need it.

### 3.4 Notifications
- Recipients follow the target rule above. Texts that say "your apartment" (`messages.csv`, the
  `target.{scope}` texts) name the object by kind (section 2.4), and `target.KINDS` is added.
- `READING_DEADLINE` is unchanged: it goes to objects with an active meter, and a parking space
  has none.
- **One notification per person, event and channel** (owner): a person reached through several
  objects (an apartment, a parking space and a garage), or both as a resident and as a board
  member, gets one notification of an event per channel. It holds today at three levels, and the
  epic must keep all three: the recipients are resolved once per person (`resolve_recipients`,
  the poll audience, the reading submitters), the resident and the role lists are merged by
  person, and the database refuses a second delivery (`uq_notif_deliveries_dedup` over the event's
  key, the person, the channel and the device; the event's key names the post, the poll or the
  period, never an object). So nothing in the epic keys a delivery or a recipient by object, and
  a notification about a target by kind says "for the parking spaces and the garages", not "your
  garage". The one exception is by design: each object has its own conversation with the board,
  so a message in the garage's conversation is an event of its own.

### 3.5 The shared spaces and the tenants of a parking space or a garage (task K2b)
- **Who is reached** needs nothing more: the rule per object (section 3.1) already keeps an owner
  or a tenant of a parking space or a garage out of the whole building and the entrances, in
  posts, emergency banners, polls, poll notifications and every other notification. Also no in-app
  row: in-app notifications are stored as sent without a re-check, so a test checks that such a
  person gets no `EMERGENCY_PUBLISHED` or `POLL_OPENED` row of a whole-building target.
- **The shared spaces** (the documents, the issue tracker) are for every member of the
  association: a membership **gives shared access** unless it is `TENANT` of a `PARKING` or
  `GARAGE` (`ApartmentMembershipDTO.shared_access`); `CurrentUserDTO.shared_access` is true when
  any active membership gives it. A tenant of a parking space or a garage only gets `403
  FORBIDDEN` there, as an accountant without an apartment does today (the accountant keeps the
  documents).
- **The role decides first** (owner): `shared_access` counts memberships only; each module keeps
  its own clause for the staff, because they differ today (documents admit all the staff, an
  accountant included; the chat and the issue tracker admit the board only; polls admit nobody
  without a membership). Each module replaces only its "any active membership" with
  `shared_access`. An accountant who also rents `P-2` keeps what an accountant sees, and gets what
  is addressed to `P-2` on top.
- `GET /property/me` exposes `shared_access`, so the frontend hides what such a tenant cannot
  open.
- **The chat follows its room's target** (owner): who takes part is decided by the target rule of
  section 3.1, not by `shared_access`. The building's room has the target `ALL_BUILDING`, so the
  people of the apartments take part, and the board by its role as today. The badge of a chat
  message is the author's first object inside the room's target (`first_object_in`), so an owner
  of Apt. 14 and `P1` writes as `Apt. 14`. The chat module keeps one room per building and gets
  no column now: the room's target is a constant of the module (`BUILDING_ROOM`), passed to the
  same checks a room per area will use (section 7).
- The board <-> object thread works for them as for every member.

### 3.6 The object a request is made from
- When a request names no object (`apartment_id` of an issue report, of a ballot), the object is
  the person's only one; with several, their only apartment; otherwise `422` as today. Today an
  owner of Apt. 14 who also gets `P1` would start getting `422` from a client that omits it.
- This is `chosen_object` (section 2.5), for issue reports and ballots only. Posts, comments and
  chat messages keep their own rule, the badge (`first_object_in`), which never answers `422`.

## 4. What stays the same
- **Issue tracker, documents (`EVERYONE`):** every member with shared access (section 3.5) takes
  part, as today. An owner of a garage is a member of the association. The chat is for the
  apartments (section 3.5).
- **Meters:** a garage's electricity meter belongs to the garage and counts in the building's
  balance like any object's meter. A master meter of the garages is a later question (section 7).
- **The chairman's matrix and the accounting export** gain `kind`: a filter in the matrix, and a
  `kind` field with a default in `ReadingExportRow` (the plugin contract,
  `src/plugins/registry.py`), written as the last column of the CSV export, so existing imports of
  the accountant keep working. The comment that calls an empty entrance "the building master
  meter" is corrected: the master meter is the row without an apartment number.

## 5. Objects named by number
A number no longer names one object on its own. Every input that refers to an object by number
takes the kind too, and a missing kind means an apartment (old files and requests keep working).
One parser (`parse_object_ref(kind, number)`) and one lookup
(`PropertyService.apartment_by_ref(building_id, kind, number)`, replacing `apartment_by_number`,
which today takes the first object with that number). Every lookup table keyed by number becomes
keyed by `(kind, number)`; today some keep the last object with a number, so a parking space "1"
would silently replace Apt. 1:
- the single owner invitation (`OwnerInvitationCreate.apartment_number` gains `apartment_kind`);
- the bulk invitations (E13 R4a, `src/modules/auth/bulk.py`): the list stays positional
  (`number; e-mail; language`), with an optional fourth cell for the kind
  (`1; a@example.org; ; PARKING`); an empty cell means an apartment. A prefix in the number cell
  is not used, because a number may itself be `P-2`. The parser accepts 2 to 4 cells; a kind that
  is not known is a new row outcome (`INVALID_KIND`, a contract change), and a kind written in the
  third cell stays `INVALID_LOCALE`. The daily limit is computed from the list of objects, not from
  a table keyed by number (today Apt. 1 and `P1` would count once). Until K4 the bulk invitations
  take apartments only;
- the building template (E13 R3, `src/core/filling/layout.py`, an operator command line tool): a
  `kind` column for objects and for the meters' objects, added after the existing meter columns
  (the meter columns are taken by position today); rows of another kind need no entrance, and an
  entrance on them is a row problem, not a database error; the default floor applies to apartments
  only; a row of a building meter refuses a kind; the key of a meter includes the kind; two
  spellings of a number are one object only within one kind; colliding labels are refused,
  compared case-insensitively (`P1` and `p1`); the command prints the objects per kind;
  `create_apartments` returns ids keyed by kind and number; the building data
  (`src/core/filling/service.py`) and the register cross-check (`compare.py`) look up by kind too.
  The building meter's limit keeps scaling with every object, since the master meter measures them
  all;
- the register draft (E12 X3) keeps drafting apartments only (section 7);
- the demo data keys its objects by kind and number.

## 6. Tasks and pull requests

Each task: a contract commit, then a code commit; `docs/openapi.json` regenerated with every code
commit that changes the API. Every commit keeps `pytest`, the OpenAPI check and ruff green.

| Task | PR | What | Risk |
|---|---|---|---|
| K0 | 1 | **Design:** this page and its planning record | |
| K1a | 1 | **Refactoring, no change of behaviour** (section 2.5): `ObjectKind` as a plain enum (no column yet), `TargetDTO` with no kinds yet, `object_label`, `parse_object_ref`; one target check and existence check; `targeting_clause` with `member_only`, used by communication and governance, with equality tests over today's scopes; `apartment_by_ref` (apartments only for now); `create_apartments` keyed by kind and number; one sort key and the SQL order with an equality test; the two default-object helpers `first_object_in` and `chosen_object`, after characterization tests of today's five defaults | the shared filter must stay equal to the rule; tests that call `apartment_in_target` change with its signature |
| K1 | 2 | **Kinds of objects:** migration 037 (section 2.2) with the model in one commit; nullable DTOs; every place that assumes an entrance, a floor or an area (sorted entrances in `PropertyService.targeting_clause` and issues, which fail on a `NULL` entrance; the chairman's people list, `GET /auth/users`; the matrix; consumption per m2; the building view); `kind` on every DTO and text that names an object by number, including the connection overview and the join codes (section 10.2 lists them); texts per kind; labels; the `RESIDENT` guard; `apartment_kind` of the single invitation; bulk invitations limited to apartments; the default object of issues and ballots (section 3.6); the glossary; the rollback note; a smoke test of every read endpoint | the sweep: an object with a `NULL` entrance must break nothing |
| K4 | 2 | **Objects named by number:** the kind in the bulk invitations (fourth cell) and the building template, colliding labels, the register cross-check with apartments only | old files without a kind keep working |
| K2 | 3 | **Targets by kind:** `TargetScope.ALL_OBJECTS` and `KINDS`, their validation and targeting, and migration 038 together (section 3.1); the whole building becomes the apartments only; the shared rule and SQL, recipients (one per person), events and `params` with defaults, texts, maintenance notices; who may publish which target; the badge context inside the target for posts and comments (section 3.2); the emergency re-check; the rollback note for 038 | the check migrations; old stored events |
| K2b | 3 | **The shared spaces and the chat** (section 3.5): `shared_access` and the access checks of the documents and the issue tracker; the chat by its room's target (`BUILDING_ROOM` = `ALL_BUILDING`), its badge inside that target | every access check that meant "any membership" |
| K3 | 4 | **Forum topics by kind** (403 before 422) | privacy |
| K5 | 4 | **The chairman's views:** the summaries per kind (section 1, "Counts"), the matrix filter by kind, the export column, the join code sheet and the privacy notice of the join page, which say "apartment" for every kind | the plugin contract |
| K6 | 5 | **Demo data** (section 6.1) | dev start-up; existing demo databases |

**Why five pull requests** (the second review): small reviews, and each one is safe for dev,
where a merge into `main` deploys at once.
1. **PR 1 (K0, K1a):** no change of behaviour or contract.
2. **PR 2 (K1, K4):** the model. Every DTO already carries `kind` and nullable fields. No parking
   space or garage exists on dev or in the public demo before PR 5: both run in demo mode, and
   the building template fills only a real installation. So the gate after PR 2 is no version tag
   (no release for associations) before the frontend handles `kind`, and anything the sweep of K1
   misses would first show at PR 5; the smoke test of K1 (section 6.2) is there to catch it
   earlier.
3. **PR 3 (K2, K2b):** who is reached, one security change reviewed as a whole.
4. **PR 4 (K3, K5):** forum topics by kind and the chairman's screens.
5. **PR 5 (K6):** the demo objects, merged only after the frontend handles `kind` and the nullable
   fields, because from then on the demo shows them on dev and in the public demo.

Size by the third review: about 14-17 days with tests (K1a 1.5-2, K1 4, K4 1, K2 3-4, K2b 2, K3
1, K5 1, K6 1.5-2). The owner's decision after it (the whole building is the apartments only)
makes K2b smaller, since who is reached follows from the rule per object: about 13-16 days. K1 is the largest: about 25 response types, the texts per kind and about ten
test files to adapt.

**Commit order** (each commit green; the contract commit first):
1. **PR 1:** the pure pieces in `property/schemas.py` (with `apartment_in_target` in its final
   keyword signature, so its tests change once); the characterization tests of the five defaults;
   `targeting_clause` with its equality tests; the shared target and existence checks; the sort
   key and the SQL order; `apartment_by_ref` and `create_apartments` keyed by kind and number; the
   two default-object helpers.
2. **PR 2:** the K1 contract; nullable DTOs and code safe for `NULL`, without a migration;
   migration 037 with the model, the order with `CASE` and the migration test; `kind` on the DTOs
   and the labels; texts and `params` per kind and events with defaults; the `RESIDENT` guard, the
   kind of the single invitation and the default object; then the K4 contract and the K4 code.
3. **PR 3:** the K2 contract; migration 038 with `KINDS`, its validation and targeting in one
   commit; events, texts, recipients and maintenance notices; the badge context; then the K2b
   contract and the K2b code.
4. **PR 4:** K3, then K5. 5. **PR 5:** K6.

**Rollback past migration 037** (to docs/DEPLOYMENT.md with K1, like the note of E13 R3): an
older release does not know `kind`; once a parking space or a garage exists, it picks the wrong
object by number and fails on a `NULL` entrance (for example every request of a garage owner and
the board's people list). This includes the **automatic** rollback of `deploy.sh` after a failed
health check: once such objects exist (on dev and the public demo after PR 5), an automatic
rollback to a release before E14 breaks those screens, so a failed deploy after that point is
fixed forward. No backup is taken before an update (neither `deploy/deploy.sh` nor
`install/update.sh` makes one), and deploys never run a downgrade; the downgrade of 037 refuses
while objects of another kind exist, which protects a manual `alembic downgrade` only. Until PR 5
an automatic rollback stays safe: no object of another kind and no `KINDS` row exists.

**Rollback past migration 038** (with K2): an older release cannot load a post or a poll with
`target_scope = 'KINDS'` or `'ALL_OBJECTS'` (an unknown enum value), so the feed and the poll list
fail for everyone. The downgrade of 038 refuses while such rows exist; the note in
docs/DEPLOYMENT.md says so.

### 6.1 Demo data (K6)
The demo seed runs only on an empty database, and every environment runs in demo mode, so the new
objects are added by an idempotent completion of the demo building on start (as the registry code
was added after migration 004): it adds what is missing and never duplicates.
- **It must never stop the start-up.** The seed runs in the container's entrypoint under `set -e`,
  in one transaction, and a failed health check rolls the deploy back. In the public demo anyone
  can act as the chairman, so the demo may be changed in any way (an account closed, a poll
  closed, a topic deleted, an emergency resolved, an e-mail taken). So, by construction:
  - the completion runs in a savepoint (`begin_nested`); any error is logged as
    `seed_demo_completion_failed` (without personal data), the savepoint is rolled back and the
    start-up continues;
  - every insert is `ON CONFLICT DO NOTHING` without a target (also the unique e-mail, the unique
    membership and the unique object number, not only the id), and a dependent row is inserted
    only after its parent is checked by id;
  - a step whose demo user is inactive is skipped, and an existing poll's electorate is never
    changed (it is fixed when the poll opens);
  - the new demo users have names nobody else has (the demo e-mail is derived from the full name);
  - nothing runs on a real installation.
  Tests run the completion on a "vandalised" demo database and with the e-mail of a new demo user
  already taken.
- **Ids:** apartments keep `demo_id("apartment:{number}")`; new objects use
  `apartment:PARKING:1`, `apartment:PARKING:P-2`, `apartment:GARAGE:12`; memberships
  `membership:{key}:{kind}:{number}`.
- **Objects:** parking spaces `1` (`P1`, no area, the same number as Apt. 1 on purpose) and `P-2`
  (a number with the prefix, floor -1); garage `12` (`G12`, 18.50 m2). G12 has one electricity
  meter (`meter:GARAGE:12:ELECTRICITY`, kWh, `max_monthly_delta` 1000.000 as the building template
  uses; the default of 25 would mark every reading an anomaly) with readings in the three locked
  months, because the matrix lists every active meter in every month and would show G12 as
  missing everywhere.
- **People** (new demo users are appended, so the existing phone numbers stay):
  - the owner of Apt. 14 also owns `P1`, `APARTMENT_ONLY` on both: one person, two objects, two
    badges that are not linked;
  - a new member who owns `G12` and no apartment, display mode `INITIALS` (`T. K. (G12)`);
  - a new member who is only the tenant of `P-2` (not an existing demo user, who would reach the
    building through an apartment and hide the rule of section 3.5).
- **Content:**
  - an `OFFICIAL_NOTICE` to `GARAGE` ("the gate code changes on Friday"): the owner of `G12` sees
    it, the owner of Apt. 14 does not;
  - a `FORUM_TOPIC` to `PARKING` and `GARAGE` by the owner of `G12`, with a comment by the owner
    of Apt. 14, signed `P1` by default;
  - a poll to `PARKING` ("repaint the lines"), unit `APARTMENT`, `RESIDENTS`: the owner of Apt. 14
    answers for `P1`, the tenant of `P-2` for `P-2`;
  - the existing clean-up poll stays a whole-building poll of the apartments, so the owner of
    `G12` neither sees nor answers it (the whole building is the apartments only);
  - an `OFFICIAL_NOTICE` to everything (`ALL_OBJECTS`, "the yard is closed on Saturday for asphalt
    work"): everyone sees it, the owner of `G12` and the tenant of `P-2` too;
  - an `EMERGENCY` to `PARKING` ("the gate is stuck"): the banner shows for the owner of Apt. 14
    and the tenant of `P-2`, not for the owner of `G12`.
- `DemoUserView` gains `objects: [{kind, number, relation}]`; `apartment_number` stays for the
  existing users and is `null` for a user without an apartment (the frontend would read `12` as
  Apt. 12).

### 6.2 Tests
**A mixed building** (one fixture shared by the tests of the epic; the factory gets
`create_object(session, building, kind, number, *, entrance=None, floor=None, area=None)`, and
`create_apartment` keeps its defaults by delegating to it):

| Object | Kind, number | Details |
|---|---|---|
| Apt. 1 | `APARTMENT` `1` | entrance 1 |
| Apt. 14 | `APARTMENT` `14` | entrance 2 |
| `P1` | `PARKING` `1` | no area |
| `P-2` | `PARKING` `P-2` | floor -1, no area, an electricity meter (the per m2 exclusion) |
| `G12` | `GARAGE` `12` | 18.50 m2, an electricity meter |
| `G1` | `GARAGE` `1` | the number `1` in three kinds |
| `G7` | `GARAGE` `7` | no members |

| Person | Memberships |
|---|---|
| A | owner of Apt. 14 and of `P1`, `APARTMENT_ONLY` |
| B | owner of `G12` only, `INITIALS` |
| C | tenant of `P-2` only |
| D | owner of Apt. 1 |
| E | tenant of Apt. 1 (apartment tenants still reach the building) |
| X | tenant of Apt. 1 and of `P-2` (reach per membership, section 3.3) |
| R | `RESIDENT` of Apt. 14 |
| a board member | owner of `G1` |
| the chairman | no membership |
| the accountant | no membership; in one case also the tenant of `P-2` (section 3.5) |

**Who is reached**, for the feed, the emergency banner, polls (`APARTMENT`, `RESIDENTS`) and the
recipients:

| Target | A | B | C | D | E | X |
|---|---|---|---|---|---|---|
| `ALL_BUILDING` | yes (through Apt. 14) | no | no | yes | yes | yes (through Apt. 1) |
| `ALL_OBJECTS` | yes | yes | yes | yes | yes | yes |
| `ENTRANCE` 1 | no | no | no | yes | yes | yes (through Apt. 1) |
| `ENTRANCE` 2 | yes | no | no | no | no | no |
| `APARTMENT_LIST` [`P1`] | yes | no | no | no | no | no |
| `APARTMENT_LIST` [`P-2`] | no | no | yes | no | no | yes (through `P-2`) |
| `KINDS` [`APARTMENT`] | yes | no | no | yes | yes | yes |
| `KINDS` [`PARKING`] | yes | no | yes | no | no | yes |
| `KINDS` [`GARAGE`] | no | yes | no | no | no | no |
| `KINDS` [`PARKING`, `GARAGE`] | yes | yes | yes | no | no | yes |

In polls the electorate holds the objects of the target only: X answers a whole-building poll
for Apt. 1, never for `P-2`, and B is not offered it. With unit `PERSON` A counts once, also in
an `ALL_OBJECTS` poll; with `OWNERS` C, E and X are not electors.

**Notifications, once per person:** A gets one in-app row, one e-mail and one Telegram message
for an `ALL_OBJECTS` notice, an emergency to `KINDS` [`PARKING`, `GARAGE`] and a poll to
`ALL_OBJECTS` with unit `APARTMENT` (A answers for Apt. 14 and `P1`, but is notified once); so
does the board member who owns `G1`.

Without a membership the accountant sees `ALL_BUILDING`, `ALL_OBJECTS` and `KINDS` posts that
include apartments, but no polls (as today); the board sees everything.

**Access:**

| Person | Documents | Issue tracker | Chat |
|---|---|---|---|
| A (Apt. 14 and `P1`) | 200 | 200 | 200, signed `Apt. 14` |
| B (owner of `G12` only) | 200 | 200 | 403 |
| C (tenant of `P-2` only) | 403 | 403 | 403 |
| X (tenant of Apt. 1 and `P-2`) | 200 | 200 | 200, signed `Apt. 1` |
| the board member who owns `G1` | 200 | 200 | 200 (by role), no object |
| the accountant (also when renting `P-2`) | 200 | 403 | 403 (as today) |

**Per task:**
- **K1a:** characterization tests of the five defaults (forum topic, comment, chat message, issue
  report, ballot) for a person with two apartments, before the refactoring; the suite green with
  the tests of `apartment_in_target` adapted to its new signature; SQL order equal to
  `object_sort_key`, with numbers such as `2`, `10`, `14A`, `14a`; the shared filter equal to the
  rule for the feed, the polls and `can_read_post` against `resolve_recipients` (members only),
  over today's scopes.
- **K1:** a migration test as `tests/auth/test_migration_036.py` (existing rows become
  `APARTMENT`; Apt. 1 and Garage 1 coexist; the check refuses a garage with an entrance and an
  apartment without an area; the downgrade refuses while a garage exists); the migration
  catalogue; the board's apartment list and card with a space without an area; the people list,
  the matrix, the consumption per m2 and the issue tracker with a garage in the building; labels
  (`Apt. 14`, `P1`, `P-2`, `g12`, `G1G`, `P-012`); the single invitation with one number under two
  kinds (`1` -> Apt. 1, `1` + `PARKING` -> `P1`, `GARAGE` `99` -> 404); A reports an issue
  without naming the object (Apt. 14), a person with `P1` and `G1` only gets 422, and the same
  for a ballot; the orphan badge keeps its kind. Migration 037 also: an insert as the old release
  writes it (no kind, with an entrance) becomes an apartment; a garage with floor -1 and no area
  passes; an apartment without a floor is refused. The texts per kind in all three languages (the
  invitation mail names the garage). **A smoke test:** every read endpoint, called as each person
  of the mixed building, answers without a 5xx.
- **K4:** bulk lists and template files without a kind, with one, and one number under two kinds
  (not a duplicate); a row of four cells; a kind in the third cell; an unknown kind; the daily
  limit over every object; in the template: an empty floor of a parking space stays empty, an
  entrance on a parking space is a row problem, a kind on a building meter is refused, colliding
  labels (`PARKING` `1` and `P1`, `P1` and `p1`) are refused.
- **K2:** the table of "who is reached" for every target; old events and `params` still decode
  and render, and a resolved emergency copies `target_kinds`; a maintenance notice to `KINDS`, and
  one whose kind has no object any more ends as a failed notice; migration 038 accepts the
  existing rows and inserts as the old release writes them, refuses unknown kinds, an empty array
  and kinds on another scope, and its downgrade refuses while `KINDS` rows exist, for each of the
  three tables; the badge context: A's comment on a notice to `PARKING` is signed `P1`.
- **K2 also:** C and B are not in the electorate or the notification audience of an
  `ALL_BUILDING` poll, and are in an `ALL_OBJECTS` one; C is in a `KINDS` [`PARKING`] poll with
  `RESIDENTS`; X is offered Apt. 1 only in a whole-building poll; B and C cannot publish to
  `ALL_BUILDING`, nobody but the board to `ALL_OBJECTS` (403 before any 422); no emergency to
  `ALL_BUILDING` reaches B or C, and they get no in-app `EMERGENCY_PUBLISHED` or `POLL_OPENED`
  row; the "once per person" cases above.
- **K2b:** the access table; the accountant who rents `P-2` keeps the documents and gets 403 in
  the chat and the tracker (section 3.5); the chat's checks take the room's target, so a test
  with another target (`KINDS` [`GARAGE`]) in a unit test of the policy shows that a room per
  area needs no new rule.
- **K3:** policy tests for the forum permission; router tests: 403 before 422, an explicit object
  outside the target is 422, for comments too; A's comment on a topic for `PARKING` and `GARAGE`
  is signed `P1`, on `ALL_BUILDING` `Apt. 14`; a board member without an object who comments on an
  `ENTRANCE` notice gets no object; the badge of a notice the maintenance calendar publishes is
  unchanged; B's orphan badge after the membership ends is `G12`.
- **K5:** the overview, the sheet and the matrix with every kind; a matrix filter by a kind the
  building lacks returns an empty list; the export's last column and the plugin default.
- **K6:** the seed counts (9 objects; 15 meters; 15 readings in each locked month), the September
  matrix all submitted, the heated area of apartments only, the set of entrances with an empty
  one, two emergencies for the owner of Apt. 14, the switcher with the new users; a second
  completion adds nothing; the completion survives a closed account of the owner of Apt. 14, a
  closed poll, a deleted topic, a resolved emergency and a taken e-mail, and is skipped on a real
  installation; the smoke test of K1 on the completed demo database.

## 7. Later, not in this epic
- **Official polls (E3 part B):** the share in the common ownership as a field of the object, and
  the chairman's choice per poll: per object, per owner, or by share; also the double majority.
- **The setup wizard (E13 R7) per kind:** what is created and asked for each kind; the first item
  after this epic.
- **An association without entrances** (garages only): hide the entrances in the screens, the
  entrance targets and the wizard step.
- **An entrance for a parking space** (an underground parking reached from one staircase): on a
  real case.
- **The register draft (E12 X3)** with non-residential parts as parking spaces and garages.
- **A forum topic for one entrance:** on request.
- **A chat room per area** (the owner wants it ready, section 3.5): reasonable and cheap, since
  the room already has a target and the checks take it. The chat module is small, has no events
  or notifications, and its messages live 2 hours, so its migration carries no data. A `room`
  column holding the room's target (`ALL_BUILDING` today; `KINDS` [`GARAGE`], `KINDS`
  [`PARKING`] or an entrance later) with an index `(building_id, room, id)`, `?room=` on the
  endpoints, the lock per room; who takes part and the badge follow the room's target, as they do
  now. Open then: one `chat.enabled` for all rooms or one per room. About one task of 1-2 days
  with tests, after this epic and on a real request.
- **A company as an owner** with its registry code, separate from the person who signs in: when
  the invoices of E2 go to the owner rather than to an account.
- **Garages with a master meter of their own** (owner 2026-11-25: nothing now, how real buildings
  do it is not known yet). Each garage with its own meter behind the building's master meter
  already works. A master meter of the garage block with a meter per garage still balances in
  total, only the loss of the garages is not shown apart (a group per master meter would show
  it). A master meter of the block without meters per garage would show the garages' whole
  consumption as the building's loss (a mark "not in the balance" on that meter would fix it).
  Built only for a real case.

## 8. Labels
- **In badges:** `P14` and `G12` (section 2.4), the same in every language.
- **In screens and texts** (lists, filters, the choice of targets, notifications): the full name
  of the kind, translated by the frontend from `kind` and by the message catalogues in texts.
  Garage (owner 2026-11-25): Estonian `Garaaž`, the Russian word as the owner gave it. Parking
  space (owner 2026-11-25): Estonian `Parkimiskoht`, in Russian "parking space" word for word (the
  owner chose it over the one-word term). Targets: "the whole building" and "everything" are
  named so in all three languages (section 3.1).
- docs/FRONTEND_GUIDE.md ("Forum topics are always `ALL_BUILDING`") changes with K3.

## 9. Independent CTO reviews (2026-11-25)

### 9.1 First review: the design
A fresh reviewer without the design session read this page against the code. The model was
confirmed; the findings below were verified by the agent in the code and taken into this page.

| # | Severity | Finding | Where on this page |
|---|---|---|---|
| F1 | blocker | `NULL` entrances break sorting (communication, governance, issues, the people list) and DTOs typed `int` | K1 sweep |
| F2 | blocker | `apartment_by_number` takes the first object with a number; the single owner invitation uses it | section 5 |
| F3 | major | the checks `ck_comm_posts_forum_whole_building` and the target scope enums must be rebuilt | section 3.1 |
| F4 | major | maintenance notices have their own copy of the target | sections 1, 3.1 |
| F4b | major | `entrance` defaults to 1, so a garage would become entrance 1 | section 2.2 |
| F5 | major | there is no `RESIDENT` invitation: a guard in `open_membership` instead | section 2.3 |
| F6 | major | a `NULL` area breaks the consumption per m2 and the register cross-check; the building's area counts every kind | section 2.2 |
| F7 | major | the badge context inside the target is a privacy rule and covers comments | section 3.2 |
| F8 | major | every caller of the badge passes only the number | section 2.4 |
| F9 | major | stored events and notification `params` need defaults for the new fields | section 3.1 |
| F10 | major | rollback past migration 037 | section 6 |
| F11 | major | the demo seed runs only on an empty database | section 6.1 |
| F12 | major (owner) | a tenant of a garage would get the whole building | section 3.5, owner decision |
| F13 | minor | the target rule exists in several copies | section 3.1 |
| F14 | minor | only polls test the SQL filter against the rule | section 6.2 |
| F15 | minor | the export column goes last, the plugin field has a default | section 4 |
| F16 | minor | `ApartmentMembershipDTO` has no kind | section 2.3 |
| F17 | suggestion | 403 for a foreign kind before any 422 | section 3.2 |
| F18 | suggestion | label edge cases written down | section 2.4 |

### 9.2 Second review: refactoring and integration
The owner asked for a second, deeper review of the refactoring and of how the new features fit
into the code. A new reviewer confirmed the model and the first review (one correction: nothing
writes `RESIDENT` today, section 2.3), and found the points below; the agent verified the key ones
in the code (G1, G2, G4, G5, G8, G9, G10, G11, G13).

| # | Severity | Finding | Where on this page |
|---|---|---|---|
| G1 | blocker | an area of `None` fails the response type of areas, so the board's apartment list fails; `floor` also defaults to 1 | section 2.2 |
| G2 | blocker | bulk invitations and the building data look up by number with the last object winning | section 5 |
| G3 | major | about 15 views, an event and the mail and notification texts name an object by number only | sections 2.4, 10.2 |
| G4 | major | "building access or staff" would open the chat and the tracker to the accountant | section 3.5 |
| G5 | major | an emergency is sent without a visibility re-check | section 3.1 |
| G6 | major | the SQL filters of posts and polls differ today for staff | section 3.1, `member_only` |
| G7 | major | enum members change the checks, so `KINDS` goes with migration 038 | section 3.1 |
| G8 | major | a failing demo completion stops the start-up and rolls the deploy back | section 6.1 |
| G9 | major | an existing demo user as the tenant of `P-2` hides the rule | section 6.1 |
| G10 | major | a second object makes "omit the object" fail with 422 | section 3.6, owner decision |
| G11 | major | after the demo objects exist, an automatic rollback breaks the demo | section 6, PR 5 |
| G12 | major | migration 038 needs its own rollback note | section 6 |
| G13 | major | the bulk list is positional, so the kind is a fourth cell | section 5 |
| G14 | major | two numbers of one kind can share a label | section 2.2 |
| G15 | minor | the existence check and the default author object have copies too | section 2.5 |
| G16 | minor | where the shared helpers live without crossing module boundaries | section 2.5 |
| G17 | minor | the SQL order needs a `CASE` and a collation | section 2.2 |
| G18 | minor | the consumption per m2 also counts garages in the numerator | section 2.2 |
| G19 | minor | the poll audience includes tenants of a space | section 3.3 |
| G20 | minor | a tenant of a space could publish to the whole building | sections 3.2, 3.5 |
| G21 | minor | the export calls an empty entrance the master meter | section 4 |
| G22 | minor | limits and counts grow with every kind | section 1, "Counts" |
| G23 | minor | tests that call `apartment_in_target` change in K1a | section 6.2 |
| G24 | minor | what migration 037 must check and refuse | section 6 |

### 9.3 Third review: everything again, at the highest diligence
The owner asked for a third review because the feature is large. A new reviewer confirmed the
model, the five pull requests and the earlier findings it checked, raised the estimate to 14-17
days and found the points below; the agent verified the key ones in the code (H1, H2, H3, H4, H5,
H14).

| # | Severity | Finding | Where on this page |
|---|---|---|---|
| H1 | blocker | the default object is two rules today (the badge of posts and chat; the choice of issues and ballots), not one; one helper would change behaviour in the refactoring with no test failing | sections 2.5, 3.6 |
| H2 | major | a name of the kind cannot be inserted into a Russian or Estonian sentence: a variant per kind of each sentence | section 2.4 |
| H3 | major | polls offer any object of a person, so the tenant rule leaks through a person with two memberships; resolved by the owner's rule per object (the whole building is the apartments) | sections 3.1, 3.3 |
| H4 | major | `ON CONFLICT (id)` is not enough: the demo completion runs in a savepoint and never stops the start-up | section 6.1 |
| H5 | major | without readings G12 is missing in every locked month; the default limit marks kWh readings an anomaly | section 6.1 |
| H6 | major | the notification `params` are rendered by the frontend: in the frontend notes | section 10 |
| H7 | minor | the badge context must come with the first targets by kind (K2), not with K3 | sections 3.2, 6 |
| H8 | minor | the commit with `KINDS` must carry its validation and targeting | section 3.1 |
| H9 | minor | building template rules for other kinds | section 5 |
| H10 | minor | bulk invitations: the limit, the cells, a new outcome | section 5 |
| H11 | minor | staff who also rent a parking space | section 3.5, owner: the role decides |
| H12 | minor | "the whole building" is not "every kind" | section 3.1, owner: the whole building is the apartments, `ALL_OBJECTS` is everything |
| H13 | minor | a nullable area type would make the building's heated area nullable | section 2.2 |
| H14 | minor | no backup is taken before an update, deploys never downgrade, no other object exists on dev before PR 5 | section 6 |
| H15 | major (test) | a smoke test of every read endpoint with the mixed building | section 6.2 |
| H16 | minor | the privacy notice of the join page says "apartment" | K5 |
| H17 | minor | `COLLATE "C"` changes the order of numbers that differ in case | section 2.2 |
| H18 | minor | the checks of 038 validate the values of `target_kinds` | section 3.1 |
| H19 | minor | the equality of feed and recipients holds for members only | section 3.1 |
| H20 | minor | the clean-up poll on a fresh demo database | section 6.1 |

## 10. Frontend work (notes for the handoff)
Collected while the backend is designed and built, so that each handoff (after a merged pull
request, on the owner's request) is complete. The frontend works against `docs/openapi.json`;
this list is the reminder, the contract is the source.

### 10.1 After PR 1 (K1a)
- Nothing: no change of the contract.

### 10.2 After PR 2 (K1, K4): the model
- **Nullable fields:** `entrance`, `floor` and `area_m2` may be `null` on every object view; the
  card, the lists and the matrix show nothing instead of "entrance 0" or "NaN m2". A floor may be
  negative.
- **`apartment_kind` everywhere an object is shown** (next to `apartment_number`; the contract, docs/API.md section 0): apartments of the board and the card,
  `GET /property/me` memberships, the chairman's people list (`GET /auth/users`), the connection
  overview, invitations (the preview the invited person sees, the list of invitations, the bulk
  result), join codes (issued, listed, the public join page), join requests and decisions, the
  meters dashboard, the readings and consumption of one object, the matrix. Named by kind in screens:
  "apartment 14", "parking space 1", "garage 12" (translated from `kind`, three languages,
  section 8); never "apartment G12". Two objects with the number `1` must be told apart.
- **Labels in badges** are text from the backend (`P1`, `G12`); nothing to build.
- **The single owner invitation:** a choice of the kind (`apartment_kind`, apartment by default).
- **Notification `params`:** `apartment_kind` in the params of `APARTMENT_MESSAGE`,
  `APARTMENT_MESSAGE_TO_BOARD` and `JOIN_REQUEST_SUBMITTED`; the bell and the in-app texts that
  say "apartment {number}" or "your apartment's conversation" choose the text per kind.
- **Bulk invitations:** the help text names the optional fourth cell for the kind; the result
  may hold the new row outcome `INVALID_KIND`.
- **The object switcher:** a person may hold several objects (an apartment and a parking space).
  The pickers (an issue's objects, the objects a poll can be answered for) name objects by kind
  from `GET /property/me`. Issue reports and ballots may omit the object only when the backend
  can choose (section 3.6); otherwise the client offers the choice. The author of a post or a
  chat message keeps its default.
- **The building view:** numbers of objects per kind; the heated area and the number of
  apartments count apartments only.
- **The meters dashboard:** the consumption per m2 counts objects with an area; an object
  without meters (a parking space) is hidden or shown as "no meters".
- (The building template is an operator command line tool, not frontend work.)

### 10.3 After PR 3 (K2, K2b): who is reached
- **The choice of the target** for notices, emergencies, polls and maintenance notices gains
  "by kind" (`KINDS` with one or more of `APARTMENT`, `PARKING`, `GARAGE`); offer only the kinds
  the building has. A post or a poll shows its target ("for the garages").
- **The choice of the target** offers "the whole building" (the apartments only), "everything"
  (`ALL_OBJECTS`: apartments, parking spaces and garages), the kinds, an entrance and a list, and
  says what the whole building leaves out. A resident's forum topic offers the whole building
  only with an apartment, never everything.
- **Showing the target:** `ALL_OBJECTS` and `KINDS` are new values of the target scope in existing
  views (the feed,
  the board's emergency banner, polls, the maintenance task's notice): render it, and
  `params.target_kinds` of `EMERGENCY_*` notifications in the bell.
- **`shared_access`** in `GET /property/me`: when false (a tenant of a parking space or a garage
  only), hide the documents and the issue tracker; handle `403` there anyway.
- **The chat** is for the people of the apartments and the board: hide it for a person without an
  active membership of an apartment (from `GET /property/me`: no membership of `apartment_kind`
  `APARTMENT`, and no board role); handle `403` anyway.
- **A person without an apartment** (an owner or a tenant of a garage) sees no whole-building
  topics; hide "new forum topic" for them until PR 4 (forum topics by kind).
- **Comments:** the author's object defaults to one inside the post's target (moved here from
  PR 4); an explicit object outside it is `422 INVALID_AUTHOR_APARTMENT`, also for existing
  `ENTRANCE` and `APARTMENT_LIST` posts; the comment composer offers only objects inside the
  target.

### 10.4 After PR 4 (K3, K5): the forum and the chairman's screens
- **Forum topics:** the composer chooses the whole building, everything (the board only) or
  kinds; a resident sees only the kinds they hold, and the whole building only with an apartment.
  docs/FRONTEND_GUIDE.md
  "Forum topics are always `ALL_BUILDING`" is replaced.
- **The chairman:** summaries per kind (`ConnectionSummary`, `GET /property/building`), the
  matrix filter by kind (a `kind` query parameter), the join code sheet and the privacy notice
  of the join page; the CSV export has a `kind` column at the end, documented for the
  accountant's import.

### 10.5 After PR 5 (K6): the demo
- **The demo user switcher:** `DemoUserView.objects` (`kind`, `number`, `relation`) shows what each
  demo user holds (two entries for the owner of Apt. 14); `apartment_number` is `null` for a user
  without an apartment. Two new demo users (the owner of `G12`, the tenant of `P-2`) with their
  labels; G12 appears in the matrix with readings.
- PR 5 is merged only after the items of 10.2 to 10.4 are in the frontend, because the demo then
  shows parking spaces and garages to everyone.
