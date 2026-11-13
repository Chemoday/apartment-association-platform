# Host changelog

What was applied to which VPS, when and from which commit. Everything applied to a VPS comes from
the repository (`deploy/`, rule in AGENTS.md and docs/DEPLOYMENT.md "Host configuration as code");
this log says when it happened. Add a line for every run of `bootstrap.sh` and for every other
action on a host as root, in the same pull request that asks for it or right after it is done.
Deploys of the app are not listed here: they are recorded by GitHub (Deployments) and in
`/opt/aap/<env>/history` on the host.

Never write secrets here.

| Date | Host | Source commit | Action | By | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-10-25 | vps1 | 52fe99f | First `bootstrap.sh` (`PUBLIC_IP=164.68.121.228 HTTPS_PORT=8443`), CI deploy key | owner | dev and prod running |
| 2026-11-05 | vps1 | e30a7a5 | Login secrets `JWT_SECRET_KEY`, `AUTH_HASH_SECRET` added to `/opt/aap/{dev,prod}/.env` by the one-liner of docs/DEPLOYMENT.md (by hand, before this log existed) | owner | deploys with E7 healthy |
| 2026-11-05 | vps1 | - | `/opt/aap/aap.conf`: `REPO` and `IMAGE` changed to the new repository name by hand (before this log existed; `bootstrap.sh` writes the same values) | owner | deploys pull the new image path |
| 2026-11-12 | vps1 | - | Read-only measurements for epic E11 (disk, memory, logs, images); nothing changed | agent | docs/cli_planning/2026-11-12-file-storage-and-backups.md |
| 2026-11-13 | vps1 | deafbb2 | Deploy of #126 to dev (CI): container limits and log rotation on dev; the first `deploy/cleanup.sh` removed 15 images and 39 release directories | CI | dev healthy; prod untouched |
| 2026-11-13 | vps1 | deafbb2 | `bootstrap.sh --host hosts/vps1.env --source-sha deafbb2...` as root (runbook "Applying a change to a host"), agent on the owner's instruction: new Caddyfile (body limits, timeouts), edge container recreated, `ssh-gate` reinstalled, `files/` directories, `aap-disk-check` timer | agent | `host/check.sh`: all OK except prod containers without limits (prod still runs c6e8706 until it is promoted); dev and prod `/health/ready` 200; a 2 MB body to dev gets 413 |
| 2026-11-13 | vps1 | 5fa04f2 | `bootstrap.sh --host hosts/vps1.env --source-sha 5fa04f2...` as root, agent on the owner's instruction: the Caddyfile of #129 (20 MB for `POST /api/v1/documents`), reloaded without recreating the edge container | agent | `host/check.sh`: OK except the prod containers (prod still on c6e8706); on dev a 5 MB PDF uploads (201), a 21 MB one gets 413 |

Reconstructed from the project records on 2026-11-13; earlier re-runs of `bootstrap.sh`, if any,
are not known.

Facts about vps1 (2026-11-13): uid 1000 on the host is the account of a game server, so it owns
the `files/` directories by number; it cannot reach them, because `/opt/aap/<env>` is 750 and
owned by `deploy` (uid 1001). `/opt/aap/aap.conf.bak-rename` is a backup made by hand at the
rename on 2026-11-05 and can be deleted.

Known leftovers on vps1: images under the old repository name
(`ghcr.io/chemoday/ai-dev-zoomcamp-week-final`) are not removed by `deploy/cleanup.sh`, which
handles only the current `IMAGE`. Prod still runs one of them (c6e8706, previous 06a52e3), so
they stay until prod runs a release under the new name; then `REMOVE_IMAGES_OF` in the host file
removes them.
