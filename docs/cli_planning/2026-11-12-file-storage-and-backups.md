# 2026-11-12: File storage, resource limits and backups (epic E11)

A record of a planning session with the coding agent (Claude Code CLI). The owner works mainly
on the frontend at the moment; this session prepares the next hard backend feature and produces
documentation only.

## 1. Where we were
- Photos of issue reports (E9 task I4), photos of meters (E6), documents of the board and
  official decisions (E3 part B) all wait for a shared file storage; it is one of the open
  risks before the large epics.
- The owner's constraint: several instances (one per association) share one VPS, so disk space
  and heavy operations must be thought through before any upload exists. Examples the owner
  gave: a resident attaches a very large photo to a report (who processes it, and how?), and
  owners upload signed containers for an official vote.
- There are no backups at all (docs/BACKLOG.md B-3).

## 2. What was measured on the host (read-only, 2026-11-12)
- 6 vCPU, 12 GB of memory; a 193 GB disk with 157 GB free.
- An idle instance: 80-100 MB for the backend, 45-60 MB for PostgreSQL; a database directory
  of 50-66 MB.
- Container logs are not rotated (one file had reached 101 MB in two weeks).
- 42 images of the project (354-390 MB each, about 4.6 GB reclaimable): the clean-up in
  `deploy/deploy.sh` removes only untagged images, and every image is tagged with its commit.
- The system journal holds 3.9 GB.

## 3. Decisions of the owner
- **Backups:** the owner had no destination in mind and asked for advice. The advice is recorded
  in B-3 (below, section 5); nothing is set up yet.
- **Sizing:** from the bottom up ("how much space can really be needed"), not from the size of
  the disk. The disk can be extended a little; more associations per VPS is better.
- **Documents:** residents do not need to upload a PDF of their own. For an official vote the
  owner sees this flow: the chairman or the board creates the vote with a title and a
  description; the server creates two or three PDF ballots (for, against, abstain) and
  remembers the hash of each; an owner downloads one, signs it and uploads the signed
  container; the server checks that the signature is valid and that the signed file is one of
  the ballots of this vote; the voter is counted for that choice. The owner was not sure
  whether the signed container must be kept for long.
- **Result of the session:** documentation and backlog entries only.

## 4. The design (docs/epics/E11_FILE_STORAGE.md)
- Bytes from a resident are never stored or served back unchanged: photos are re-encoded,
  documents come from the board only, a signed container may hold only issued ballots.
- The client scales a photo down before sending it; the server re-encodes it inside the request
  (about 0.2 s). Uploads are raw request bodies, so the session, the rate and the quota are
  checked before the first byte is read.
- A `FileStore` port in core with a local-disk implementation, a `core_files` table, routes owned
  by the modules, delayed deletion (14 days) and a janitor loop.
- A quota per association (default 0.5 GB + 25 MB per apartment) with a reserve that photos
  cannot use, and a guard that refuses uploads when the host is nearly full.
- Sizing: an association of 60 apartments needs 1-1.5 GB of files after three years and about
  3 GB in total with a full quota. On the current host that is about 40-50 instances by memory
  and about 37 by disk if every quota were full.
- The agent's answer on signed containers: keep them. They are the only proof of a vote, and
  they cost at most about 60 MB a year per association. How long, and how to treat them as
  personal data (the certificate carries the name and the personal code), is for the planning
  session of E3 part B; section 9 of the epic page has the input.
- Proposed by the agent and still to be confirmed by the owner: uploads are refused in demo
  mode, where callers are not signed in.

## 5. Advice on backups (docs/BACKLOG.md B-3)
- Per instance: the database dump, the files and the secrets of the instance.
- One tool that encrypts on the client, removes duplicates and compresses; run by a script on
  the host, one instance after another; every 6 hours the database and then the files.
- A copy outside the VPS, in S3-compatible storage in the EU, at a provider other than the one
  of the VPS; with pay-per-use pricing this is expected to cost less than a few euros a month
  even for 30 associations. The key on the VPS cannot destroy what is already stored.
- A monthly automated restore check, and an alert when the last backup is too old.

## 6. Considered and rejected
- Files in the database; an object storage server on the host; a job queue for photos; signed
  links for images; antivirus; a hard disk wall per instance for now. Reasons: section 11 of the
  epic page.

## 7. New backlog entries
- docs/BACKLOG.md: B-3 extended (backups cover the files; the advice above), B-4 (the marker
  also guards the files directory), **B-11** disk hygiene on the host, **B-12** resource limits
  per instance.
- docs/epics/E3_GOVERNANCE_VOTING.md, section 4: the owner's flow and the input from storage.
- docs/epics/E9_ISSUE_TRACKER.md: task I4 now points to E11.

## 8. Order of work (when the owner schedules it)
F0 limits at the edge and per container -> F1 the store -> F2 photos of issue reports -> F3
documents of the board -> F4 usage and quota notifications. B-11 is independent and small; B-3
should be done before the first real association stores files.

## 9. Follow-up on 2026-11-13: towards the implementation
- The design was merged (#120) and scheduled: epic #125, tasks F0 #121, F1 #122, F2 #103, F3
  #123, F4 #124; three pull requests (F0; F1 with F2; F3 with F4).
- **What the client takes over.** The owner asked which work belongs to the client. The rule:
  the client takes what saves traffic, server CPU or helps the person (scaling, converting,
  checks before sending, a preview, the progress, retrying one photo); everything that protects
  the server stays there and is checked again, because a request can bypass any client.
- **Decompression bombs.** The owner was worried about PNG bombs and the memory of decoding. The
  size is read from the header before decoding and the pixel limit bounds the memory, but a PNG
  cannot be decoded already reduced. The owner noted that a future native phone app can scale
  photos just as well as a browser. Decision: the server accepts only JPEG of at most 2560 px,
  every client scales and converts, and the server opens no other decoder.
- **Demo mode:** uploads only with `FILES_IN_DEMO=true` on dev (a small demo quota, a short
  retention); prod refuses them.
- **Retries:** an `Idempotency-Key` on photo uploads.
- **Instance marker:** waits for B-4.
- **Host configuration as code.** The owner asked that every configuration applied to the VPS be
  kept in the repository, with the scripts that apply it and a log of what was applied, so that
  a new VPS can be set up without anybody's memory. It becomes a rule in AGENTS.md and is
  introduced by task F0.
