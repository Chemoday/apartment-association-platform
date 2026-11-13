# Product Backlog (after the Phase 1 MVP)

Known problems and planned extensions that are deliberately **not** part of the MVP. Each entry
describes the problem, what the current model already supports, what blocks it, and a suggested
direction. Phase 1 tasks live in [TASKS.md](TASKS.md); phases in [ROADMAP_MVP.md](ROADMAP_MVP.md).

---

## B-1. Several buildings and management companies

- **Status:** open, design only. Target: Phase 3 (together with the managed cloud plane).
- **Raised:** 2026-10-25, during Task 5.

### Problem
The MVP assumes one association = one building = one instance ([VISION.md](VISION.md),
"Single-Tenant / Self-Hosted by Default"). Real associations do not always look like that. Two
different cases exist:

1. **One association, several buildings.** An Estonian *korteriühistu* is formed per immovable
   property, and one property can hold several buildings. Many HOAs / TSZh / OSBB also cover a
   small group of houses. This is still **one client** with several buildings inside.
2. **One management company, many associations.** Professional managers serve dozens of
   independent associations: property management firms and outsourced accountants in Estonia,
   *isännöitsijä* offices in Finland, *WEG-Verwalter* in Germany, management companies (UK) in
   Russia and Ukraine. One person works for **many separate clients**.

### What already fits
- Every domain table carries `building_id`, and composite foreign keys keep each row chain inside
  one building (`meters_*`, `comm_posts` / `comm_comments`, author apartments). Data of two
  buildings cannot be mixed even when they share a database.
- Apartment memberships are per apartment, so a person can already be a member of apartments in
  different buildings at the table level.

### What blocks it
- `core_users.building_id` is `NOT NULL` and single: a user belongs to exactly one building, and
  `CurrentUserDTO.building_id` is the scope of every query.
- `core_users.building_role` is one role per user, so "chairman of building A, plain owner in
  building B" or "accountant of five buildings" cannot be expressed.
- `PropertyService._memberships_of` returns only memberships of the user's own building, and the
  forum, alerts and meters all scope by that one building.
- There is no entity above the building: no association that owns buildings, holds the board and
  could later hold billing and governance (votes are per association, not per building).

### Suggested direction (additive, expand/contract migrations)
1. **Association level.** Add `property_associations`; `property_buildings.association_id`.
   For case 1, board roles, official notices, votes and billing belong to the association;
   meters, entrances and emergencies stay per building.
2. **Roles per scope.** Replace `core_users.building_role` with a table
   `property_role_assignments (user_id, association_id, building_id NULL, role)`. Keep the old
   column during the transition (expand), drop it later (contract).
3. **Active context per request.** The caller picks the building or association they act in
   (path segment or an `X-Building-Id` header, validated against their assignments and
   memberships). `CurrentUserDTO` is built for that context, so existing services keep scoping by
   one `building_id` and do not change.
4. **Case 2 stays a deployment question.** Keep one instance per association (privacy, backups,
   zero cross-client leaks). A management company gets either one account per instance or a
   federated portal on the managed cloud plane that lists its instances. Moving to a multi-tenant
   database is possible but contradicts the single-tenant principle and needs its own decision.

### Open questions
- Is case 1 frequent enough for the target users to do it before billing (Phase 2)?
- For case 2: separate logins per instance, or one identity (Smart-ID / Web eID) across instances?
- Do official notices and forum topics belong to the association or to each building?

---

## B-2. Forum moderation beyond the MVP

