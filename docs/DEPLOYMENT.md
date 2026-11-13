# Deployment, CD & Rollback

The app runs on a single self-hosted VPS (`164.68.121.228`, Ubuntu 24.04, Docker) next to
unrelated services. HTTPS uses free `sslip.io` hostnames, which resolve to the IP embedded in the
name, so no domain had to be bought. Caddy obtains Let's Encrypt certificates for them on its own.

| Environment | URL | Deployed by |
| :--- | :--- | :--- |
| **dev** | https://dev.164-68-121-228.sslip.io:8443 | Automatically, on every push to `main` that passes CI |
| **prod** | https://164-68-121-228.sslip.io:8443 | Manually, by promoting a commit that already ran on dev |

Work goes into `main` through pull requests (AGENTS.md, section 4); a pull request can be tried
on dev before merging with the label `deploy-dev`.

> **Port 8443 is temporary.** Port `443` on the VPS is still used by an Outline VPN server. Once
> it moves, the switch to `443` is a change of `HTTPS_PORT` in `deploy/hosts/vps1.env`, a re-run
> of `bootstrap.sh` and an update of the `DEV_URL` / `PROD_URL` repository variables. Certificates are issued over port `80`
> (HTTP-01), so HTTPS works on either port.

## Topology

```text
                 Internet
                    │  :80 (ACME + redirect)   :8443 → later :443 (HTTPS)
          ┌─────────▼──────────┐
          │ aap-edge: Caddy    │  the only project container that binds host ports
          └───┬────────────┬───┘
   docker net │ aap-edge   │
   ┌──────────▼───┐   ┌────▼─────────┐
   │ aap-prod     │   │ aap-dev      │   one Compose project per environment
   │  backend ────┤   │  backend ────┤   (alias aap-<env>-backend on aap-edge)
   │  postgres    │   │  postgres    │   own internal network + volume, never published
   └──────────────┘   └──────────────┘
```

Server layout (`/opt/aap`):

| Path | Owner | Contents |
| :--- | :--- | :--- |
| `aap.conf`, `bin/ssh-gate`, `bin/aap-disk-check`, `edge/`, `host-history` | root | Installed by `bootstrap.sh`; the CI key cannot change them. `host-history` lists every run of `bootstrap.sh` |
| `dev/`, `prod/` | deploy | `.env` (secrets, mode 600), `current_sha`, `previous_sha`, `history` |
| `dev/files/`, `prod/files/` | uid 1000 (the backend) | Uploaded files (epic E11), mode 700. On a host whose first account got uid 1000 (often `deploy` itself) that account owns them too; `/opt/aap/<env>` is 750 and `deploy` is in the `docker` group anyway |
| `releases/<sha>/deploy/` | deploy | The `deploy/` directory of the current and the previous release of each environment; older ones are removed by `deploy/cleanup.sh` |

Outside `/opt/aap`: the systemd units `aap-disk-check.service` and `.timer` in
`/etc/systemd/system`, and only when the host file asks for them, a swap file and
`/etc/systemd/journald.conf.d/aap.conf`.

## Pipeline

```text
pull request ──► CI: ruff + pytest (PostgreSQL service), frontend lint + test + build ──► image ghcr.io/chemoday/apartment-association-platform:<head sha>
   label deploy-dev ──► Deploy (dev, <head sha>) ──► smoke test via the public URL
push to main ──► CI: ruff + pytest ──► image :<sha> and :main ──► Deploy (dev) ──► smoke test via the public URL
manual       ──► Deploy (prod, <sha>) ──► smoke test via the public URL
```

- **`.github/workflows/ci.yml`** runs on every pull request and every push to `main`. Images are
  built once per commit and tagged with its SHA; servers never build. The image contains the
  client: its first stage builds `frontend/` with bun (an empty `frontend/` gives an API-only
  image).
- **Pull request preview.** A same-repository pull request with the label `deploy-dev` is deployed
  to dev after CI, on every push to it. The Frontend sync pull request carries the label, so each
  frontend version shows up on dev before the merge (docs/FRONTEND_GIT_WORKFLOW.md). Dev shows
  whatever was deployed last; the next merge to `main` replaces a preview. Do not preview a pull
  request that changes database migrations.
