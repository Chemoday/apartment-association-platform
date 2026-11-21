# 2026-11-21: Filling the building and connecting the residents (epic E13)

A record of a planning session with the coding agent (Claude Code CLI). Documentation only. The
design is in docs/epics/E13_ROLLOUT.md, sections 6a and 6b.

## 1. How we got here
- The owner set the order: first the simple, understandable install and the creation of a new
  association, seen from the board that runs the platform on its own server; tooling of others
  builds on the operator commands of this repository.
- The agent checked the code first. The Estonian register provider already reads the parts of a
  building (number, kind, area, rooms, the floor of the entrance) for the building passport
  (E12 X1, X2). The register holds no entrance (staircase) numbers and no meters. A real
  installation has no way yet to create apartments: there is no endpoint for it, and the import
  (R3) is not built. Invitations exist one at a time, at most 10 per inviter per hour.

## 2. Filling the building
- **Proposed:** a template prefilled from the register (numbers, areas, floors), the entrances by
  ranges and a default set of meters filled in by the chairman in a spreadsheet, imported by the
  administrator; the in-app wizard later on the same core.
- **Decided:** accepted, and the wizard (R7) is designed together with it, so that it adds screens
  and no logic. Only apartments are taken from the register: the association accounts for shops
  and offices separately. The template holds no personal data.

## 3. Who enters residents' e-mails
- **Decided:** only the chairman, in the app. The administrator enters only the first chairman's
  e-mail. The template of R4 ("invitations from the same template") is dropped.

## 4. Connecting the residents
- **Bulk invitations:** accepted with a preview per row and a daily limit per building. The agent
  proposed a language per row; the owner decided the first invitation goes out in the state
  language (Estonian in Estonia) or in English, because the person picks their own language when
  registering.
- **Connection overview:** accepted, with pagination from the start and the link to the existing
  apartment card.
- **Join codes on paper:** proposed by the agent, liked by the owner, who designed the flow: the
  chairman generates codes for the apartments not yet connected, prints a sheet per apartment
  (site, apartment, code), and the owner registers with the code. Refined together:
  - the join page asks for the code only, and the server shows the apartment to confirm: a list of
    apartment numbers cannot be generated from a count (numbers like `14A`, gaps, non-residential
    parts left out) and should not be shown to an anonymous visitor;
  - the codes are shown once, because the server keeps only a keyed hash, so they are printed
    right away;
  - 30 days of validity by default, a QR code with the code after `#`.
- **The chairman confirms every use of a code.** The owner asked how the chairman can know that
  the e-mail belongs to the owner and not to whoever took the sheet. The agent's answer: the
  e-mail is proven by the invitation link, as for every invitation; the chairman confirms the
  person, which no system can. So the join form asks for the name, the phone and the e-mail, the
  chairman compares them with the association's list of members or calls the owner at the number
  from that list, and the page tells the person why these data are asked for. Handing the sheets
  over in person is safest; a sign-in with Smart-ID or the ID card (E7, later) could confirm the
  person automatically one day.

## 5. Tenants of an absent owner
- **Asked:** a rented apartment whose owner is not in the app: may the chairman invite the tenant
  directly?
- **Decided:** no, it stays with the owner. The chairman does not deal with tenants directly: a
  tenant is the owner's own relation, and for the chairman and the board only the owner exists.
  Such an apartment works on paper until its owner connects (E13 section 9, question 6).

## 6. Review of the first draft
A fresh reviewer agent asked for changes, all taken into E13 sections 6a and 6b:
- the bulk preview must not say "already a member": that would tell the chairman whether an
  e-mail has an account, which the login contract forbids;
- the chairman seeing a join request's full name, phone and e-mail is a new exception to the
  masking of personal data: it is now listed in AGENTS.md, needs a real sign-in (no demo header),
  join codes are off in demo mode, and each decision leaves a record without personal data;
- a per-building limit on the public join page would let any visitor block every owner (an
  installation has one building), so the limit is per IP address, with an alert-only ceiling;
- the rules of codes for co-owners, confirming over a pending invitation, rejected requests, the
  shared daily limit and a notification of a waiting request were missing;
- `CONNECTED` now means an active owner (`TENANT_ONLY` is its own status), `PAPER` comes before
  `EXPIRED`, and join requests get their own list;
- the language is stored on the invitation; the bulk list is never stored and has caps; sending goes
  through a paced queue;
- R3's template must accept what a spreadsheet saves (`;`, a decimal comma, a byte order mark), a
  second import is refused as a whole, entrances are ranges of positions in natural order;
- R4 is split into R4a (bulk invitations), R4b (overview) and R4c (join codes), and other pages
  that the design made stale were updated (E7, E12, the Estonian register page, the roadmap).
The reviewer also noted that owners of non-residential parts are members of an Estonian
association too: leaving those parts out of the template keeps their owners out of invitations and
polls unless the chairman adds them by hand, which the design allows.

## 7. Left open
- The exact template columns (R3) and the endpoints and screens of the wizard (R7).
- The routes and screens of R4 in docs/FRONTEND_GUIDE.md: with each R4 task's contract commit.