- **Status:** open. Target: Phase 2. **Tracked in:**
  [#18](https://github.com/Chemoday/apartment-association-platform/issues/18).
- **Raised:** 2026-10-25, during Task 5.

### Current state (MVP)
The chairman can soft-delete a forum topic (`DELETE /api/v1/communication/posts/{id}`,
[API.md](API.md), section 4). The topic and its comments disappear for everyone; the row keeps
`deleted_at` and `deleted_by_user_id`. Emergencies are resolved instead, and official notices
cannot be deleted.

### Missing
- Authors edit or delete their own posts and comments.
- The board hides or deletes single comments, not only whole topics.
- Residents report abusive posts or comments; the board works through a report queue.
- A moderation log: who hid or deleted what, when and why, without PII in logs or spans.
- Retention: soft-deleted content is purged after a fixed period (GDPR), keeping only the audit
  facts (who, when, which post id).
- Edit history, so an edited post cannot silently change what neighbours already answered to.

### Open questions
- Should `BOARD` members moderate too? [VISION.md](VISION.md) says the board moderates the
  forum; the MVP allows only the chairman.
- Should a deleted topic show a placeholder ("Removed by the board") instead of vanishing, so the
  conversation history stays understandable?
- How long is the retention period, and does it differ for reported content?

---

## B-3. Database backups and durable storage

- **Status:** open, not part of the MVP. Target: before the first real association uses the
  platform. Designed further on 2026-11-12 (below); nothing is set up yet.
- **Raised:** 2026-10-25.

### Problem
There are **no backups at all**. [VISION.md](VISION.md) promises "trivial single-file database
backups", but nothing creates them, and a restore has never been tried.

Where the data lives today:
- PostgreSQL data is in a named Docker volume, not in the image or the container. Removing the
  image or the container, `docker compose down` and every redeploy keep the data.
- On the VPS each environment has its own volume (`aap-dev_pgdata`, `aap-prod_pgdata`), its own
  internal network and its own password, see [DEPLOYMENT.md](DEPLOYMENT.md).
- The data is lost by `docker compose down -v`, `docker volume rm` or
  `docker system prune --volumes`. The VPS is shared with unrelated services, so a routine
  clean-up of Docker on that host can wipe both environments, with no way back.
- Locally the volume is named after the checkout directory (`<dir>_pgdata`); `down -v` deletes it.

### Idea for a solution (to be discussed)
1. **Data in a host directory per environment:** bind-mount `/opt/aap/<env>/pgdata` instead of a
   named volume. The environment name in the path keeps dev and prod apart, `docker ... prune`
   never touches it, and host-level backups see it. The existing volumes are moved once (about a
   minute of database downtime per environment).
2. **Nightly `pg_dump -Fc`** per environment into `/opt/aap/<env>/backups`, keeping 7 days, run
   on the host (cron or a systemd timer) so it works even when the app container is broken.
3. **Restore procedure** in DEPLOYMENT.md, plus an automated restore check: load the newest dump
   into a scratch database and run a sanity query. A backup that was never restored does not count.
4. **Off-server copy** (later): the dumps also leave the VPS, e.g. to object storage, encrypted.
5. **Locally** keep the named volume and document that `docker compose down -v` deletes the data.

### Design after the file storage session (2026-11-12)
Record: [docs/cli_planning/2026-11-12-file-storage-and-backups.md](cli_planning/2026-11-12-file-storage-and-backups.md).
With the file storage of epic E11 ([epics/E11_FILE_STORAGE.md](epics/E11_FILE_STORAGE.md)) a
backup is more than the database. Steps 1, 3 and 5 above stay; steps 2 and 4 are replaced by
what follows.

- **What, per instance and separately for each:** (1) the database dump; (2) the files
  directory (`files/blobs`); (3) the environment file of the instance. The secrets are part of
  the backup: without `AUTH_HASH_SECRET` a restored database has lost every session, link,
  invitation and password. The password of the backup repository and the secrets are also kept
  in the operator's password manager; a backup nobody can decrypt is no backup.
- **Tool:** `restic` (one binary; it encrypts on the client, so the storage provider sees only
  ciphertext; it removes duplicates and compresses). The dump is written uncompressed
  (`pg_dump -Fc -Z0`) into restic's standard input, so the difference between two runs is a few
  MB. The run must fail when `pg_dump` fails (`--stdin-from-command`, or `pipefail`); otherwise
  a cut-off dump is recorded as a success. Blobs never change after they are written (E11), so
  they are stored once however many snapshots refer to them. Plain nightly archives would
  multiply the files by the days kept.
- **How:** one script on the host (a systemd timer), not in the app, so it works when a
  container is broken. Instances are handled one after another at low priority (`nice`,
  `ionice`), so no two dumps run together.
- **How often:** every 6 hours, the dump first and the files right after it, in that order. So
  every dump has a files snapshot taken after it, and at most 6 hours of either are lost; this
  matters on the days of an official vote, because the signed ballots are files. Only new blobs
  are uploaded, so a run is cheap. Files are erased 14 days after they are deleted (E11), so a
  file deleted between the dump and the snapshot is still there.
- **Kept:** every snapshot of the last 7 days, then 4 weekly and 12 monthly ones. Deleted
  personal data therefore lives up to 12 more months in the backups; the privacy notice must
  say so.
- **On the VPS itself:** one compressed dump per night in `/opt/aap/<env>/backups`, kept for 7
  days (tens of MB), for a quick restore without the network. Files are not kept twice on the
  same disk: delayed deletion is the local window for undoing a mistake, and the copy outside
  the VPS holds the history.
- **Outside the VPS:** S3-compatible storage in the EU at **a provider other than the one of
  the VPS**, so that a blocked account or a lost data centre does not take both copies.
  Candidates: Backblaze B2 (an EU region, pay per use), Cloudflare R2 (a free allowance, no
  charge for downloads), Hetzner Storage Box (a flat price for 1 TB, SFTP, its own snapshots).
  With pay-per-use pricing the expected cost is under one euro a month in the first year and a
  few euros a month for 30 associations (about 90 GB); check the current prices when choosing.
  A machine at home is at best a third copy.
- **A break-in must not destroy the backups:** the bucket keeps versions (or uses object lock);
  the key on the VPS can write but cannot remove versions; `restic forget --prune` runs from a
  trusted machine only. A lifecycle rule may remove only non-current versions after some days,
  never live objects: restic's pack files are shared by all snapshots, so expiring objects by
  age would destroy the repository. For an SFTP target the provider's own snapshots play this
  role.
- **Verified:** monthly and automatically, the newest dump is restored into a scratch database
  and checked with sanity queries, every `core_files` row of that dump is looked up in the
  files snapshot of the same run, and a sample of the repository is read back
  (`restic check --read-data-subset`). An alert fires when the last successful run is older
  than 8 hours.
- **One repository per association:** a restore touches one instance; when an association
  leaves, its project, its directory and its repository are deleted.

| What happens | What saves the data |
| :--- | :--- |
| A file or a record is deleted by mistake | the 14 days of delayed deletion; a dump for a record |
| A bug or a bad migration damages the database | the newest dump (at most 6 hours lost) |
| `docker volume prune` or `down -v` on the host | host directories instead of named volumes (step 1) |
| The disk, the VPS or the provider's account is lost | the copy outside the VPS: a new VPS, `bootstrap.sh`, the restore script (hours) |
| The VPS is broken into | the copy outside the VPS that the VPS cannot destroy; new secrets |
| A backup is restored into the wrong instance | the instance marker of B-4 |

### Open questions
- Which provider holds the copy outside the VPS (an account of the owner is needed).
- Point-in-time recovery (WAL archiving) for a managed cloud; dumps every 6 hours are enough
  for now.
- An export of everything an association has, for one that leaves the platform: created by the
  operator on request. A download for the chairman is not planned (a multi-GB archive is itself
  a heavy operation).
- How long signed ballots and records of voting must legally be kept (E3 part B); the backups
  must keep them at least as long.

---

## B-4. A database must belong to exactly one environment

- **Status:** open, not part of the MVP. Related to B-3 (restores and moved data directories are
  exactly when this goes wrong).
- **Raised:** 2026-10-25.

### Problem
Nothing checks that the database the service connects to was created for this environment. If
by mistake the wrong data is attached, the service starts on it as if nothing happened. Examples:
- a prod backup is restored into the dev database (or the other way round);
- a data directory or volume is copied or mounted for the wrong environment;
- a wrong `DATABASE_URL` in an env file points one environment, or one association's instance,
  at another one's database.

The consequences are silent: dev experiments change real residents' readings, demo-mode users
(`X-Demo-User-Id`) suddenly act on real data, or notifications go out to the wrong people.

What protects us today is only the topology: on the VPS dev and prod run in separate Compose
projects with separate networks and passwords, so a dev backend cannot reach the prod database.
There is no check inside the data itself.

### Idea for a solution (to be discussed)
1. On the first start the database records which environment and instance it was created for,
   e.g. a one-row table `core_instance (instance_id, environment, created_at)`.
2. On every start the service compares it with its own configuration (`ENVIRONMENT` plus an
   `INSTANCE_ID` from the server's env file). On a mismatch it refuses to start with a clear log
   line; `/health/ready` fails, so `deploy.sh` rolls back automatically.
3. Deliberately moving data (e.g. copying prod into dev for debugging) is an explicit command that
   rewrites the marker, ideally after anonymising the copy.
4. The files directory of epic E11 carries the same marker (a file `files/INSTANCE`): the files
   of another instance, or an empty directory next to a database that has files, also stop the
   service at startup.

### Open questions
- Is `ENVIRONMENT` enough, or does each instance need its own id (several associations on one
  host, see B-1)?
- Should a prod copy in dev be anonymised automatically?

## B-5. Readings more often than once a period (smart meters)

- **Status:** note only, no work planned. Raised 2026-10-31.

### Current state
Several submissions within one period are already handled: `UNIQUE(meter_id, period_id)` keeps
one reading per meter and period, and every change writes an audit row to
`meters_reading_logs`. A new submission overwrites the value within the rules of
`POST /api/v1/meters/readings` in docs/API.md (residents only while the period is open, never over
a board correction, never once a later period has a reading).
Nothing to change for manual readings.

### When it matters
Smart electricity meters deliver hourly or 15-minute values, used to split costs by the exchange
price. If we support that, store the raw time series in a separate table (fed by the IoT readings
API, epic E4) and derive the period reading from it; do not put time series into
`meters_readings`.

## B-6. Debt reminders

- **Status:** open, depends on epic E2. Raised 2026-10-31.

### Problem
Reminding residents about unpaid bills needs payment data. By the decision in
[E2](epics/E2_BILLING_EXPORT.md) payments and balances live in the external accounting software,
so we do not have them.

### Options
- Import bank statements (ISO 20022 camt.053) and match payments by reference number.
- Read balances from the accounting software API (country plugin, e.g. Merit Aktiva).

Delivery itself reuses epic E1 (a new event type, e.g. `PaymentOverdue`).

## B-7. Real login before external notifications

- **Status:** open, **tracked in epic E7** ([docs/epics/E7_LOGIN.md](epics/E7_LOGIN.md)). Blocks real use of e-mail, Telegram and WebPush (epic E1). Raised 2026-10-31.

### Problem
There is no login: users act through `X-Demo-User-Id` (demo mode) or a Bearer JWT that only an
operator can mint. Every environment (docker compose, dev, prod) runs in demo mode, where anyone
can act as the chairman. External notifications there would let anyone broadcast fake emergencies
to real Telegram chats, devices and mailboxes. So, by owner decision, demo mode delivers in-app
notifications only, and the external channels are verified by automated tests.

### Needed before external channels go live
- A real login (e-mail magic link or password first; Smart-ID / Web eID later, see
  `core_user_identities`).
- An environment without demo mode, with its own Telegram bot and secrets
  (`TELEGRAM_WEBHOOK_SECRET`, `NOTIFICATIONS_HASH_SECRET`, VAPID keys, SMTP).

## B-8. Installer and e-mail for self-hosting

- **Status:** open, design notes. Related to B-7 (real login). Raised 2026-10-31.

### Installer
`deploy/bootstrap.sh` already sets up the user, directories, database secrets and Caddy with HTTPS.
It can grow into a wizard that asks a few questions and does the rest:
- generates every secret itself (`JWT_SECRET_KEY`, `NOTIFICATIONS_HASH_SECRET`,
  `TELEGRAM_WEBHOOK_SECRET`) and the VAPID key pair for WebPush;
- asks for the domain, optional SMTP settings and an optional Telegram bot token;
- Telegram bots cannot be created automatically (it is a one-minute chat with @BotFather): the
  person pastes the token, and the script calls `setWebhook` itself.

The app container only needs outgoing connections (SMTP provider, Telegram API, push services) and
the incoming HTTPS that Caddy already serves (Telegram webhooks accept ports 443, 80, 88 and 8443).

### E-mail
- **No own mail server**, neither in a container nor next to it. Mail from a fresh VPS ends up in
  spam (no IP reputation, PTR, SPF/DKIM/DMARC), and many VPS providers block outgoing port 25.
- The app is only an **SMTP client** of an external provider on port 587 (STARTTLS) or 465 (TLS),
  using a transactional e-mail service with a free tier, or a regular mailbox with an app password for a small building.
- Good delivery needs mail from an own domain, with the SPF/DKIM records the provider gives;
  `sslip.io` hostnames cannot carry them, so real e-mail needs a domain (a mailbox account works
  without one).

### Several associations on one server (Phase 3 managed cloud)
One SMTP account and one Telegram bot shared by all instances (a shared delivery service) instead
of one per association.

---

## B-9. Elections of the board chairman and the board members

- **Status:** title only, not designed yet (owner, 2026-11-01). Related to epic E3 (governance and
  voting).

## B-10. A change of the apartment's owner (sale, death)

- **Status:** open, notes only; **must be thought through very carefully** in the planning session
  before epic E3, together with the right to vote: who the owner is decides who votes.
- **Raised:** 2026-11-02, by the CTO review of E7/A4.

### Problem
When a flat is sold or its owner dies, the new owner joins by an `OWNER` invitation, but only the
chairman can end the old owner's membership, alone and without a trace. That is too much power
for one person. Asking the old owner to agree (for example within a month, with silence counting
as consent) does not help: silence is still the chairman's decision a month later, a refusal
either blocks a real sale or means nothing, a dead person cannot answer, and the new owner waits
outside the system meanwhile.

### What already fits
- A new owner joins by an `OWNER` invitation, at once; an `OWNER` invitation also raises a tenant
  of that flat to owner (E7/A4).
- Ending one membership closes the account only when nothing else is left (the automatic closing
  of E7).

### Constraints
- **The same for every country:** no national register. The land register is not used (who owns a
  flat is not public data there); the fact is the board's recorded decision with its reason.
- **Every such change is written to the board's action log** (with E8's audit log).
- **The whole building is never told:** who owns which flat is personal data, and a notice would
  reveal a sale or a death. Only the people concerned are told: the person, the co-owners of that
  flat and its tenants (their access depends on an owner).
- The account is not deleted: one membership ends.

### Ideas to check in the session (not decisions)
- Ending an `OWNER` membership needs a reason and a second board member's confirmation (the
  "four eyes" principle); a board of one waits a period instead.