- **`.github/workflows/deploy.yml`** is reused by CI for dev and is the manual entry point for prod
  and rollbacks: *Actions → Deploy → Run workflow*, pick `prod`, paste the full commit SHA.
  The `production` environment only accepts runs from `main`.
- The job connects as `deploy@164.68.121.228`. That key is pinned to a forced command
  (`deploy/ssh-gate.sh`), so all it can run is `deploy <dev|prod> <sha>` or `status`. It cannot get
  a shell or set up port forwarding.
- The gate accepts a commit for **dev** when it is on `main` or is the head of an open same-repo
  pull request. It accepts a commit for **prod** only when it is on `main` *and* is listed in dev's
  history. It then downloads `deploy/` of that exact commit and runs its `deploy.sh`, so the config
  and the image always come from the same SHA.
- The short-lived `GITHUB_TOKEN` used to pull the image goes over stdin into a throwaway Docker
  config and is never written to the server.

## Demo data

Both environments run with `DEMO_MODE_ENABLED=true` and `SEED_DEMO_DATA=true`
(`deploy/docker-compose.deploy.yml`). At startup, after the migrations, `entrypoint.sh` runs
`python -m src.core.seed`: it seeds the demo building into an **empty** database once and does
nothing on every later start, or when the database already has a building. To start the demo
over on dev, the dev database has to be emptied; prod is never reset by a deploy.

## Resource limits and disk hygiene

Several instances and unrelated services share the host, so nothing may grow without a bound
(docs/BACKLOG.md B-11, B-12; docs/epics/E11_FILE_STORAGE.md, sections 7-8).

| What | Where | Limit |
| :--- | :--- | :--- |
| Request bodies | `deploy/edge/Caddyfile` | 1 MB (decimal) for every route; 4 MB for `POST /api/v1/issues/{id}/photos`; the backend never receives more than the limit, and the client gets a bare 413 (docs/API.md, section 0). Refusing a large `Content-Length` before reading is the upload route's own job (E11) |
| Slow clients | `deploy/edge/Caddyfile` | 10 s for the headers, 3 min for a body, 2 min idle |
| Backend | `deploy/docker-compose.deploy.yml` | 512 MB of memory, 2 CPUs, 200 processes; read-only root filesystem with a 64 MB `/tmp` |
| Database | `deploy/docker-compose.deploy.yml` | 384 MB of memory, 200 processes; `max_wal_size=256MB`, `temp_file_limit=512MB` |
| Edge proxy | `deploy/edge/docker-compose.yml` | 256 MB of memory, 200 processes |
| Container logs | both compose files | 3 files of 10 MB per container |
| Images and releases | `deploy/cleanup.sh`, run by `deploy.sh` after a healthy deploy | only the current and the previous release of each environment are kept; images of other services are never touched |
| Disk | `aap-disk-check.timer` (hourly) | a warning in the journal (tag `aap-disk-check`) and a failed unit at 70% and 85% of `DISK_BUDGET_GB`, or below 20% free on the host; image sizes are summed per image, so the estimate errs on the high side |

- The limits of the app containers arrive with a deploy (they are part of the release); the edge
  limits, the disk check and the host-wide settings arrive with `bootstrap.sh`.
- A deploy holds a shared lock on `/opt/aap/releases/.deploy.lock` while it pulls and starts its
  image; the clean-up runs only when it gets the exclusive lock at once. It also keeps every
  release whose directory changed in the last two hours (`ssh-gate.sh` downloads or touches it
  before the deploy starts), so neither the image nor the directory of a deploy of the other
  environment, or of a rollback to an old release, is removed while it runs.
- Images of an earlier repository name are removed only when the host file lists them in
  `REMOVE_IMAGES_OF` (a rollback to a commit before the rename needs them).
- Where a disk warning goes beyond the journal is open (B-11). Check it with
  `systemctl --failed` or `journalctl -t aap-disk-check`.

## Uploaded files

