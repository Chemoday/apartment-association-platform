# E13. Rollout: bringing a new association onto the platform

- **Phase:** 2. **Status:** designed on 2026-11-18, documentation only (task R0
  [#155](https://github.com/Chemoday/apartment-association-platform/issues/155)); epic
  [#156](https://github.com/Chemoday/apartment-association-platform/issues/156). Planning record:
  docs/cli_planning/2026-11-18-rollout.md.
- **Goal:** the simplest possible install on the association's own VPS: one command on a clean
  server gives a working installation with its building, apartments and meters, its board and its
  residents, without the demo seed and without hand-made changes on the server.
- **Related:** backups (docs/BACKLOG.md B-3), one database per environment (B-4), installer and
  e-mail (B-8), a change of the apartment's owner (B-10), disk hygiene (B-11), resource limits
  per instance (B-12), several buildings and hosting many associations (B-1), demo mode in real
  use (security backlog S-7), bulk import (E5, delivered by R3 and R4a-R4c), the apartment list from
  the register (E12 X3), login and invitations (E7).

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/DEPLOYMENT.md, docs/FRONTEND_GUIDE.md) in its first
commit; where they differ, the contract wins.

## 1. Why

Today a building, its apartments, meters and memberships exist only when the demo seed creates
them (`src/core/seed.py`). The operator command `create-chairman` needs exactly one building in
the database, so a new installation without the seed cannot even get its first chairman. Dev and
prod both run in demo mode, where anyone can act as the chairman. And `deploy/` is written for the
project's own VPS (dev and prod side by side, deploys from GitHub), not for an association that
wants the platform on its own server.

## 2. What exists already (checked 2026-11-18)

- **A public image:** `ghcr.io/chemoday/apartment-association-platform` can be pulled without a
  login; tags are commit SHAs and `main`, there are no release versions yet.
- **`deploy/bootstrap.sh`** already does most of a server setup: a user, `/opt/aap`, secrets,
  the Caddy edge with automatic HTTPS, the disk check timer, swap and the journal limit. It is
  made for the project's VPS: always dev plus prod, a CI deploy key for the ssh gate, Docker only
  checked, not installed.
- **`deploy/deploy.sh`** deploys a release with a health check and an automatic rollback.
- **The first chairman:** `python -m src.modules.auth create-chairman --email ...
  [--print-link]` (docs/API.md section 7, "First chairman of a new installation").
- **E-mail:** the plugin `common.email_smtp` is a plain SMTP client (`SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TLS`) that works with any mailbox or
  provider; the local `docker-compose.yml` already has Mailpit, which catches all mail.
- **A local demo out of the box:** `docker compose up` starts demo mode with the seed, while the
  defaults in `src/core/config.py` keep both off.
- **Invitations** of the board, the accountant and residents per apartment, sign-in by e-mail
  link and password (E7), role changes.
- **Months open by themselves** (the period opener) and reading reminders go out by themselves
  (E1).
- **The building passport from the register** (E12 X1, X2).
- **Documents of the association** (E11 F3): articles, house rules, minutes, financial reports.
- **The building chat is off by default** (owner, 2026-11-15).
- **Apartments without residents work:** the chairman or the accountant enters their readings
  (`ADMIN_OVERRIDE`, no reason needed for the first entry of a period).

## 3. Owner decisions (2026-11-18)

- **One epic for the rollout** (this page). The in-app setup wizard (local backlog L-9) becomes
  its later part (R7), not a separate epic.
- **The aim is the simplest possible install on the association's own VPS:** one VPS, one
  Docker, the image from the shared public registry. Hosting many associations (orchestration of
  images for a hosting company) is **a separate private repository**, outside this project and
  this epic.
- **The project's own deployment stays** (dev and prod on the project's VPS, deploys from GitHub)
  for development, under a name that does not mix it up with the public install (section 4).
- **Demo mode stays:** anyone can start the platform locally or on a VPS just to look at it,
  without filling anything in.
- **E-mail by audience** (section 6): Mailpit only for test accounts; the pilot uses a regular
  mailbox with an app password; an own domain with a transactional provider at the official
  launch.
- **Hostnames stay on Caddy,** not nginx: it obtains and renews certificates itself and already
  holds the upload limits and timeouts.

### The installer (owner, 2026-11-18, while planning R5)
- **The questions** of section 4 are approved, with the expected form of the address explained
  on the screen.
- **The building comes from the register first:** the installer looks up the address in the
  public building register of the country where a provider exists (Estonia: In-ADS and EHR,
  epic E12) and proposes the normalised address. When the register cannot be reached or finds
  nothing, it asks for the address and the registry code by hand. The association's name is always
  typed, because the building register does not hold it.
- **Invitations without mail are queued:** while the installation has no working e-mail, the
  chairman still invites residents; the invitations wait and go out as soon as SMTP is set, with a
  fresh link. Nobody sees a link (the login promise of section 6 holds). Part of R4a.
- **SMTP can be set later in two ways:** now by a command on the server (running the installer
  again, the password stays in the server's environment file), and later in the app's building
  settings (R9, its own task: a secret in the database needs encryption and its own screen).
- **The rename of the project's own deployment** is split off from R5 as R5c: the install does not
  need it, and it rebuilds CD.

## 4. The simple install

### What "simple" means (the acceptance criteria of R5a)
- **One command** as root on a clean Debian or Ubuntu server: download the installer of a release
  and run `install.sh`. No git, no clone of the repository, no editing of files. Since R5b the
  installer, the archive and the image are those of a version (docs/DEPLOYMENT.md "Versions and
  releases"); a commit of `main` can still be installed with `--ref`, for testing.
- **The server is checked first:** the installer stops at once with a clear message on anything
  but an x86_64 (amd64) server, because the image is built for amd64 only; otherwise Docker would
  pull it and fail with an unclear `exec format error`. ARM images wait for a real request
  (owner, 2026-11-18).
- **At most five questions,** all asked first, then the install runs on its own. Everything
  else is automatic: Docker, secrets, `INSTANCE_ID`, Caddy, HTTPS, timers.
  1. **The address of the site.** An own hostname, for example `kyhistu.example.ee` or
     `example.ee`: only the name, without `https://`, a port or a path. One DNS record (`A`) must
     point it at this server's public IP, which the installer shows; it checks that the name
     resolves to that IP and explains what to fix otherwise (certificates fail without it).
     Enter alone means no own domain: the address becomes `<ip-with-dashes>.sslip.io`.
  2. **Demo or a real installation.** A demo skips questions 3 to 5: the demo building is seeded
     and no mail is sent at all.
  3. **The building:** its address, looked up in the register first (see section 3), the name of
     the association and, optionally, its registry code. Country `EE` and the reading deadline
     day 4 are defaults.
  4. **The chairman's e-mail.**
  5. **E-mail (SMTP):** host, port, user name, password (read without echo) and the sender address.
     It may be skipped: the chairman's link is then printed to the terminal only, and invitations
     wait until SMTP is set (R4a).
- **About 15 minutes** from a clean VPS to the chairman's link in the terminal.
- **Running it again is safe:** existing secrets and data are kept. Switching from a demo to a
  real installation needs a fresh database (the seed only fills an empty one); the installer
  refuses it on a database that holds the demo building (the installation marker of R1).
- **Demo skips the mail question:** a demo installation sends no mail at all (the dispatcher
  skips every notification in demo mode, sign-in mail needs `AUTH_MAIL_IN_DEMO`).
- **An update is one command,** `update.sh <version>`, with the health check and the automatic
  rollback; **backups** (R6) are switched on by the installer by default.
- Apartments and meters come in from a template the installer prefills from the register, with
  one import command (R3, section 6a).
- At the end the installer prints the next three or four steps and keeps a log of the
  installation on the host.
- **Secrets and personal data stay out of the log and the screen history:** the SMTP password is
  read without echo; the log never holds the SMTP password, generated secrets, the chairman's
  e-mail or the chairman's sign-in link (the link is printed to the terminal once, like
  `create-chairman --print-link`).

### Layout in the repository
- **`install/`** (new): the public install on the association's own VPS: `install.sh`,
  `update.sh`, its Compose file and Caddyfile, and a README for the administrator of the
  association. Shared parts (the Caddy snippet `(environment)`, the health check and rollback)
  are reused, not copied.
- **The project's own deployment** (today `deploy/`) is renamed, for example to
  `deploy/project-vps/`, so that nobody takes it for the public install. The exact names are
  settled in R5c.
- **Renaming without breaking CD or rollback:** the ssh gate on the project's VPS checks for
  `deploy/deploy.sh` in a release, extracts only `*/deploy/*` from it and runs that script, and a
  rollback in `deploy.sh` runs the previous release's own script. A plain rename would stop
  deploys until `bootstrap.sh` runs again and would break a rollback to a release from before the
  rename. So both the gate and the rollback look for the script at either path; the new gate is
  applied on the host first (with an entry in `HOST_CHANGELOG.md`), and the rename is merged after
  it. Shared parts (the Caddy snippet, the health check and rollback) sit where both the gate's
  extraction and the `install/` archive include them.
- **Versions and the existing state:** `current_sha`, `previous_sha`, `releases/<sha>` and
  `deploy/cleanup.sh` know commit SHAs; cleanup reads the environments from the configuration
  since R5a. Settled in R5b: a version is a tag on a commit, its release directory stays
  `releases/<sha>/` with a `VERSION` file, and the image is pulled by its commit tag, so the deploy
  state, the rollback and the clean-up stay as they are and no version image piles up on the
  server (B-11).
- **Host Configuration as Code** (AGENTS.md) gets narrower wording in R5a: it applies to the
  project's own hosts (the renamed directory, its host files and `HOST_CHANGELOG.md`). An
  association's VPS is configured only by `install.sh` and `update.sh` from a release; their log
  stays on that host, never in this repository.
- The rename also updates `.github/workflows/deploy.yml`, docs/DEPLOYMENT.md and
  docs/ARCHITECTURE.md.

### Hostnames
- On a clean VPS port 443 is free, so HTTPS runs on the default port: Caddy's own HTTP to HTTPS
  redirect works and URLs carry no port.
- Without an own domain the address is `<ip-with-dashes>.sslip.io`: nothing to register,
  certificates as usual. With an own domain, one DNS record points it at the VPS.

## 5. Stages of a rollout

| Stage | Who | What | Exists | Missing |
| :--- | :--- | :--- | :--- | :--- |
| 0. Platform ready for real data | developers, once | demo mode a choice of each installation; the database and the files directory know which installation they belong to; versioned releases; backups | public image, chat off by default | R1, R5b, R6 |
| 1. The install | the association's administrator, about 15 min | `install.sh` on a clean VPS: Docker, secrets, Caddy, HTTPS, empty building, first chairman's link | most of it in `bootstrap.sh`, `create-chairman` | R2, R5a |
| 2a. The building is filled (first associations) | chairman fills a template, administrator imports | apartments (number, entrance, floor, area) and meters (apartment or none for a building meter, resource, unit, serial number, location label, initial value, limit); the template is prefilled from the register where it knows the building (section 6a) | the register's parts of the building (E12 X2) | R3 |
| 2b. The same in the app (later) | chairman | the setup wizard over the same core as 2a: details from the register, apartments (the register's proposal, by count or by hand), entrances, meters, review, start | the register lookup (E12) | R7 |
| 3. The team | chairman | invites the board and the accountant, uploads the articles and house rules, chooses settings | everything | - |
| 4. Residents | chairman | bulk invitations of the owners by e-mail, the connection overview per apartment, join codes on paper confirmed by the chairman (section 6b); owners invite their tenants; apartments without anyone work on paper | one invitation at a time | R4a, R4b, R4c (R4c may follow the pilot, section 7) |
| 5. The first month (pilot) | board, accountant, administrator | readings, paper apartments, the accountant's export, logs and traces | everything | feedback as issues |
| 6. Running administration | chairman | replace a meter, add an apartment, change an area; a change of owner (B-10) | nothing | R8, B-10 |

## 6. E-mail by audience

| Where | What | Why |
| :--- | :--- | :--- |
| local runs, test accounts only | Mailpit (exists, the `mail` profile of the local `docker-compose.yml`, never deployed) | mail is caught and never delivered |
| the pilot with real residents | a regular mailbox with an app password over SMTP, no own domain needed | **never Mailpit:** it is one inbox for everyone, so whoever opens it sees every sign-in link and can act as anyone |
| the official launch | an own domain with a transactional provider (a free tier is enough for a building), SPF and DKIM | providers want a verified sender domain; mail from a fresh server without them lands in spam |
| other associations | the installer asks for their SMTP account (their mailbox or their provider) | SMTP is generic, no code changes |

- The chairman: `create-chairman --print-link` prints the invitation link to the terminal of the
  administrator, who hands it over (exists).
- **The board, the accountant and residents are invited by e-mail only.** Handing invitation
  links over by hand is not done: it would break a promise of the login contract (docs/API.md
  section 7, only the mailbox owner holds an invitation link). The link would tell the person
  who invites whether the e-mail has an account, and would let them register an account under
  someone else's unverified e-mail. With a regular mailbox it is not needed.
- **Join codes on paper** (section 6b) keep this rule: a code hands over no invitation link. It
  only asks the chairman to invite; once confirmed, the link goes by e-mail to the mailbox owner
  like every invitation.

## 6a. Filling the building (designed 2026-11-21)

Planning record: docs/cli_planning/2026-11-21-building-and-residents.md.

### Owner decisions
- **A template prefilled from the register now; the in-app wizard is designed with it.** The
  administrator's commands (R3) and the later setup wizard (R7) call the same core, so R7 adds
  screens, not logic.
- **Apartments only:** of the register's parts of the building, only apartments are taken; shops
  and offices (non-residential parts) are not, the association accounts for them separately. The
  chairman may still add such a part as a row by hand: it then works like an apartment (its owner
  can be invited, its meters count in the building's balance).
- **What the register cannot know comes from the chairman:** the register holds the apartment
  numbers, areas and floors, but no entrance (staircase) numbers and no meters
  (docs/external_providers/ee/building_facts.md).
- **The template holds no personal data:** apartments and meters only. Residents' e-mails are
  entered by the chairman in the app (section 6b).

### One core
- **Laying out the building** takes the full list (apartments with number, entrance, floor and
  area; meters with their apartment or none for a building meter, resource, unit, serial number,
  location label, initial value and limit), checks all of it first and writes it in one
  transaction through new creating methods of the `property` and `meters` services on one shared
  session, or writes nothing.
- **Where it lives:** outside the modules, in `src/core` (like `src/core/seed.py`), because it
  calls both services; R7's chairman endpoints get their router next to it. The exact module is
  R3's contract.
- **First filling only:** the import refuses as a whole when the building already has any
  apartment or meter (building meters have no natural key, so a second import would duplicate
  them). Adding apartments later is running administration (R8). Nothing entered by hand is ever
  overwritten.

### Where the draft comes from
- **The register** (E12 X3): a new pure method of the register provider turns the building's
  passport block into a draft: the parts of kind apartment, with their number, area and the floor
  of their entrance. A provider of another country implements the same method. A part of kind
  apartment without a number, or with a number longer than the app allows, is reported in the
  command's output, never dropped silently.
- **A count:** apartments `1`..`N` when the register does not know the building; areas are then
  filled in by the chairman.
- **Entrances by ranges of positions:** `1-24,25-48` means the 1st to 24th apartment and the 25th
  to 48th in the natural order of the numbers (`2`, `10`, `14`, `14A`), so letter suffixes need no
  rule. Overlapping ranges, gaps, a range beyond the last apartment and apartments left over are
  errors; without the option every apartment is in entrance 1. The template shows the result, and
  the chairman corrects it there.
- **A default set of meters per apartment** (for example cold and hot water): one template row per
  meter, so a second riser is one more row with the same apartment; an apartment without meters is
  one row with the meter columns empty.

### The template (owner, 2026-11-21, second round)
- **Default meters:** cold and hot water for every apartment, because in Estonia an apartment
  pays the association only for its water; electricity is paid by each apartment to its own
  supplier. `--meters` gives another set, with a count per type (`COLD_WATER:2,HOT_WATER:2` for a
  kitchen and a bathroom riser), and the one-row-per-meter format already allows any mix per
  apartment. A stored per-building set of meter types is not built now: it belongs to the wizard
  (R7) and to adding apartments later (R8).
- **Building meters:** the template has one row per type for the building's own meter (the water
  meter where the water enters the building, which the water company bills the association by).
  A building without one deletes the row.
- **Only real meters:** an apartment with fewer meters than the default deletes the extra rows
  rather than filling them with zeros: a meter in the app is due a reading every month. The
  resident never deletes a meter; a wrong meter is switched off by the chairman (R8; the meter
  keeps its history). A meter missing from an apartment is reported by the resident to the board
  through the apartment's messages (E8).
- **Optional columns:**
  - `initial_value`: where the association has the readings of its last bill (the accountant or
    the management company does), they go here. Where it is empty, the resident's first reading
    starts the meter (R3b below).
  - `serial_number`: few people know it at the start; the chairman sets it later (R8).
  - `location` (kitchen, bathroom): empty becomes `Main`; two meters of one type in one apartment
    need different locations, so that the resident sees which is which.
  - `unit` and `max_monthly_delta`: empty takes the default of the type (docs/API.md section 1).
- **Areas** are rounded half up to 2 decimal places by the import, which reports how many it
  rounded; never to whole square metres, because the area divides the shared costs.
- **Column names** are in English.

### The administrator's commands (R3)
The exact contract is docs/API.md section 1, "Filling the building of a new installation".
- `building-template --out <file.csv> [--from-register [<building code>] | --apartments <N>]
  [--entrances <ranges>] [--meters <types>] [--no-building-meters]` writes the template; the
  building (R2) must exist and have no apartments or meters yet.
- **`--from-register`** drafts from the building's accepted passport block, else from its
  proposal. Only when it has neither does it fetch the building once, with the register's
  building code given to the option (kept as the proposal, like the chairman's proposal action);
  the building itself stores no register code (`registry_code` is the association's code in the
  commercial register), so without a block and without a code the command stops with a clear
  error. Like `find-building`, it does not count against `REGISTRY_CALLS_PER_DAY`, and its exit
  codes follow `find-building`.
- `import-building --file <file.csv> [--dry-run]`: every problem with its row number, nothing
  written when there is any; `--dry-run` writes nothing at all. Output and logs carry row numbers
  and counts only.
- **What a spreadsheet saves is accepted:** the separator (`,` or `;`) is detected from the header
  line, a byte order mark is skipped, and a decimal comma is accepted with `;` or inside quoted
  cells; a file that is not UTF-8 is refused with a message that says how to save it as
  "CSV UTF-8". The template is written with `;`, decimal commas and a byte order mark, so it opens
  in a spreadsheet with Estonian settings as it is, and it is protected against spreadsheet
  formulas (`src/core/csv_safety.py`), which the import strips again.
- **Values:** areas as above; meter values `Numeric(12,3)`, never a float, more than 3 decimal
  places is an error; a missing required value is an error of its row.
- **The installer:** when the register found the building, it runs `building-template
  --from-register <the building code it picked>`, writes the template next to the installation's
  settings and prints the import command as one of its next steps; otherwise it prints
  `building-template --apartments <N>`.

### The first reading of a meter without a start (R3b)
A meter imported without `initial_value` has no known start until its first reading.
- **The resident's first reading asks for two values** (owner, 2026-11-21): the reading of the last
  bill, optional, and the current one. With both, the consumption of that month is known at
  once; the chairman checks such a start against the last bill. This is the only case where a
  resident gives a previous value, and it happens once per meter.
- **Without the bill's reading,** the first reading is the meter's start: it shows no consumption
  for that month, and the next month counts from it.
- **The board sees how each reading started** (from the history, from the meter's initial value,
  given with the reading, or a start), may correct it like any reading, and the accountant's
  export carries it.
- Contract: docs/SCHEMA.md (`meters_readings.previous_origin`, nullable `initial_value` and
  `serial_number` of `meters_devices`) and docs/API.md sections 2 and 3.

### The setup wizard later (R7)
The same core behind chairman endpoints: the register's proposal or a count, entrances, meters,
review, start. Its endpoints and screens are R7's contract and its own planning session; the core
and the template columns of R3 do not change for it.

## 6b. Connecting the residents (designed 2026-11-21)

Once the chairman has signed in for the first time, the task is to bring the people of the
building in. Owners are invited by the chairman, tenants by their owners (E7, unchanged); family
members get no access of their own; an apartment without anyone works on paper (the chairman or
the accountant enters its readings).

### Owner decisions
- **Residents' e-mails are entered only by the chairman,** in the app. The administrator of the
  installation only enters the first chairman's e-mail (`create-chairman`).
- **Bulk invitations** as below.
- **The first invitation is in the instance's default language (`DEFAULT_LOCALE`; in Estonia the
  state language, Estonian) or in English,** picked per invitation; an e-mail that already has an
  account still gets the language of that account (unchanged).
- **A connection overview per apartment** with pagination from the start; an apartment opens its
  existing card (E8 P1).
- **Join codes on paper,** confirmed by the chairman. **The chairman sees the full name, phone and
  e-mail a person typed into a join request** (owner, 2026-11-21): an exception to the masking of
  personal data, listed in AGENTS.md, for the chairman only and only until the decision.
- **A tenant is the owner's relation:** the chairman never invites a tenant, even when the owner
  is not in the app (section 9, question 6).

### Three tasks
R4 is split so that the riskiest part (a public page that collects personal data) does not hold
up the rest: **R4a** bulk invitations and the queue, **R4b** the connection overview, **R4c** join
codes and join requests. All of their actions need a real sign-in (a Bearer token; the demo
header is refused, like every account endpoint of docs/API.md section 7), and join codes are
refused altogether in demo mode. The module is `auth`, which owns invitations; `property` never
imports `auth`.

### R4a: bulk invitations of owners
- The chairman pastes or uploads a list of rows `apartment number; e-mail; language (optional:
  the default or en)`. The list is parsed in memory and never stored (not in the file storage of
  E11). At most twice the number of apartments rows, at most 1 MB.
- **A preview before anything is sent,** per row: no such apartment, a duplicate in the list, an
  invitation already pending (as `409 INVITATION_ALREADY_PENDING` of today). **Never "already a
  member":** no answer may tell whether an e-mail has an account (docs/API.md section 7, E7 3.6).
- **Send:** one action; the server checks every row again (things may have changed since the
  preview) and creates `OWNER` invitations (E7).
- **The language** is stored on the invitation and used for every send of it until it is
  accepted; the same optional language is offered on single invitations.
- **Limits:** bulk rows, confirmed join requests (R4c) and "resend all expired" count against one
  limit per building per 24 hours of twice the number of apartments; single invitations keep their
  10 per inviter per hour.
- **The queue:** invitations go out through a queue with pacing and retries (a regular mailbox of
  the pilot limits how much it sends per hour), and also wait there while the installation has no
  working e-mail (section 3). Unsent invitations are visible in the overview. **Resend all expired**
  is one action.

### R4b: the connection overview
- Chairman only. Per apartment: number, entrance, a status, the number of active owners and
  tenants (never names), and the date of the newest invitation or code.
- **Statuses**, the first that applies: `CONNECTED` (an active owner), `JOIN_REQUEST` (a request
  waits for the chairman), `INVITED` (an invitation pending), `CODE_ISSUED` (an unused code),
  `TENANT_ONLY` (only tenants are active: nobody there can invite or vote), `PAPER` (marked by the
  chairman as worked on paper), `EXPIRED` (the newest invitation or code ran out unused),
  `NOT_INVITED` (also after a rejected or expired request).
- A summary on top (34 of 60 connected), a filter by status, `limit` and `offset` like the other
  lists of the API. Join requests also have their own list, because a co-owner's request hides
  behind `CONNECTED`.
- The screen is a frontend task: the list "apartment - status", the link to the apartment card,
  the join requests with their actions, the paper mark.

### R4c: join codes on paper
- **Issue:** the chairman picks apartments (by default those without an active owner and with
  nothing pending) and the server makes one code per picked apartment. The codes are in that
  answer only (`Cache-Control: no-store`): the server keeps a keyed hash, like every link of E7,
  so they are printed right away. An apartment may hold several unused codes (co-owners); a code
  ends only when it is used, expires or the chairman cancels it ("replace" a lost sheet = cancel
  that code and issue a new one). Issuing never touches pending requests. Rotating
  `AUTH_HASH_SECRET` voids every code, like every link.
- **The code:** 10 characters of Crockford's Base32 (no `I`, `L`, `O`, `U`; look-alikes mapped on
  input), about 50 bits, shown in groups (`K7QF-M3TX-9R`), single use, valid 30 days by default
  (an instance setting). Input is normalised: case, hyphens and spaces ignored.
- **The printed sheet** is made by the client from the issue answer, never by the server or a
  third-party service (the QR code too): the association's name, the site's address, the apartment
  number, the code, a QR code with `https://<site>/join#code=<code>` (after `#`, so the code never
  reaches a server log) and short instructions in the default language, English optional; one
  apartment per page or several with cutting lines.
- **The join page** needs no sign-in. Step 1: the code -> the server shows only the building's name
  and the apartment number to confirm. Step 2: the person enters their full name, phone and
  e-mail; the page says plainly that these personal data are needed so that the chairman can
  confirm them, links the association's privacy notice (section 9, question 3: a prerequisite of
  R4c), and says they are deleted after the decision. Step 2 checks the code again and uses it up
  atomically; a join request waits for the chairman.
- **Abuse limits:** per IP address (for example 20 lookups and submits per hour, like the redeem
  limit of docs/API.md section 7). No per-building limit that blocks: an installation has one
  building, so any visitor could use it up for every owner; a high ceiling only raises an alert
  (docs/OBSERVABILITY.md). Every wrong, used or expired code gets the same generic answer with the
  same timing (and so does a cancelled one), and the answer of step 2 does not depend on whether
  the e-mail has an account.
  Nothing is ever sent to the typed e-mail before the chairman confirms, so the form cannot be used
  to send mail to anyone.
- **The chairman is told** by an in-app notification `JOIN_REQUEST_SUBMITTED` (E1; ids only, no
  personal data in it).
- **The chairman decides:** confirm, reject or later, with the hint "a name alone is not enough:
  confirm when the phone matches your list of members, or call the owner at the number from your
  own list". Confirming creates an ordinary `OWNER` invitation to that e-mail; the chairman who
  confirms becomes its inviter, so they see that e-mail like any e-mail they typed (docs/API.md
  section 7). Its language is the one the person used on the join page when that is the default
  language or English, else the default (the owner decision above). When an `OWNER` invitation of
  that e-mail and apartment is already pending, that one is resent instead: it keeps its inviter,
  and its stored language becomes the join page's language by the same rule. The person registers
  as usual.
- **Why the chairman confirms:** a sheet from a mailbox does not prove who owns the apartment,
  and an owner invites tenants and votes in the polls of owners. The e-mail itself is proven by the
  invitation link, as for every invitation. Handing the sheets over in person (at the general
  meeting, against a signature) is the safest; mailboxes need the check. A sign-in with Smart-ID or
  the ID card (E7, later country plugins) could confirm the person automatically one day.
- **The data of a request** (full name, phone, e-mail) live only until the decision: a confirmed
  request keeps the e-mail in its invitation, a rejected one keeps none of them; an undecided
  request is deleted after 30 days (its decision record says `EXPIRED`, and the apartment shows
  `NOT_INVITED` again). **A record of each decision without personal data** stays:
  apartment, outcome, who decided (none for `EXPIRED`) and when (one person decides alone, so the
  board can see what was done). A wrong confirmation is undone by ending that membership (E7
  3.7). The code and the request's data never reach logs or spans: the field of the join endpoints
  is named `join_code` (never a bare `code`), and `join_code` joins the scrubber's markers, which
  match by substring; `full_name`, `phone` and `email` already are.

## 7. Tasks

| Task | What | Size | Needs the owner |
| :--- | :--- | :--- | :--- |
| R0 ([#155](https://github.com/Chemoday/apartment-association-platform/issues/155)) | This page, the planning record, issues | S | approve the page |
| R1 ([#158](https://github.com/Chemoday/apartment-association-platform/issues/158)) | Demo mode as a choice of each installation: the flags come from its settings instead of being fixed to `true` in `deploy/docker-compose.deploy.yml`; `docker compose up` stays a demo out of the box. What already holds: no notifications in demo mode, sign-in mail and uploads in demo only on `ENVIRONMENT` local, dev or test. New: the `ENVIRONMENT` of a demo installed on a VPS (and so whether it allows uploads), the plugin and `FILES_IN_DEMO` switches that `deploy.sh` fixes for dev and prod moved into each installation's settings. The installation marker with an `INSTANCE_ID` in the database and in the files directory (B-4, S-7). Settled in R1: the settings of dev and prod in `deploy/environments/<env>.env`; a demo on a VPS runs as `ENVIRONMENT` `prod`, so without uploads and sign-in mail, like the public demo; demo mode is refused on the data of a real installation (docs/DEPLOYMENT.md "Demo mode and the installation marker") | S | no |
| R2 ([#159](https://github.com/Chemoday/apartment-association-platform/issues/159)) | Operator command `create-building`: name, address, register code, country, reading deadline day; refuses when a building exists | S | no |
| R3 ([#170](https://github.com/Chemoday/apartment-association-platform/issues/170)) | Filling the building (section 6a): the core that lays out apartments and meters in one transaction; `building-template` (the register's draft through E12 X3, or a count; entrances by ranges; default meters) and `import-building --file <csv> [--dry-run]`; the installer writes a prefilled template when the register found the building. The template holds no personal data | M | approve the template |
| R4a ([#171](https://github.com/Chemoday/apartment-association-platform/issues/171)) | Bulk invitations of owners by the chairman (section 6b): a preview, a daily limit per building, the language per invitation, the queue with pacing and while there is no working e-mail (section 3), resend all expired | M | a mailbox for the pilot |
| R4b ([#172](https://github.com/Chemoday/apartment-association-platform/issues/172)) | The connection overview per apartment (section 6b), with pagination | S | no |
| R4c ([#173](https://github.com/Chemoday/apartment-association-platform/issues/173)) | Join codes on paper and join requests confirmed by the chairman (section 6b) | M | the privacy notice of the join page (section 9, question 3) |
| R5a ([#162](https://github.com/Chemoday/apartment-association-platform/issues/162)) | The simple install (section 4): `install/` with `install.sh` and `update.sh` from a clean Debian or Ubuntu server, one environment, no CI key, Docker installed when missing, the questions answered by flags too (for tests); the operator command that looks a building up in the register; SMTP set again by running the installer; tried in throw-away system containers and finally on a freshly reinstalled test VPS | M | done: the questions (owner, 2026-11-18) |
| R5c | The project's own deployment renamed (for example `deploy/project-vps/`) without breaking CD or rollback (section 4, "Renaming") | S | no |
| R5b ([#164](https://github.com/Chemoday/apartment-association-platform/issues/164)) | Versioned releases: an image tag `v0.x.y` built from a git tag, and the `install/` archive attached to the release; an installation follows a version, not `main`. Settled in R5b: the tag `vX.Y.Z` on a commit of `main` is the owner's decision; the release workflow re-tags the image CI built for that commit (no rebuild) and publishes `install.sh` and `aap-release.tar.gz` with the version baked in; `update.sh` takes the latest or a given version and refuses an older one without `--allow-downgrade` (docs/DEPLOYMENT.md "Versions and releases") | S | no |
| R6 | Backups (B-3), switched on by the installer | M | where backups are kept, off the VPS |
| R3b ([#170](https://github.com/Chemoday/apartment-association-platform/issues/170)) | The first reading of a meter imported without an initial value (section 6a): the resident may give the reading of the last bill, else the first reading starts the meter; the board sees how each reading started | S | done: the rule (owner, 2026-11-21) |
| R7 | The setup wizard in the app (stage 2b): screens and chairman endpoints over the core of R3 (section 6a), with the register's apartment list (E12 X3) | L | yes, its own planning session |
| R8 | Running administration: replace a meter, switch a wrong meter off, set a meter's serial number (optional since R3), add an apartment, change an area | M | no |
| R9 | SMTP in the app's building settings, for the chairman: the password encrypted in the database, a test mail, the server's settings as the fallback | M | yes |

R1-R5b need no deep involvement of the owner. R1-R6 are done before the pilot (B-3 is due
before the first real association); R4c may follow the pilot if its privacy notice (section 9,
question 3) is not ready by then. One branch and one pull request per part of the epic, one
commit per task.

**Residents' e-mails are personal data,** and only the chairman enters them, in the app (section
6b). The building template carries none: apartments and meters only (section 6a).

## 8. Out of scope

- **Hosting many associations** (one company running the installations of many associations,
  orchestration of their images, a shared mail account): a separate private repository (owner,
  2026-11-18). This repository only keeps the simple install working for one association per VPS.
- **E-mail delivery of our own:** the platform is an SMTP client only (B-8).

## 9. Open questions

1. ~~Are the first associations brought in with the import (2a), with the wizard (2b) later?~~
   Settled 2026-11-21: the import first (R3), the wizard (R7) designed on the same core and built
   later (section 6a).
2. Is the owner's building the pilot?
3. Who prepares the privacy notice for residents and the data processing agreement (the
   association is the controller, the platform the processor)?
4. ~~A printed letter with an invitation QR code for apartments without a known e-mail: useful,
   but the letter can be taken by the wrong person.~~ Settled 2026-11-21: join codes on paper,
   each use confirmed by the chairman (section 6b).
5. Which transactional mail provider for the official launch, and the domain.
6. ~~A rented apartment whose owner is not in the app: may the chairman invite the tenant
   directly?~~ Settled 2026-11-21: no. A tenant is a relation between the owner and their tenant;
   for the chairman and the board the owner is the member, so only an owner invites tenants (E7,
   unchanged). Such an apartment works on paper until its owner connects.

## 10. Verification of the epic

On a clean VPS: `install.sh` (real installation, about 15 minutes) -> the prefilled template the
installer wrote (or `building-template --apartments <N>`) -> `import-building --dry-run` ->
`import-building` -> the chairman's link from the installer -> sign-in -> the reading matrix of the
current month shows every apartment -> a bulk invitation brings an owner in, and so does a join
code on paper confirmed by the chairman (once R4c is done) -> the connection overview shows them
`CONNECTED` -> an owner submits a reading -> `update.sh <next version>` keeps the data. `pytest`
stays green and `docker compose up --build` still starts a demo with nothing filled in.
