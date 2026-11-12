#!/usr/bin/env bash
# Read-only drift check: does this VPS match what the repository describes?
#
#   bash host/check.sh --host hosts/<name>.env
#
# Run as root from a copy of the deploy/ directory of the commit the host should run (the same
# copy bootstrap.sh was run from). Prints one line per item, OK or DIFF, and exits 1 on any DIFF.
# It changes nothing; a DIFF is fixed by re-running bootstrap.sh (docs/DEPLOYMENT.md).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_FILE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host) HOST_FILE=${2:?--host needs a file}; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[[ -n "$HOST_FILE" ]] || { echo "usage: check.sh --host hosts/<name>.env" >&2; exit 2; }
# shellcheck source=/dev/null
source "$HOST_FILE"
: "${HTTPS_PORT:?HTTPS_PORT is required in the host file}"
DISK_BUDGET_GB=${DISK_BUDGET_GB:-40}
AAP_ROOT=/opt/aap

diffs=0
ok() { printf 'OK    %s\n' "$*"; }
diff_() { printf 'DIFF  %s\n' "$*"; diffs=$((diffs + 1)); }
same_file() {  # <repo file> <installed file> <label>
    if cmp -s "$1" "$2"; then ok "$3"; else diff_ "$3 differs from the repository ($2)"; fi
}

same_file "$HERE/edge/Caddyfile" "$AAP_ROOT/edge/caddy/Caddyfile" "edge Caddyfile"
same_file "$HERE/edge/docker-compose.yml" "$AAP_ROOT/edge/docker-compose.yml" "edge compose file"
same_file "$HERE/ssh-gate.sh" "$AAP_ROOT/bin/ssh-gate" "ssh-gate"
same_file "$HERE/host/aap-disk-check.sh" "$AAP_ROOT/bin/aap-disk-check" "disk check script"
same_file "$HERE/host/aap-disk-check.service" /etc/systemd/system/aap-disk-check.service "disk check service"
same_file "$HERE/host/aap-disk-check.timer" /etc/systemd/system/aap-disk-check.timer "disk check timer"

if grep -qx "HTTPS_PORT=$HTTPS_PORT" "$AAP_ROOT/edge/.env" 2> /dev/null; then
    ok "edge HTTPS port $HTTPS_PORT"
else
    diff_ "edge HTTPS port is not $HTTPS_PORT ($AAP_ROOT/edge/.env)"
fi
if grep -qx "DISK_BUDGET_GB=$DISK_BUDGET_GB" "$AAP_ROOT/aap.conf" 2> /dev/null; then
    ok "disk budget $DISK_BUDGET_GB GB"
else
    diff_ "disk budget is not $DISK_BUDGET_GB GB ($AAP_ROOT/aap.conf)"
fi
conf_image=$(sed -n 's/^IMAGE=//p' "$AAP_ROOT/aap.conf" 2> /dev/null)
conf_repo=$(sed -n 's/^REPO=//p' "$AAP_ROOT/aap.conf" 2> /dev/null)
if [[ -n "$conf_repo" && "$conf_image" == "ghcr.io/${conf_repo,,}" ]] \
    && grep -qx "REPO=${REPO:-Chemoday/apartment-association-platform}" "$AAP_ROOT/aap.conf"; then
    ok "repository and image in aap.conf"
else
    diff_ "REPO or IMAGE in $AAP_ROOT/aap.conf do not match the repository"
fi
if grep -q "^restrict,command=\"$AAP_ROOT/bin/ssh-gate\" " /home/deploy/.ssh/authorized_keys 2> /dev/null \
    && [[ "$(grep -c . /home/deploy/.ssh/authorized_keys)" -eq 1 ]]; then
    ok "CI key pinned to ssh-gate (one key)"
else
    diff_ "/home/deploy/.ssh/authorized_keys is not exactly one key pinned to ssh-gate"
fi
if systemctl is-enabled --quiet aap-disk-check.timer 2> /dev/null \
    && systemctl is-active --quiet aap-disk-check.timer; then
    ok "disk check timer enabled and active"
else
    diff_ "disk check timer is not enabled and active"
fi

for env_name in dev prod; do
    for secret in POSTGRES_PASSWORD JWT_SECRET_KEY AUTH_HASH_SECRET; do
        grep -q "^$secret=." "$AAP_ROOT/$env_name/.env" 2> /dev/null \
            || diff_ "$env_name: $secret missing in .env"
    done
    if [[ "$(stat -c '%u %a' "$AAP_ROOT/$env_name/files" 2> /dev/null)" == "1000 700" ]]; then
        ok "$env_name: files directory"
    else
        diff_ "$env_name: files directory missing, not owned by uid 1000 or not mode 700"
    fi
    # Limits and log rotation of the running containers (deploy/docker-compose.deploy.yml; they
    # arrive with the first deploy of a release that has them).
    for service in backend db; do
        container=$(docker ps --quiet --filter "label=com.docker.compose.project=aap-$env_name" \
            --filter "label=com.docker.compose.service=$service" | head -1)
        if [[ -z "$container" ]]; then
            diff_ "$env_name/$service: not running"
            continue
        fi
        read -r memory log_size < <(docker inspect --format \
            '{{.HostConfig.Memory}} {{index .HostConfig.LogConfig.Config "max-size"}}' "$container")
        if [[ "$memory" != 0 && "$log_size" != "<no value>" && -n "$log_size" ]]; then
            ok "$env_name/$service: memory limit and log rotation"
        else
            diff_ "$env_name/$service: no memory limit or no log rotation (deploy a newer release)"
        fi
    done
done

if [[ -n "${HOST_JOURNAL_MAX:-}" ]]; then
    if grep -qx "SystemMaxUse=$HOST_JOURNAL_MAX" /etc/systemd/journald.conf.d/aap.conf 2> /dev/null; then
        ok "host: journal limited to $HOST_JOURNAL_MAX"
    else
        diff_ "host: journal limit $HOST_JOURNAL_MAX not applied"
    fi
elif [[ -f /etc/systemd/journald.conf.d/aap.conf ]]; then
    diff_ "host: a journal limit is set although the host file has none"
fi
if [[ -n "${HOST_SWAP_SIZE:-}" ]]; then
    if swapon --show --noheadings | grep -q .; then ok "host: swap present"; else diff_ "host: no swap"; fi
fi

echo "---"
image=$(sed -n 's/^IMAGE=//p' "$AAP_ROOT/aap.conf" 2> /dev/null)
echo "images of the project: $(docker image ls --quiet "${image:-none}" | sort -u | wc -l)"
echo "release directories: $(find "$AAP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | wc -l)"
"$AAP_ROOT/bin/aap-disk-check" 2> /dev/null || true
echo "last bootstrap runs:"
tail -3 "$AAP_ROOT/host-history" 2> /dev/null || echo "  (none recorded)"

(( diffs == 0 )) || { echo "$diffs difference(s)"; exit 1; }