Files of epic E11 live on the host, never in the image or the database (docs/ARCHITECTURE.md
section 10): `/opt/aap/<env>/files` (created by `bootstrap.sh`, owned by uid 1000, mode 700) is
mounted at `/data/files` in the backend (`FILES_DIR`). Settings, all in the environment:

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `FILES_DIR` | `var/files` (`/data/files` in both compose files) | Root of `blobs/` and `tmp/` |
| `FILES_QUOTA_MB` | 2048 | Quota per association (E11 section 6: about 0.5 GB + 25 MB per apartment) |
| `FILES_USER_MB_PER_DAY` | 20 | Stored bytes per user and day |
| `FILES_MIN_FREE_MB` | 5120 | Uploads stop below this free space on the disk of `FILES_DIR` |
| `FILES_IN_DEMO` | `false` | Uploads in demo mode; only for `ENVIRONMENT` local, dev or test. `deploy.sh` sets it to `true` for dev and `false` for prod |
| `FILES_DEMO_QUOTA_MB`, `FILES_DEMO_RETENTION_HOURS` | 100, 24 | The quota and the retention while in demo mode |
| `FILES_JANITOR_ENABLED` | `true` | The hourly clean-up loop |

The files are not in any backup yet (docs/BACKLOG.md B-3): that must change before a real
association stores files.

## Rollback

- **Automatic.** `deploy.sh` starts the new release with `docker compose up --wait`. The backend
  healthcheck calls `/health/ready`, which also checks the database. If the release is not healthy
  within 180 s, the script prints the backend logs, redeploys the previous SHA of that environment
  and fails the workflow run.
- **Manual.** Run *Deploy* with an older SHA. The SHAs that ran are listed on the repository's
  *Deployments* page, or with `ssh deploy@164.68.121.228 status`.
- **Schema.** Migrations must stay backward compatible (expand/contract). At startup,
  `python -m src.core.migrations` upgrades the database. When the database is already *newer* than
  the image (a rollback), it logs `migrations_skipped_schema_ahead` and skips the upgrade instead
  of crashing.

## Host configuration as code

A VPS is set up and changed only from the repository, so that a new one can be built without
anybody's memory (owner rule, 2026-11-13; AGENTS.md, section 3).

- **Nothing is changed on a VPS by hand.** A change is a commit in `deploy/` plus the script that
  applies it; the scripts are idempotent, so a re-run is always safe. Releases of the app arrive
  by the deploy pipeline; everything outside a release (the edge proxy, systemd units, host-wide
  settings, the directory layout) is applied by `bootstrap.sh` as root.
- **Secrets never enter the repository.** `bootstrap.sh` generates them on the host into
  `/opt/aap/<env>/.env`; this document lists their names only. The owner keeps a copy in a
  password manager (docs/BACKLOG.md B-3).
- **One file per host, without secrets:** `deploy/hosts/<name>.env` (`PUBLIC_IP`, `HTTPS_PORT`,
  `DISK_BUDGET_GB` and the host-wide flags). The current VPS is `vps1`.
- **Host-wide settings are opt-in.** Swap (`HOST_SWAP_SIZE`) and the size of the system journal
  (`HOST_JOURNAL_MAX`) affect every service on the host, so they are applied only when the host
  file sets them. Containers and files of the project are always configured.
- **A log of what was applied:** `deploy/HOST_CHANGELOG.md` in the repository (date, host,
  commit, action, who, result) and `/opt/aap/host-history` on the host (every run of
  `bootstrap.sh`).
- **A drift check:** `deploy/host/check.sh --host hosts/<name>.env` (as root, read-only) compares
  the host with the repository: the installed edge files, scripts and units, the HTTPS port, the
  disk budget, the secrets being present, the files directories, the limits and log rotation of
  the running containers, the host-wide settings. Every `DIFF` is fixed by re-running
  `bootstrap.sh`.

### Applying a change to a host

As root on the VPS, from the `deploy/` directory of a commit on `main`:

```bash
sha=<commit on main>
rm -rf /root/aap-deploy && mkdir -p /root/aap-deploy
curl -fsSL "https://codeload.github.com/Chemoday/apartment-association-platform/tar.gz/$sha" \
  | tar -xz -C /root/aap-deploy --strip-components=1 --wildcards '*/deploy/*'
cd /root/aap-deploy/deploy
bash bootstrap.sh --host hosts/vps1.env --source-sha "$sha"
bash host/check.sh --host hosts/vps1.env
```