- Co-owners and shares, inheritance (a flat without an owner for months), and what the auditor or
  the general meeting sees.

## B-11. Disk hygiene on the host

- **Status:** mostly done by E11 task F0
  ([#121](https://github.com/Chemoday/apartment-association-platform/issues/121)), see
  docs/DEPLOYMENT.md "Resource limits and disk hygiene": items 1-4 are in place (images under
  the old repository name only with `REMOVE_IMAGES_OF` in the host file, an owner decision);
  item 5 waits for the owner (`HOST_JOURNAL_MAX` in the host file); open: where a disk alert goes
  beyond the journal. **Raised:** 2026-11-12, by the file storage session
  (docs/cli_planning/2026-11-12-file-storage-and-backups.md).

### Problem
Several things grow on the VPS without a limit, long before any user file exists. Measured on
2026-11-12 (193 GB disk, 157 GB free):
- **Container logs are not rotated.** The services use the default log driver without a size
  limit; one log file had reached 101 MB in two weeks.
- **Images of old releases are never removed.** `deploy/deploy.sh` runs `docker image prune`,
  which removes only untagged images, and every image of the project is tagged with its commit.
  42 images (354-390 MB each) were on the host, about 4.6 GB of them reclaimable; every deploy
  adds one. The directories in `/opt/aap/releases` are never removed either (they are tiny).
- **The write-ahead log of PostgreSQL** may grow to 1 GB per instance with the default
  `max_wal_size`, which matters once many instances share the disk.
- **Free space needs an alert.** A full disk stops the databases of every instance and the
  unrelated services of the host, so somebody must be told well before it happens.
- The system journal of the host holds 3.9 GB (not ours to change without the owner).

### Suggested direction
1. Log rotation for every service in `deploy/docker-compose.deploy.yml` and
   `deploy/edge/docker-compose.yml` (`max-size` 10 MB, 3 files).
2. `deploy.sh` removes the project's images and release directories whose commit is neither the
   current nor the previous one of any environment (the rollback needs the previous one).
3. `max_wal_size=256MB` (a soft limit) and `temp_file_limit=512MB` (per session) for the
   database service.
4. A check on the host (cron or a systemd timer): an alert at 70% and 85% of the disk budget of
   the platform and when the host has less than 20% free. The budget and how it was derived:
   docs/epics/E11_FILE_STORAGE.md, section 10.
5. With the owner: a size limit for the system journal (`SystemMaxUse`).
6. If logs, traces or metrics are ever stored on the VPS, their retention limits come first.

### Open questions
- Where the alert goes (the on-call webhook of docs/OBSERVABILITY.md, e-mail or a messenger).

## B-12. Resource limits per instance

- **Status:** done by E11 task F0
  ([#121](https://github.com/Chemoday/apartment-association-platform/issues/121)) except swap,
  which waits for the owner (`HOST_SWAP_SIZE` in the host file); the CPU limit (2 CPUs) is to be
  measured again with photo encoding (F1); "Later, for a managed cloud" stays open. **Raised:**
  2026-11-12, by the same session.

### Problem
Containers should carry memory, CPU and process limits, so that a fault in one instance cannot
affect its neighbours: the other instances and the unrelated services of the host. Decoding
images (E11) raises the need.

Measured on 2026-11-12 (6 vCPU, 12 GB): an idle instance uses 80-100 MB for the backend and
45-60 MB for PostgreSQL; its background loops use about 0.25% of one CPU.

### Suggested direction
1. In `deploy/docker-compose.deploy.yml`: backend `mem_limit` 512 MB, a CPU limit and a
   process limit; database `mem_limit` 384 MB. Two password hashes at a time need 128 MB and
   re-encoding one photo 30-75 MB (measured in E11 F1; only JPEG of at most 2560 px), so the
   backend limit leaves room for both. The CPU limit is to be measured: the event loop must stay
   responsive while a worker thread encodes a photo (a CPU weight, or 1.5-2 CPUs, instead of a
   hard limit of one).
2. A read-only root filesystem for the backend with a small tmpfs for `/tmp`: nothing can grow
   inside the container layer, and uploads go only to the files volume (E11).
3. With the owner: swap on the host as a cushion (2-4 GB).
4. **Capacity rule:** about 200 MB of memory and about 3 GB of disk per association with a full
   file quota (E11, section 10). On the current host that is about 40-50 instances by memory
   and about 37 by disk if every quota were full.

### Later, for a managed cloud
- A hard wall on disk per instance (a filesystem of its own or project quotas) instead of the
  quota inside the app alone, when associations of third parties share a host.
- Fewer background loops per idle instance (a worker role, longer idle intervals).
