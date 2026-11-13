# E11. Shared file storage with strict limits

- **Phase:** 2. **Status:** designed with the owner (2026-11-12), scheduled on 2026-11-13: epic
  [#125](https://github.com/Chemoday/apartment-association-platform/issues/125), tasks F0
  [#121](https://github.com/Chemoday/apartment-association-platform/issues/121), F1
  [#122](https://github.com/Chemoday/apartment-association-platform/issues/122), F2
  [#103](https://github.com/Chemoday/apartment-association-platform/issues/103), F3
  [#123](https://github.com/Chemoday/apartment-association-platform/issues/123), F4
  [#124](https://github.com/Chemoday/apartment-association-platform/issues/124). Planning record:
  docs/cli_planning/2026-11-12-file-storage-and-backups.md.
- **Goal:** photos of issues and meters, the board's documents and signed ballots are stored
  without any of them being able to fill the disk or load the server, so that many associations
  can share one small VPS.
- **Foundation for:** photos of issue reports (E9 task I4,
  [#103](https://github.com/Chemoday/apartment-association-platform/issues/103)), photos of
  meters (E6), documents of the board, attachments of the maintenance log (E10 part B) and
  official decisions (E3 part B).
- **Related backlog:** backups ([B-3](../BACKLOG.md)), disk hygiene on the host (B-11) and
  resource limits per instance (B-12).

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/FRONTEND_GUIDE.md) in its first commit; where they differ,
the contract wins. All sizes below are estimates to be measured again in the first task.

## 1. Owner decisions (2026-11-12)

- **Residents never upload documents of their own.** A resident uploads photos (always
  re-encoded by the server) and, for an official vote, a signed container that holds only
  ballots the server issued. PDF documents (articles, minutes, contracts) are uploaded by the
  board only.
- **Size the storage from the bottom up:** from what an association really produces, not from
  the size of the disk. The disk can be extended a little later; the aim is as many
  associations on one VPS as possible.
- **This session produces documentation and backlog entries only.** No code, no change of the
  deployment.

## 1a. Owner decisions (2026-11-13), before the implementation

- **The server accepts photos only as JPEG of at most 2560 px on the long edge.** Every client
  (the web client now, a native phone app later) scales the photo and converts it to JPEG itself;
  the operating systems and browsers do this with their own tools, HEIC photos of an iPhone
  included. The server opens only the JPEG decoder, so a PNG or WebP bomb never reaches a
  decoder, and re-encoding one photo needs about 30-70 MB (section 4). The requirement is part
  of the API contract for every client; the server still checks it and still re-encodes.
- **Uploads in demo mode only behind a flag:** `FILES_IN_DEMO=true`, set on dev only, with a small
  demo quota and a short retention, after the pattern of `AUTH_MAIL_IN_DEMO`; without the flag
  (prod) uploads in demo mode are refused (section 6).
- **`Idempotency-Key` on photo uploads:** a client repeats an upload after a lost answer and gets
  the same file back, not a second one that also counts against the quota and the daily limit.
- **The instance marker `files/INSTANCE` waits for B-4** (docs/BACKLOG.md); there is one dev and
  one prod today.
- **Everything applied to the VPS is kept in the repository** (host configuration as code): the
  configuration of the project's programs in `deploy/`, applied by idempotent scripts, the
  parameters of each host without secrets in `deploy/hosts/`, and a log of what was applied in
  `deploy/HOST_CHANGELOG.md`, so that a new VPS is set up from the repository alone
  (docs/DEPLOYMENT.md). Task F0 introduces it.
- **Three pull requests:** F0 alone; F1 with F2 (the store and its first consumer); F3 with F4.

**Documents of the association (task F3), owner decisions of 2026-11-13:**
- Kept until the chairman deletes them; **only the chairman deletes** (the file is hidden at once
  and erased after 14 days, the record of the document stays with who deleted it).
- A **fixed list of categories** in code (the client translates them).
- Every document has an **audience**: everyone (residents, board, accountant), the board and the
  accountant, or the board only (the chairman and the board members).
- The chairman and the board upload into any audience; **the accountant uploads too**, but only
  into "the board and the accountant" (invoices, reports).

Still open: how signed containers, which hold personal data, are kept (section 9).

## 2. Principles

1. **A resident's file is never passed on to other residents unchanged.** Photos are re-encoded,
   which also removes EXIF and GPS data and anything hidden in the file. The one exception is a
   signed container: it is kept exactly as received because it is evidence, it is accepted only
   when every file in it is a ballot issued by the server, it is small (2 MB), and it is served
   only as an attachment to the few people who may see it (section 9).
2. **Every stream of files has three limits:** the size of one file, a rate (per apartment and
   day) and the quota of the association. A retention period is added wherever a file loses its
   value with time.
3. **The heavy work happens on the user's phone; the server only checks again.** The client
   scales a photo down before sending it. The server still re-encodes it, but that is now cheap.
4. **Files need no job queue.** Every operation is designed to stay under about 1 s of CPU and
   100 MB of memory, and runs inside the request behind a semaphore. A job runner is needed for
   OCR (E6), bulk import (E5) and large reports, not for this epic.
5. **One instance must not hurt its neighbours** (other associations and unrelated services on
   the host): containers carry memory and CPU limits (B-12), and uploads stop when the disk is
   nearly full.

## 3. Who uploads what

| Stream | Who | Accepted input | What is stored | Cap per file | Retention |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Photo of an issue (E9 I4) | resident | JPEG of at most 2560 px, scaled by the client | WebP, long edge 1920 px (about 300 KB), and a 320 px preview (about 15 KB) | 4 MB in, up to 3 per report | while the issue is open; 30 days after it is resolved; deleted at once when it ends otherwise (owner decision 2026-11-13) |
| Photo of a meter (E6) | resident | the same | WebP, long edge 1280 px (about 150 KB) | 4 MB in | 13 months, to cover the yearly settlement (building setting, 1-24) |
| Documents: articles, minutes, contracts | the board only | PDF; a photo becomes WebP | the PDF as it is | 20 MB | kept until the board deletes it |
| Attachments of the maintenance log (E10 part B) | the board | PDF or photo | as above | 20 MB | kept |
| Ballots of an official vote | created by the server | - | PDF, 20-40 KB each, 2-3 per question | - | as long as the vote's record |
| Signed container (`.asice`) | owner | ASiC-E | the container as received | 2 MB | as long as the law requires (E3 part B) |
| Record of voting | created by the server | - | PDF, 0.1-0.3 MB | - | kept |
| CSV exports, printable notices | created by the server | - | **not stored**, streamed to the client | - | - |

Not supported: office documents and archives (macros, decompression bombs), video, and images in
forum posts (the least bounded stream; a separate decision later).

No antivirus: it needs about 1 GB of memory. Photos need none, because re-encoding destroys any
payload. The board's PDF files are stored unchanged and offered to every resident; this risk is
accepted, because only the board can upload them, they are served as attachments that the
browser never renders inside the app (section 5), and it is the same trust a resident gives to an
e-mail attachment from the board.

## 4. The upload path

1. **Client.** The client scales the photo down to 1920 px on the long edge (2560 px at most)
   and encodes it as JPEG before sending (a 12 MP photo of 4 MB becomes about 0.5 MB): a browser
   with `createImageBitmap` and a canvas in a worker, a native app with the image tools of the
   operating system. This saves mobile traffic and server CPU, and the location in the photo's
   metadata never leaves the phone. When scaling or converting fails, nothing is sent and the
   person sees a clear message (a photo taken with the camera is a JPEG anyway).
2. **Edge (Caddy).** A request body limit of 1 MB for the whole API, raised only on the upload
   routes (4 MB photos, 20 MB documents, 2 MB signed containers), and a timeout for reading a
   body that still fits the largest file on a slow mobile link (20 MB at 1 Mbit/s takes about
   three minutes).
3. **Backend, before the first byte.** An upload is a raw request body (`Content-Type` of the
   file, read with `Request.stream()`), not a multipart form: FastAPI parses a form before it
   runs the dependencies, so the server would buffer an upload before it knows who sent it.
   With a raw body the route checks the session, the rights, the rate and the quota first, then
   counts the bytes while reading and stops at the cap. A request without `Content-Length` is
   refused (411). The same pattern already reads the Telegram webhook
   (`src/modules/notifications/router.py`). Other values (a document's title) travel in the
   query or in a second request, never in the file body.
4. **Processing a photo.** In a worker thread behind a semaphore: one photo at a time per
   instance (the backend runs as one process), a short bounded queue, and 429 when the queue is
   full, like the password hashing of E7. The number of bodies being received at once is capped
   the same way.
   - Only the JPEG decoder is opened (`Image.open(..., formats=["JPEG"])`); a PNG, a WebP or
     anything else is refused (415) and no other decoder ever runs.
   - The header is read first; a photo longer than 2560 px on either edge is refused before
     decoding (422).
   - The orientation is applied and all metadata is dropped.
   - The result is written as WebP: the display size and the preview.
   Measured in F1 (Pillow 13, one image at a time, the decoded image, the scaled one and the
   WebP encoder): about 30 MB of memory and 0.35 s of CPU for the 1920 px photo a client sends,
   50-75 MB and 0.4-0.75 s for the largest accepted one (2560 px; the upper value for pure noise,
   the worst case for every codec), progressive or not.
5. **A document.** Streamed to a temporary file on the files volume while its SHA-256 is
   computed; it must start with the PDF signature; it is not parsed.
6. **A signed container.** Held in memory (2 MB at most) and checked without unpacking to disk:
   the number of entries is capped from the number of questions of the vote, the unpacked size
   is capped while reading, and the XML is parsed without entities and without network access.
   Section 9 lists what the vote itself checks.
7. **Storing.** The blob is written to `tmp/`, synced, renamed into place, and the parent
   directory is synced; only then is the row inserted in the module's transaction. A crash in
   between leaves a blob without a row (the janitor removes it), never a row without a blob.

A file is attached to its owner at once: the issue is created as text first, and each photo is
then uploaded to that issue. There is no "uploaded but not attached" state, and on a bad mobile
network only the photo is retried.

## 5. The store

- **`FileStore` is a port in `src/core`**, like building settings and domain events. The default
  implementation writes to the local disk. An S3 implementation can come later as a plugin, for a
  managed cloud; the port keeps that open.
- **On disk:** one directory per environment, `/opt/aap/<env>/files` (an environment today, one
  per association later), bind-mounted like the database directory of B-3:
  `blobs/<first 2 characters>/<file id>/` with `display.webp` and `thumb.webp`, or
  `original.pdf`, or `container.asice`; and `tmp/`. A blob never changes after it is written,
  which makes backups incremental and lets browsers cache it for good.
- **Table `core_files`** (owned by core): `id`, `building_id`, `purpose` (`issue_photo`,
  `meter_photo`, `document`, `ballot`, `signed_ballot`, ...), `owner_ref`, `content_type`,
  `size_bytes` (all variants together, as stored), `sha256`, `created_by`, `created_at`,
  `delete_after` (the retention date), `deleted_at`, `purge_after`. Modules keep only the
  `file_id`, so no module imports another module's models. `created_by` is never returned by
  the store: who may learn the uploader is the module's rule (E9 shows the reporter to the
  board only).
- **Routes belong to the modules**, there is no general `/files/{id}`:
  `POST /issues/{id}/photos`, `GET /issues/{id}/photos/{file_id}?variant=thumb`. The module
  applies its own rules ("not yours" looks like "not found") and then calls the store with the
  `purpose` and the `owner_ref` it expects; a `file_id` that belongs to another issue, another
  module or another building is "not found". Documents of the board (F3) get a small module of
  their own; the usage view (F4) is a route of core, next to the building settings.
- **Serving:** the `Content-Type` is one of a fixed list of served types, chosen by the store
  and never taken from the client; `nosniff` and a sandboxing `Content-Security-Policy` on
  every file response; PDF and signed containers only as attachments, with a file name the
  server derives from the stored title; `Cache-Control: private, max-age=31536000, immutable`.
  The client fetches images with its access token and shows them from a blob URL. Signed links
  were rejected: a link can leak through sharing, logs and the `Referer` header.
- **Deleting:** removing a file marks its row (`deleted_at`) and hides the file at once; 14
  days later (`purge_after`) the blob is erased first and the row is deleted after it. This is
  the window for undoing a mistake.
- **Background loop `files-janitor`**, after the pattern of `src/modules/auth/cleanup.py`
  (hourly, the row work in one short transaction under an advisory lock, the disk work outside
  the transaction): marks files past `delete_after`, erases what is past `purge_after`, removes
  temporary files older than an hour (`tmp/` is also emptied at startup); weekly it compares
  blobs with rows (a blob without a row and older than a day is removed, a row without a blob
  is reported as an error) and re-hashes a sample to detect disk corruption.
- **Instance marker:** a file `files/INSTANCE` is compared with the marker in the database
  (docs/BACKLOG.md B-4). A files directory of another instance, or an empty one next to a
  database that has files, stops the service at startup.

## 6. Quotas

- **`FILES_QUOTA_MB`** in the environment file of the instance: the operator of the host grants
  space, not the chairman. Default: **0.5 GB + 25 MB per apartment** (60 apartments give 2 GB).
- **Three classes.** *Photos* expire on their own and cannot use the last 20% of the quota.
  *Documents* (the board's files and attachments) can use everything except the reserve of the
  third class. *Votes* (ballots, signed containers and records of voting) have a small reserve
  of their own (5% of the quota, at least 100 MB) that nothing else may use, so neither photos
  nor a large document can block a signed vote or its record.
- The check runs before the body is read and reserves the cap of the route; the row then
  records the size as stored (a 4 MB photo counts as about 0.3 MB). Reservations are counted,
  so parallel requests cannot overshoot. A refusal has the code `STORAGE_QUOTA_EXCEEDED`.
- The board sees "used / quota / by category" and is notified at 80% and at 95%.
- **Rates:** the existing limits of reports per apartment and day (E9), and a limit of stored
  bytes per apartment and day (about 20 MB, far above what the allowed photos need after
  re-encoding).
- **Low disk guard:** when the host has less than 5 GB free, uploads are refused whatever the
  quota says, so that the database and the neighbours keep working. Signed containers are
  still accepted down to 1 GB.
- **Demo mode (owner decision 2026-11-13):** with `DEMO_MODE_ENABLED` callers are not signed in,
  so a public demo would host files for anyone. Uploads in demo mode are therefore refused unless
  `FILES_IN_DEMO=true`, which is set on dev only so that the client can be tried there; the demo
  then has a small quota of its own (about 100 MB) and keeps files for about a day.

## 7. What can fill the disk

| # | Source | Risk | Control |
| :--- | :--- | :--- | :--- |
| 1 | Uploads | the main growth | caps (section 3), quota (section 6), retention |
| 2 | Orphans: a blob without a row after a crash | space leaks silently | files are attached at once; the weekly comparison |
| 3 | Temporary upload files | left behind after crashes | no multipart forms and no `/tmp`: bodies go to `files/tmp/`, cleaned hourly and at startup; read-only root filesystem with a small tmpfs (B-12) |
| 4 | Deleted content | its files stay forever | the blob is erased 14 days after the file is deleted |
| 5 | Container logs | unbounded growth | log rotation per service (B-11) |
| 6 | Container images | one more with every deploy | clean-up in `deploy.sh` (B-11) |
| 7 | The write-ahead log of PostgreSQL | up to about 1 GB per instance by default | `max_wal_size` and `temp_file_limit` (B-11) |
| 8 | Database tables | growth | retention exists: notifications 180 days, domain events 365 days, the auth clean-up |
| 9 | Backups | plain nightly archives multiply the files by the days kept | incremental snapshots without duplicates (B-3) |
| 10 | Nobody notices | the disk runs out and takes the database with it | disk alerts on the host (B-11) and the low disk guard |

## 8. What can load the server

| Operation | Worst case | Control |
| :--- | :--- | :--- |
| Receiving a body | a body far larger than any real file, or many at once | the edge limit, the raw-body upload checked before the first byte, a cap on bodies in flight (section 4, steps 2-4) |
| Decoding a photo | a large photo needs tens of MB decoded; a crafted PNG or WebP is worse | the client scales and converts; only JPEG of at most 2560 px is accepted, checked from the header; no other decoder is opened |
| Re-encoding | several photos at once | a worker thread, a semaphore of one per instance, a bounded queue |
| Checking a signed container | decompression bomb, XML entities, network calls during the check | size and entry caps, bounded reading, a hardened XML parser, verification without network calls (section 9) |
| Creating a PDF (ballots, record of voting) | heavy HTML-to-PDF tool chains | a small pure-Python PDF library with an embedded font; created once, then stored |
| Password sign-in (Argon2, 64 MB per hash, two at a time) | parallel sign-ins | the throttle exists; counted in the memory limit of the container |
| Backups | every instance dumps at the same minute | one host script, one instance after another, at low priority (B-3) |
| Any fault or leak in one instance | it affects the whole host | memory, CPU and process limits per container (B-12) |

## 9. Input for official decisions (E3 part B)

The owner's flow (2026-11-12): the board creates an official vote; the server creates two or
three PDF ballots per question (for, against, abstain) and records their hashes; an owner
downloads one, signs it with the national signing client and uploads the container; the server
verifies the signature and that the signed file is one of the issued ballots; the vote is
counted. The resident never uploads a PDF of their own.

What storage adds to that design (decisions belong to the planning session of part B):

- **Keep the signed container.** The counter in the database is only our claim; the signature
  is the proof when a decision is challenged. The cost is at most about 60 MB per year for an
  association of 60 apartments, so space is no reason to delete it early. How long the law
  requires it is a question for that session; the retention follows that answer.
- **A signed container is personal data.** The signer's certificate carries the full name and
  the national personal code, which the platform stores nowhere else in plain text
  (docs/SCHEMA.md keeps only a keyed hash). This needs an explicit owner decision, like the
  exceptions for E8 and E10 in AGENTS.md. Proposed rules: only the signer and the board (for a
  challenge) may download a container, never other residents; the verifier never writes the
  certificate subject to logs or spans; the retention is the legal period and not longer;
  backups are encrypted before they leave the host (B-3). Encrypting the containers at rest
  with a key of the instance is an option to weigh.
- **Store the ballots, never create them again.** Another version of the PDF library would
  produce other bytes and the hash would no longer match. A ballot names the association, the
  vote, the question, the choice and the deadline, so its hash is unique to the vote and a
  signature cannot be reused in another one.
- **One container per meeting.** An owner puts one ballot per question into a single container
  and signs once: one PIN entry instead of one per question, and several times less storage.
- **Checks:** the structure of the container; every file in it equals an issued hash, at most
  one choice per question, nothing else inside; the signature, which must be of the long-term
  level (anything lower is refused); the signer's personal code against the voter's
  `subject_hash` (or the proxy's); the signing time, taken from the trusted timestamp and never
  from what the signer claims, inside the voting window. A container is accepted only in the
  voter's own session.
- **How to verify is open.** Our own verification in the country plugin needs no network call
  (a long-term signature carries the revocation response and the timestamp) and costs
  milliseconds, but it is security-critical code (signature wrapping, references and
  transforms, the allowed algorithms), and the trust anchors (the certificates of the
  authorities, of the revocation responders and of the timestamp services) must be shipped and
  kept up to date. The alternative is the state validation service: a Java service that needs
  hundreds of MB of memory; if it is required, one per host, never one per instance. Both fit
  the resource budget; the choice is about risk, not about load.
- **Proxies:** E3 verifies a signed proxy document "the same way". To keep the rule of section
  1, the proxy form is also issued by the server (the same hash rule) or uploaded by the board;
  open for part B.
- **Changing a vote before the deadline:** keep the last valid container (ordered by the
  trusted signing time) and a log of the replaced ones; limit the number of attempts per voter.

## 10. Sizing, bottom up

An association of 60 apartments after about three years:

| Stream | Assumption | Size |
| :--- | :--- | :--- |
| Photos of issues | 30-60 reports a year, 1.5 photos each, 0.33 MB, kept about 2 years | 0.03-0.06 GB (0.2 GB with a threefold margin) |
| Photos of meters | 60 apartments, 4 meters, 12 months, 0.15 MB, kept 13 months, **everyone** uses photos | 0.45 GB (0.15-0.25 GB is more likely) |
| Documents | 20-50 a year, 1-3 MB, they accumulate | +0.05-0.15 GB a year |
| Official votes | 60 apartments, about 60 KB, 8 questions, 2 meetings a year | up to 0.06 GB a year |
| Maintenance log | 20-40 attachments, 0.5 MB | 0.02 GB a year |
| **Files in total** | the first year about 0.6 GB; after three years | **1-1.5 GB** |
| Database | data, indexes and the write-ahead log (capped) | 0.2-0.5 GB |
| Delayed deletion, local database dumps, logs | | 0.2-0.3 GB |
| **The instance in total** | typical / with a full 2 GB quota | **1.5-2 GB / about 3 GB** |

Rule of thumb: about 10 MB per apartment for the photos, which level off because they expire,
plus 0.1-0.2 GB a year for the archive (documents, votes, the maintenance log), which never
expires; together **15-25 MB per apartment** after three years. A quota of 2 GB is therefore
reached after about six to eight years, and the operator then raises it or the board removes
old documents.

The worst case the report limits alone allow is about 65 GB a year per association (60
apartments x 9 photos a day x 0.33 MB x 365 days), which is why a quota and a byte rate are
needed on top of them.

Capacity of the current host (6 vCPU, 12 GB of memory, 193 GB disk with 157 GB free on
2026-11-12; an idle instance uses 80-100 MB for the backend and 45-60 MB for PostgreSQL):

- The platform itself (images after the clean-up of B-11, logs, the edge proxy): about 5 GB.
- Disk: 157 GB free, minus 40 GB (20% of the disk, kept free for the other services of the
  host), minus 5 GB, leaves 112 GB: **about 37 instances with full quotas, about 55-70 at
  typical use.**
- Memory: about 200 MB working set per instance, 10 GB available: **about 40-50 instances.**
- At typical use memory is the limit (40-50 instances against 55-70 on disk); if every
  association filled its quota, the disk would be (about 37).
- **Allocation:** a quota of 2 GB per association and a starting budget of 40 GB for the
  platform (about ten associations with a reserve), alerts at 70% and 85% of the budget, and the
  budget grows as associations join.
- The smallest host of docs/VISION.md (1 vCPU, 1 GB of memory; a disk of 20-25 GB assumed) holds
  2-3 associations; memory is the limit there too.

These numbers describe a host with one instance per association. The deployment scripts know
only the two environments `dev` and `prod` today; running many instances needs provisioning
that no backlog entry covers yet (docs/BACKLOG.md B-8, the installer, is the nearest; the
managed cloud is in the roadmap).

## 11. Rejected alternatives

- **Files in PostgreSQL** (`bytea`): one backup file, but every dump copies all files again and
  large values go through memory.
- **An object storage server on the host:** one more service and a few hundred MB of memory per
  host for no gain at this size.
- **A job queue for photos:** not needed once the client scales the photo (principle 4).
- **Signed links for images:** see section 5.
- **Antivirus:** see section 3.
- **A hard wall on disk per instance** (a separate filesystem or project quotas): not now; an
  option for a managed cloud with third-party customers (B-12).

## 12. Tasks

| Task | What | Done when |
| :--- | :--- | :--- |
| F0 | Limits at the edge: the request body limit with per-route exceptions, timeouts for reading a body; resource limits per container (B-12); disk hygiene (B-11); host configuration as code (section 1a) | the backend never receives more of a body than the edge limit, and a slow body times out; a runaway instance is stopped by its own limits; a new VPS is set up from the repository alone |
| F1 | Core `FileStore`: `core_files`, the local disk implementation, the photo pipeline, the janitor loop, quotas, the low disk guard, the refusal in demo mode; the contract | a module stores, serves and deletes a file through the port; caps, quota and retention are enforced; crash points leave no row without a blob; memory of decoding measured for baseline and progressive files; tests |
| F2 | Photos of issue reports (E9 I4, [#103](https://github.com/Chemoday/apartment-association-platform/issues/103)); frontend handoff with the client-side scaling | up to 3 photos per report, re-encoded, without metadata; visible to whoever sees the issue; another building gets 404; tests |
| F3 | Documents of the board (a small module of its own) | the board uploads, lists and deletes PDF documents; residents download them as attachments; tests |
| F4 | Usage for the board and the quota notifications | the board sees used space by category; it is notified at 80% and 95%; texts in en, ru, et; tests |

Photos of meters come with E6, signed containers with E3 part B, attachments of the maintenance
log with E10 part B; each uses the store of F1. Backups of the files are part of B-3 and should
exist before the first real association stores files.

## 13. Open

- **For the owner:** signed containers as personal data and who may download them (section 9).
- The exact numbers: caps, the default quota and the retention periods, after measuring real
  photos in F1.
- WebP or JPEG for stored photos (WebP is about a quarter smaller; JPEG is more universal when a
  photo is downloaded and forwarded).
- Whether the chairman may change the retention periods, and within which bounds.
- A row without a blob after a restore from backups: the file is shown as unavailable and
  reported, never a server error.
- An S3 implementation of the store and a hard disk wall per instance for a managed cloud.
- Images in forum posts and in the threads between the board and an apartment.
- An export of everything an association has (database and files) when it leaves the platform:
  created by the operator on request, not a self-service download (a multi-GB archive is itself
  a heavy operation).

## Depends on

- The limits of task F0 and B-12 before the first upload route.
- B-3 (backups that include the files) and B-4 (the instance marker) before real use.
- E1 for the quota notifications; building settings (E9 I0) for the retention settings.
- Many instances on one host: provisioning that is not designed yet (section 10).
