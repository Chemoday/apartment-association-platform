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
  use (security backlog S-7), bulk import (E5, delivered by R3 and R4), the apartment list from
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

## 4. The simple install

### What "simple" means (the acceptance criteria of R5)
- **One command** as root on a clean Debian or Ubuntu server: download the `install/` archive of
  a release and run `install.sh`. No git, no clone of the repository, no editing of files.
- **The server is checked first:** the installer stops at once with a clear message on anything
  but an x86_64 (amd64) server, because the image is built for amd64 only; otherwise Docker would
  pull it and fail with an unclear `exec format error`. ARM images wait for a real request
  (owner, 2026-11-18).
- **At most five questions:** the address (an own domain, or none and then
  `<ip-with-dashes>.sslip.io`), the chairman's e-mail, demo or a real installation, SMTP (may be
  skipped), the name of the building. Everything else is automatic: Docker, secrets, Caddy,
  HTTPS, timers.
- **About 15 minutes** from a clean VPS to the chairman's link in the terminal.
- **Running it again is safe:** existing secrets and data are kept. Switching from a demo to a
  real installation needs a fresh database (the seed only fills an empty one); the installer
  refuses it on a database that holds the demo building (the installation marker of R1).
- **Demo skips the mail question:** a demo installation sends no mail at all (the dispatcher
  skips every notification in demo mode, sign-in mail needs `AUTH_MAIL_IN_DEMO`).
- **An update is one command,** `update.sh <version>`, with the health check and the automatic
  rollback; **backups** (R6) are switched on by the installer by default.
- Apartments and meters come in with one command and a ready template (R3).
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
  settled in R5.
- **Renaming without breaking CD or rollback:** the ssh gate on the project's VPS checks for
  `deploy/deploy.sh` in a release, extracts only `*/deploy/*` from it and runs that script, and a
  rollback in `deploy.sh` runs the previous release's own script. A plain rename would stop
  deploys until `bootstrap.sh` runs again and would break a rollback to a release from before the
  rename. So both the gate and the rollback look for the script at either path; the new gate is
  applied on the host first (with an entry in `HOST_CHANGELOG.md`), and the rename is merged after
  it. Shared parts (the Caddy snippet, the health check and rollback) sit where both the gate's
  extraction and the `install/` archive include them.
- **Versions and the existing state:** today `current_sha`, `previous_sha`, `releases/<sha>` and
  `deploy/cleanup.sh` know only commit SHAs and only the environments `dev` and `prod`. R5 maps a
  version to its release directory and rollback state, and cleanup reads the environments from
  the configuration and removes old version images too, so the disk growth of B-11 does not
  return.
- **Host Configuration as Code** (AGENTS.md) gets narrower wording in R5: it applies to the
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
| 1. The install | the association's administrator, about 15 min | `install.sh` on a clean VPS: Docker, secrets, Caddy, HTTPS, empty building, first chairman's link | most of it in `bootstrap.sh`, `create-chairman` | R2, R5 |
| 2a. The building is filled (first associations) | chairman fills a template, administrator imports | apartments (number, entrance, floor, area) and meters (apartment or none for a building meter, resource, unit, serial number, location label, initial value, limit) | nothing | R3 |
| 2b. The same in the app (later) | chairman | the setup wizard: details from the register, apartments (by hand, CSV or the register's proposal), meters, review, start | the register lookup (E12) | R7 |
| 3. The team | chairman | invites the board and the accountant, uploads the articles and house rules, chooses settings | everything | - |
| 4. Residents | administrator or chairman | invitations by e-mail from the same template; apartments without an e-mail work on paper | one invitation at a time | R4 |
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

## 7. Tasks

| Task | What | Size | Needs the owner |
| :--- | :--- | :--- | :--- |
| R0 ([#155](https://github.com/Chemoday/apartment-association-platform/issues/155)) | This page, the planning record, issues | S | approve the page |
| R1 ([#158](https://github.com/Chemoday/apartment-association-platform/issues/158)) | Demo mode as a choice of each installation: the flags come from its settings instead of being fixed to `true` in `deploy/docker-compose.deploy.yml`; `docker compose up` stays a demo out of the box. What already holds: no notifications in demo mode, sign-in mail and uploads in demo only on `ENVIRONMENT` local, dev or test. New: the `ENVIRONMENT` of a demo installed on a VPS (and so whether it allows uploads), the plugin and `FILES_IN_DEMO` switches that `deploy.sh` fixes for dev and prod moved into each installation's settings. The installation marker with an `INSTANCE_ID` in the database and in the files directory (B-4, S-7). Settled in R1: the settings of dev and prod in `deploy/environments/<env>.env`; a demo on a VPS runs as `ENVIRONMENT` `prod`, so without uploads and sign-in mail, like the public demo; demo mode is refused on the data of a real installation (docs/DEPLOYMENT.md "Demo mode and the installation marker") | S | no |
| R2 | Operator command `create-building`: name, address, register code, country, reading deadline day; refuses when a building exists | S | no |
| R3 | Operator command `import-building --file <csv> [--dry-run]`: apartments and meters from a template, all checked first, written in one transaction or not at all. It lives outside the modules (like `src/core/seed.py`) and writes only through the services of `property` and `meters` on one shared session | M | approve the template |
| R4 | Invitations by e-mail from the same template | S | a mailbox for the pilot |
| R5 | The simple install (section 4): `install/` with `install.sh` and `update.sh` from a clean Debian or Ubuntu server, one environment, no CI key, Docker installed when missing; the project's own deployment renamed without breaking CD; tried on a throw-away clean VPS | M | approve the questions of the installer |
| R5b | Versioned releases: an image tag `v0.x.y` built from a git tag, and the `install/` archive attached to the release; an installation follows a version, not `main` | S | no |
| R6 | Backups (B-3), switched on by the installer | M | where backups are kept, off the VPS |
| R7 | The setup wizard in the app (stage 2b) with the register's apartment list (E12 X3) | L | yes, its own planning session |
| R8 | Running administration: replace a meter, add an apartment, change an area | M | no |

R1-R5b need no deep involvement of the owner. R1-R6 are done before the pilot (B-3 is due
before the first real association). One branch and one pull request per part of the epic, one
commit per task.

**Residents' e-mails are personal data.** The template that carries them goes from the chairman
to the administrator: it is never committed, it is deleted after the import, and neither
`--dry-run` nor the logs print e-mails (counts and row numbers only).

## 8. Out of scope

- **Hosting many associations** (one company running the installations of many associations,
  orchestration of their images, a shared mail account): a separate private repository (owner,
  2026-11-18). This repository only keeps the simple install working for one association per VPS.
- **E-mail delivery of our own:** the platform is an SMTP client only (B-8).

## 9. Open questions

1. Are the first associations brought in with the import (2a), with the wizard (2b) later?
2. Is the owner's building the pilot?
3. Who prepares the privacy notice for residents and the data processing agreement (the
   association is the controller, the platform the processor)?
4. A printed letter with an invitation QR code for apartments without a known e-mail: useful,
   but the letter can be taken by the wrong person.
5. Which transactional mail provider for the official launch, and the domain.

## 10. Verification of the epic

On a clean VPS: `install.sh` (real installation, about 15 minutes) -> `import-building --dry-run`
-> `import-building` -> the chairman's link from the installer -> sign-in -> the reading matrix of
the current month shows every apartment -> an invited resident gets the e-mail and submits a
reading -> `update.sh <next version>` keeps the data. `pytest` stays green and
`docker compose up --build` still starts a demo with nothing filled in.
