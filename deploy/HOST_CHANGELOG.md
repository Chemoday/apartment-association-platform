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

Reconstructed from the project records on 2026-11-13; earlier re-runs of `bootstrap.sh`, if any,
are not known.

Known leftovers on vps1: images under the old repository name
(`ghcr.io/chemoday/ai-dev-zoomcamp-week-final`) are not removed by `deploy/cleanup.sh`, which
handles only the current `IMAGE`; they are needed only to roll back to a commit before the rename.