`bootstrap.sh` validates the new Caddyfile before it replaces the running one. When the edge
compose file changed, the edge container is recreated: dev and prod are unreachable for a few
seconds. Then add a line to `deploy/HOST_CHANGELOG.md`.

### A new VPS from scratch

1. A VPS with Ubuntu 24.04 (systemd, `flock` from util-linux), Docker with the Compose plugin,
   `curl`, `python3`, `openssl`.
2. A host file `deploy/hosts/<name>.env` (copy `vps1.env`), committed to `main`.
3. A new CI key pair: the private half goes into the repository secret `DEPLOY_SSH_KEY`, the
   public half to the host as `ci_deploy.pub`.
4. As root, the commands of "Applying a change to a host" with
   `DEPLOY_PUBKEY_FILE=/root/ci_deploy.pub` in front of `bash bootstrap.sh`. This creates the
   `deploy` user and the `/opt/aap` layout, generates the database password and the login
   secrets (`JWT_SECRET_KEY`, `AUTH_HASH_SECRET`) per environment, creates the files directories
   and the `aap-edge` network, starts Caddy, installs the disk check and applies the host-wide
   settings the host file asks for. Re-running it is safe: existing secrets, deploy state and
   certificates are kept, missing secrets are added, and the CI key is kept unless a new one is
   passed.
5. GitHub repository settings (below), with `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` of the new host.
6. Deploy a commit to dev, then promote it to prod (Pipeline). Restoring the data of an old host
   needs the backups of docs/BACKLOG.md B-3, which do not exist yet.
7. A line in `deploy/HOST_CHANGELOG.md`.

### GitHub repository settings

- Secrets: `DEPLOY_SSH_KEY` (private half of the CI key) and `DEPLOY_KNOWN_HOSTS` (the VPS
  ed25519 host key, verified against `/etc/ssh/ssh_host_ed25519_key.pub`).
- Variables: `DEPLOY_HOST`, `DEV_URL`, `PROD_URL`, `FRONTEND_REPOSITORY` (frontend sync).
- Secret `FRONTEND_SYNC_TOKEN`: a token that reads the frontend repository and writes this one
  (pushes and pull requests of the Frontend sync workflow must start CI).
- Environments: `dev`, and `production` restricted to the `main` branch.

## Notes

- `DEMO_MODE_ENABLED=true` in both environments, so reviewers can switch roles with
  `X-Demo-User-Id`. The deployed databases contain seeded demo data only.
- **E-mail:** the backend is only an SMTP client of an external provider; no mail server runs in
  the image or on the VPS, and environments share nothing. When e-mail goes live (after a real
  login, docs/BACKLOG.md B-7), each environment gets its own `SMTP_*` values, `SMTP_FROM`,
  `PUBLIC_BASE_URL`, `NOTIFICATIONS_HASH_SECRET` (at least 32 bytes; it signs the unsubscribe
  links since N8, and the backend refuses to start without it) and `common.email_smtp` in
  `ENABLED_PLUGINS` in its `.env` (docs/epics/E1_NOTIFICATIONS.md 6.1). The provider must sign
  the mail with DKIM, or large mail services ignore the one-click unsubscribe headers.
- **Login secrets (epic E7):** the backend refuses to start without `JWT_SECRET_KEY` and
  `AUTH_HASH_SECRET` (at least 32 bytes each), and `docker-compose.deploy.yml` refuses to start
  without them in `/opt/aap/<env>/.env`. A deploy without them fails its health check and rolls
  back. `bootstrap.sh` generates them, and a re-run adds any that are missing (section "Applying
  a change to a host"); they are never written by hand.
  - Never rotate `AUTH_HASH_SECRET` casually: it signs everyone out and voids all open links and
    invitations.
- Troubleshooting (as root on the VPS):
  `docker compose -p aap-dev logs -f backend`, `cat /opt/aap/dev/history`,
  `docker logs aap-edge-caddy-1`, `journalctl -t aap-disk-check`,
  `bash host/check.sh --host hosts/vps1.env` from a copy of `deploy/`.
