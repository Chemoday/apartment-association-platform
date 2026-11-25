# 2026-11-25: Objects of several kinds: parking spaces and garages (epic E14)

A record of a planning session with the coding agent (Claude Code CLI). Documentation only. The
design is in docs/epics/E14_OBJECT_KINDS.md.

## 1. How we got here
- The owner wants a more varied association: besides apartments, an association has parking
  spaces and garages; one person may own several objects, and an owner of a parking space or a
  garage may have no apartment in the building but is still a member of the association. A
  company may own an object too.
- The agent checked the code first. Several objects per person already work end to end: the
  memberships are many-to-many, `CurrentUserDTO` carries all of them, posts and chat messages
  choose the object they are written from (`author_apartment_id`), a poll ballot names its
  object, and an existing account accepts an invitation to another object. E13 R3 already lets
  the chairman add a non-residential part by hand as an apartment row; the system just does not
  know its kind.

## 2. What a parking space is
- **Asked:** in Estonia a parking space or a garage is either an apartment ownership of its own
  (its own share and vote), a share in one common ownership "parking" with a usage arrangement,
  or a usage right on common land tied to an apartment. Which one do we model?
- **Decided:** an apartment ownership of its own, also for later associations of garages only.

## 3. One table or several
- **Proposed:** a `kind` column on the apartments table instead of new tables, so memberships,
  invitations, join codes, the poll electorate, the badges and the connection overview work for
  every kind at once.
- **Naming:** the owner did not mind renaming to "unit". The agent advised against it: "unit"
  already means the voting unit of a poll and the unit of a meter. The table and the API keep
  "apartment", with a glossary line. For the column the owner proposed `type`; the agent noted
  that a bare `type` shadows a Python built-in and the code has none, while bare `kind` (polls,
  invitations) and `<noun>_type` (posts, resources) both exist. **Decided:** `kind`.

## 4. Who is reached
- **Decided:** the board addresses members by kind of object (apartments by entrance, parking
  spaces, garages) or everyone, for notices, emergency alerts and polls.
- The owner added forum visibility, so that a message meant for the garages does not go to
  everyone. **Decided:** forum topics can be addressed by kind; the board names any kinds, a
  resident only the kinds of which they hold an object. A topic for one entrance: not now, on
  request.
- The agent added the default badge: a topic for the garages should be signed by the author's
  garage, not their apartment; the default context becomes the first object inside the target.

## 5. Voting
- **Decided:** in an informal poll an owner of several objects switches between them and answers
  for each (already possible). For official polls (E3 part B) the chairman chooses how votes
  count. The owner proposed per object or by square metres; the agent noted that the law
  (§ 22 (1)) counts per apartment ownership by default and lets the articles count per owner or by
  the share in the common ownership, which is not always proportional to the area and exists for
  a parking space without an area. So the share becomes a field of its own, with E3 part B.

## 6. Other questions
- **Company as an owner:** a real case exists, but no change now; its name fits the full name.
- **Chat:** stays as it is (every member, one room). The owner asked for an estimate of a room per
  kind: reasonable and cheap (one task of about 1-2 days), recorded in the epic, section 7.
- **The setup wizard (E13 R7):** each kind will have its own creation logic; the owner made it the
  first item after this epic.
- **Objects named by number:** found by the agent: "1" may now be an apartment and a garage, so
  the bulk invitations and the building template take the kind, an apartment by default.

- **A master meter of the garages:** the agent described three cases (a meter per garage behind
  the building's master meter works now; a master meter of the block with meters per garage
  balances only in total; a master meter of the block without meters per garage shows a false
  loss). **Decided:** nothing now, the owner does not know yet how real buildings do it; recorded
  in the epic, section 7, for a real case.

- **Labels:** a garage is `Garaaž` in Estonian (owner); the Russian word goes into the
  translations with K1. In badges the owner chose short labels, `G12` and `P14`; the agent noted
  that badges are language-independent text, so they need no translation, and that a number
  already starting with the letter is shown without a second one.

## 7. Independent CTO review
- The owner asked for an independent review of the design before the implementation, with a
  view to refactoring and the integration of the new features, and for test and demo data.
- A fresh reviewer agent without the session's context read the page against the code. It
  confirmed the model (one table with a kind) and found that the first task as planned would
  break `main`: many places assume an entrance and an area, and the single owner invitation picks
  an object by its number alone. It also found the maintenance notices' own copy of the target,
  the checks to rebuild, the privacy of the badge in comments, stored events, rollback and the demo
  seed that runs only on an empty database. The agent verified the findings in the code; all are
  taken into the epic page (section 9 lists them).
