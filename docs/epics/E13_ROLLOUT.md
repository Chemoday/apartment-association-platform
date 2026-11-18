# E13. Rollout: bringing a new association onto the platform

- **Phase:** 2. **Status:** designed on 2026-11-18, documentation only (task R0
  [#155](https://github.com/Chemoday/apartment-association-platform/issues/155)); epic
  [#156](https://github.com/Chemoday/apartment-association-platform/issues/156). Planning record:
  docs/cli_planning/2026-11-18-rollout.md.
- **Goal:** a real association gets its own installation, its building, apartments and meters,
  its board and its residents, without the demo seed and without hand-made changes on the server.
- **Related:** backups (docs/BACKLOG.md B-3), one database per environment (B-4), installer and
  e-mail (B-8), a change of the apartment's owner (B-10), disk hygiene (B-11) and resource limits
  per instance (B-12), demo mode in real use (security backlog S-7), bulk import (E5, delivered by
  R3 and R4), the apartment list from the register (E12 X3), login and invitations (E7).

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/DEPLOYMENT.md, docs/FRONTEND_GUIDE.md) in its first
commit; where they differ, the contract wins.

## 1. Why

Today a building, its apartments, meters and memberships exist only when the demo seed creates
them (`src/core/seed.py`). The operator command `create-chairman` needs exactly one building in
the database, so a new installation without the seed cannot even get its first chairman. Dev and
prod both run in demo mode, where anyone can act as the chairman.

## 2. What exists already (checked 2026-11-18)

- **One installation per association:** dev and prod are separate Compose projects on the VPS
  with separate databases and secrets, behind one Caddy edge (`deploy/edge/Caddyfile`, snippet
  `(environment)`) that obtains and renews certificates itself.
- **The first chairman:** `python -m src.modules.auth create-chairman --email ...
  [--print-link]` (docs/API.md section 7, "First chairman of a new installation").
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
- **E-mail waits** (B-8): no mail provider for now. People get in through links handed over by
  a person (section 5).
- **Hostnames per installation stay on the existing Caddy edge,** not nginx: Caddy already
  issues certificates and holds the upload limits and timeouts of every environment.

## 4. Stages of a rollout

| Stage | Who | What | Exists | Missing |
| :--- | :--- | :--- | :--- | :--- |
| 0. Platform ready for real data | operator, once | no demo mode or seed on a real installation; backups off the VPS; the database and the files directory know which installation they belong to | separate environments, chat off by default | R1, R6 |
| 1. A new installation | operator, about 30 min | host file, Compose project, secrets, hostname, empty building, first chairman | `bootstrap.sh`, `create-chairman` | R2, R5 |
| 2a. The building is filled (first associations) | chairman fills a template, operator imports | apartments (number, entrance, floor, area) and meters (apartment or none for a building meter, resource, unit, serial number, location label, initial value, limit) | nothing | R3 |
| 2b. The same in the app (later) | chairman | the setup wizard: details from the register, apartments (by hand, CSV or the register's proposal), meters, review, start | the register lookup (E12) | R7 |
| 3. The team | chairman | invites the board and the accountant, uploads the articles and house rules, chooses settings | everything | - |
| 4. Residents | operator or chairman | invitations from the same template; apartments without an e-mail work on paper | one invitation at a time | R4 |
| 5. The first month (pilot) | board, accountant, operator | readings, paper apartments, the accountant's export, logs and traces | everything | feedback as issues |
| 6. Running administration | chairman | replace a meter, add an apartment, change an area; a change of owner (B-10) | nothing | R8, B-10 |

### Hostnames
- An installation is one site block on the edge, `{$<SLUG>_HOST} { import environment
  aap-<slug>-backend }`, with the hostname in `/opt/aap/edge/.env`. While HTTPS runs on a
  non-default port (8443, docs/DEPLOYMENT.md), every hostname also joins the explicit
  `http://... { redir ... }` block, and URLs carry the port. R5 generates both from `deploy/`
  (for example one `sites/<slug>.caddy` file per installation, imported by the Caddyfile), so
  nobody edits the Caddyfile by hand.
- Until there is a domain, the hostname is `<slug>.<ip-with-dashes>.sslip.io`, like dev today:
  nothing to register, certificates as usual. With an own domain later, one DNS record
  `*.<domain>` covers every association.
- Not paths (`<domain>/<slug>/`): sessions and cookies of different associations would share
  one host, and the frontend would need a base path.

## 5. E-mail waits: how people get in

- The chairman: `create-chairman --print-link` prints the invitation link to the operator's
  terminal, who hands it over (exists).
- The board, the accountant and residents: **not decided yet** (open question 6). Handing the
  invitation link to the person who invites breaks a promise of the login contract (docs/API.md
  section 7): only the mailbox owner holds an invitation link. With the link the inviting person
  learns whether the e-mail has an account (`REGISTRATION_REQUIRED` / `SIGN_IN_TO_ACCEPT`) and
  can register an account under someone else's e-mail that nobody has verified; once e-mail is
  turned on, that account and its password stay with them. The link also works again until the
  invitation is accepted (7 days), it is not single-use.
- If the owner accepts it, the narrowest form: only the chairman gets links, only while no e-mail
  plugin is enabled, the account is marked "e-mail not verified" until its first sign-in by an
  e-mail link, and R4's contract commit changes the promise in docs/API.md.
- The other way out is to turn e-mail on before residents are invited: a regular mailbox with an
  app password (B-8) is enough, no own domain needed.

## 6. Tasks

| Task | What | Size | Needs the owner |
| :--- | :--- | :--- | :--- |
| R0 ([#155](https://github.com/Chemoday/apartment-association-platform/issues/155)) | This page, the planning record, issues | S | approve the page |
| R1 | A real installation: demo mode and seed come from each environment's settings instead of being fixed to `true` in `deploy/docker-compose.deploy.yml`, off on every real installation `aap-<slug>` (S-7; dev and the public demo keep them); the installation marker with an `INSTANCE_ID` in the database and in the files directory (B-4) | S | no |
| R2 | Operator command `create-building`: name, address, register code, country, reading deadline day; refuses when a building exists | S | no |
| R3 | Operator command `import-building --file <csv> [--dry-run]`: apartments and meters from a template, all checked first, written in one transaction or not at all. It lives outside the modules (like `src/core/seed.py`) and writes only through the services of `property` and `meters` on one shared session | M | approve the template |
| R4 | Invitations from the same template (needs e-mail, or the owner's decision on handing links over, section 5) | S | yes, open question 6 |
| R5 | A parametrized installation `aap-<slug>` in `deploy/`: host file, secrets generated by the script, edge site file and redirect, `deploy.sh` and the plugin and `FILES_IN_DEMO` switches for any environment name (today only `dev` and `prod`), how a release reaches `aap-<slug>` (CD and the ssh gate know only dev and prod), `HOST_CHANGELOG.md` | M | the name of the first installation |
| R6 | Backups (B-3) | M | where backups are kept, off the VPS |
| - | E-mail (B-8) | waits | an account later |
| R7 | The setup wizard in the app (stage 2b) with the register's apartment list (E12 X3) | L | yes, its own planning session |
| R8 | Running administration: replace a meter, add an apartment, change an area | M | no |

R1-R3 and R5 need no deep involvement of the owner; R4 waits for open question 6. R1-R6 are
done before the pilot (B-3 is due before the first real association). One branch and one pull
request per part of the epic, one commit per task.

**Residents' e-mails are personal data.** The template that carries them goes from the chairman
to the operator: it is never committed, it is deleted after the import, and neither `--dry-run`
nor the logs print e-mails (counts and row numbers only).

## 7. Open questions

1. Are the first associations brought in by the operator (2a), with the wizard (2b) later?
2. Is the owner's building the pilot?
3. One installation per association on one VPS for the first associations?
4. Who prepares the privacy notice for residents and the data processing agreement (the
   association is the controller, the platform the processor)?
5. A printed letter with an invitation QR code for apartments without a known e-mail: useful,
   but the letter can be taken by the wrong person.
6. While e-mail waits: may the chairman hand invitation links over (section 5, with its risks),
   or is e-mail turned on before residents are invited?

## 8. Verification of the epic

On a clean database without the seed: `create-building` -> `import-building --dry-run` ->
`import-building` -> `create-chairman --print-link` -> sign-in -> the reading matrix of the current
month shows every apartment -> an invited resident submits a reading. `pytest` stays green and
`docker compose up --build` starts both with and without demo mode.