- **Asked:** should a tenant of a parking space or a garage (often someone from outside the
  building) get everything addressed to the whole building, the documents, the chat and the issue
  tracker? **Decided:** no, only what is addressed to their kind or their object (task K2b).
- **Asked:** one pull request or two? **Decided:** two, the data model first (changed after the
  second review, section 8).
- The reviewer proposed refactoring first (one target DTO and rule, one label function, one
  parser of an object reference, one lookup by kind and number) and a demo building that shows
  every case; both are in the epic page.

## 8. Second CTO review: refactoring and integration
- The owner asked for a second, deeper review focused on the refactoring and on how the new
  features fit into the code. Another fresh reviewer confirmed the model and the first review,
  raised the estimate to 11-14 days and found 24 more points (epic page, section 9.2). The agent
  verified the key ones in the code. The most important: one parking space without an area would
  make the board's apartment list fail; the bulk invitations look up by number with the last
  object winning, so a parking space "1" would silently take the place of Apt. 1; about 15 views
  and the mail and notification texts name an object by number only; an emergency is sent without
  a second visibility check; and a failing completion of the demo data would stop the start-up and
  roll the deploy back.
- **Asked:** how to split the work? **Decided:** the owner left it to the agent; five pull
  requests, each safe for dev: the refactoring; the model; who is reached (one security change);
  the forum and the chairman's screens; the demo, merged after the frontend handles the new
  fields.
- **Asked:** the kind in the bulk invitation list. **Decided:** an optional fourth cell, an
  apartment when empty.
- **Asked:** the object a request is made from when it names none, now that a person may hold an
  apartment and a parking space. **Decided:** the only object; with several, the only apartment;
  otherwise 422 as today.
- **Asked:** what the limits and summaries count. **Decided:** limits of invitations and join codes
  over every kind; the chairman's summaries per kind.
- **Asked:** a target naming a kind the building has none of. **Decided:** refused with 422 when
  publishing; reading or filtering by it returns an empty list.
- **Asked by the owner:** can a garage have a floor without breaking anything? **Answered:** yes;
  the review objected only to the default floor of 1. A parking space or a garage may have a floor
  (negative for an underground parking) or none; only an apartment requires one.
- The owner asked to collect the frontend work from the start, so that each handoff is complete:
  epic page, section 10, per pull request.

## 9. Third CTO review at the highest diligence
- The owner asked for one more review, at the highest diligence, because the feature is large,
  and asked the agent to start collecting the frontend work right away (epic page, section 10).
- A third fresh reviewer read everything again against the code and found 20 more points (epic
  page, section 9.3), raising the estimate to 14-17 days. The agent verified the key ones. The
  most important: the "one default object" planned for the refactoring is really two rules
  today (the badge of posts and chat never refuses; issues and ballots ask the person to choose),
  so one helper would silently change behaviour; the kind cannot be inserted into a Russian or
  Estonian sentence, so each sentence gets a variant per kind; polls would let a tenant of a
  parking space answer a whole-building poll through another membership, so reach counts per
  membership; and the demo completion must run in a savepoint so that it can never stop the
  start-up. The badge context inside the target moved from K3 to K2, together with the first
  targets by kind.

## 10. Decisions after the third review
- **Asked:** an accountant who also rents a parking space. **Decided:** the role decides first;
  a parking space gives the least access.
- **Asked:** should "the whole building" reach the tenants of parking spaces and garages, and the
  owners of garages without an apartment? **Decided:** no. The whole building is the apartments
  only; "everything" reaches every object of every kind. The agent made "everything" a target of
  its own (`ALL_OBJECTS`), so that a stored target keeps its meaning when a building later gets a
  new kind. With the rule per object, the leak through polls found by the review cannot happen,
  and the task for tenants (K2b) shrinks to the documents, the chat and the issue tracker.
- **Asked:** the Russian name of a parking space. **Decided:** "parking space" word for word.
- **The owner added:** a person with several objects must get one notification per event. The
  agent checked: it holds today at three levels (recipients per person, merged lists, a unique key
  of deliveries per event, person and channel); the epic keeps it as a rule with tests (epic page,
  section 3.4).

- **The owner added:** the chat should not concern the garages: the quick talk of the house is
  for the apartments, and it should be ready to be limited by area later. **Decided:** the chat is
  the room of the apartments; the room has a target (today always the whole building), and who
  takes part and the badge follow it, so a room for the garages later is one more room with
  another target (epic page, sections 3.5 and 7). The documents and the issue tracker stay open
  to owners of every kind.

## 11. Texts
- **Decided (2026-11-26):** the agent writes the Russian and Estonian texts per kind with K1 and
  K2 and does not wait for a review; the owner goes through the localization in a sprint of its
  own later. Nothing is left open in the design.
