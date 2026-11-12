#!/usr/bin/env bash
# Idempotent VPS setup. Run as root from a copy of the deploy/ directory of a commit on main:
#
#   bash bootstrap.sh --host hosts/<name>.env [--source-sha <commit>]
#
# The host file (required) holds the parameters of that VPS without secrets (docs/DEPLOYMENT.md,
# "Host configuration as code"); a run without it could, for example, move the edge proxy onto a
# port that another service of the host uses. On the first run, also pass the public half of the
# CI key: DEPLOY_PUBKEY_FILE=./ci_deploy.pub.
#
# Creates the "deploy" user (CI key pinned to ssh-gate), /opt/aap layout, per-environment
# secrets, the shared "aap-edge" Docker network, the Caddy edge proxy and the disk check timer;
# applies the host-wide settings the host file asks for. Re-running it is safe: existing secrets,
# deploy state and certificates are kept. Every run is recorded in /opt/aap/host-history.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_FILE=""
SOURCE_SHA=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host) HOST_FILE=${2:?--host needs a file}; shift 2 ;;
        --source-sha) SOURCE_SHA=${2:?--source-sha needs a commit}; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[[ -n "$HOST_FILE" ]] || { echo "usage: bootstrap.sh --host hosts/<name>.env [--source-sha <commit>]" >&2; exit 2; }
# shellcheck source=/dev/null
source "$HOST_FILE"
: "${PUBLIC_IP:?PUBLIC_IP is required in the host file}"
: "${HTTPS_PORT:?HTTPS_PORT is required in the host file}"
DISK_BUDGET_GB=${DISK_BUDGET_GB:-40}
HOST_SWAP_SIZE=${HOST_SWAP_SIZE:-}
HOST_JOURNAL_MAX=${HOST_JOURNAL_MAX:-}
REMOVE_IMAGES_OF=${REMOVE_IMAGES_OF:-}
# The backend runs as uid 1000 in its image (Dockerfile); it owns the files directory (E11).
APP_UID=1000
REPO=${REPO:-Chemoday/apartment-association-platform}
AAP_ROOT=/opt/aap
DASHED_IP=${PUBLIC_IP//./-}
PROD_HOST="${DASHED_IP}.sslip.io"
DEV_HOST="dev.${DASHED_IP}.sslip.io"
IMAGE="ghcr.io/${REPO,,}"

log() { echo "[bootstrap] $*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
for tool in docker curl python3 openssl flock systemctl; do
    command -v "$tool" > /dev/null || { echo "missing dependency: $tool" >&2; exit 1; }
done

log "deploy user"
id deploy > /dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy

log "directory layout in $AAP_ROOT"
install -d -o root -g root -m 755 "$AAP_ROOT" "$AAP_ROOT/bin" "$AAP_ROOT/edge"
install -d -o deploy -g deploy -m 750 "$AAP_ROOT/dev" "$AAP_ROOT/prod" "$AAP_ROOT/releases"
# Uploaded files of each environment (epic E11), bind-mounted into the backend. Only the backend's
# user may read them.
for env_name in dev prod; do
    install -d -o "$APP_UID" -g "$APP_UID" -m 700 "$AAP_ROOT/$env_name/files"
done

cat > "$AAP_ROOT/aap.conf" <<EOF
AAP_ROOT=$AAP_ROOT
REPO=$REPO
IMAGE=$IMAGE
DISK_BUDGET_GB=$DISK_BUDGET_GB
EOF
chmod 644 "$AAP_ROOT/aap.conf"

install -o root -g root -m 755 "$HERE/ssh-gate.sh" "$AAP_ROOT/bin/ssh-gate"

install -d -o root -g root -m 755 /home/deploy/.ssh
if [[ -n "${DEPLOY_PUBKEY_FILE:-}" ]]; then
    log "CI deploy key (forced command, no shell, no forwarding)"
    {
        printf 'restrict,command="%s/bin/ssh-gate" ' "$AAP_ROOT"
        cat "$DEPLOY_PUBKEY_FILE"
    } > /home/deploy/.ssh/authorized_keys
    chown root:root /home/deploy/.ssh/authorized_keys
    chmod 644 /home/deploy/.ssh/authorized_keys
elif [[ -s /home/deploy/.ssh/authorized_keys ]]; then
    log "CI deploy key: kept (pass DEPLOY_PUBKEY_FILE to replace it)"
else
    echo "DEPLOY_PUBKEY_FILE is required on the first run" >&2
    exit 1
fi

for env_name in dev prod; do
    env_file="$AAP_ROOT/$env_name/.env"
    if [[ ! -f "$env_file" ]]; then
        log "generating database secret for $env_name"
        printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$env_file"
    fi
    # Login secrets (epic E7): added once, never rotated here (rotating signs everyone out).
    # A hand-edited file may lack its final newline; never glue a secret onto the last line.
    [[ -z "$(tail -c1 "$env_file")" ]] || echo >> "$env_file"
    for secret_name in JWT_SECRET_KEY AUTH_HASH_SECRET; do
        if ! grep -q "^${secret_name}=" "$env_file"; then
            log "generating $secret_name for $env_name"
            printf '%s=%s\n' "$secret_name" "$(openssl rand -hex 32)" >> "$env_file"
        fi
    done
    chown deploy:deploy "$env_file"
    chmod 600 "$env_file"
done

log "docker network aap-edge"
docker network inspect aap-edge > /dev/null 2>&1 || docker network create aap-edge > /dev/null

log "edge proxy: https://$PROD_HOST:$HTTPS_PORT (prod), https://$DEV_HOST:$HTTPS_PORT (dev)"
install -d -o root -g root -m 755 "$AAP_ROOT/edge/caddy"
# Validate the new Caddyfile before it replaces the running one: a broken edge would take down
# every environment. A change of the edge compose file recreates the container (a few seconds
# offline for dev and prod).
if ! validate_output=$(docker run --rm -v "$HERE/edge:/etc/caddy:ro" -e HTTPS_PORT="$HTTPS_PORT" \
    -e PROD_HOST="$PROD_HOST" -e DEV_HOST="$DEV_HOST" caddy:2.8.4-alpine \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    echo "$validate_output" | tail -5 >&2
    echo "edge/Caddyfile does not validate; the running edge proxy was left as it is" >&2
    exit 1
fi
install -m 644 "$HERE/edge/docker-compose.yml" "$AAP_ROOT/edge/"
install -m 644 "$HERE/edge/Caddyfile" "$AAP_ROOT/edge/caddy/Caddyfile"
rm -f "$AAP_ROOT/edge/Caddyfile"  # pre-directory-mount layout
cat > "$AAP_ROOT/edge/.env" <<EOF
HTTPS_PORT=$HTTPS_PORT
PROD_HOST=$PROD_HOST
DEV_HOST=$DEV_HOST
EOF
edge_compose() {
    docker compose -p aap-edge -f "$AAP_ROOT/edge/docker-compose.yml" \
        --env-file "$AAP_ROOT/edge/.env" "$@"
}
edge_compose up -d --remove-orphans
# A Caddyfile change does not recreate the container, so reload explicitly (Caddy may still be
# starting, hence the retries; the last error is shown if every attempt fails).
reloaded=false
for _ in $(seq 1 15); do
    if reload_output=$(edge_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1); then
        reloaded=true
        break
    fi
    sleep 1
done
$reloaded || { echo "caddy reload failed: $reload_output" >&2; exit 1; }

log "disk check (hourly systemd timer; docs/BACKLOG.md B-11)"
install -o root -g root -m 755 "$HERE/host/aap-disk-check.sh" "$AAP_ROOT/bin/aap-disk-check"
install -o root -g root -m 644 "$HERE/host/aap-disk-check.service" "$HERE/host/aap-disk-check.timer" \
    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aap-disk-check.timer > /dev/null

# Host-wide settings affect every service on the host, so they are applied only when the host
# file asks for them; an empty value leaves the host as it is.
journal_dropin=/etc/systemd/journald.conf.d/aap.conf
if [[ -n "$HOST_JOURNAL_MAX" ]]; then
    wanted=$(printf '[Journal]\nSystemMaxUse=%s' "$HOST_JOURNAL_MAX")
    if [[ "$(cat "$journal_dropin" 2> /dev/null)" != "$wanted" ]]; then
        log "host: system journal limited to $HOST_JOURNAL_MAX"
        install -d -m 755 /etc/systemd/journald.conf.d
        printf '%s\n' "$wanted" > "$journal_dropin"
        systemctl restart systemd-journald
    fi
elif [[ -f "$journal_dropin" ]]; then
    log "host: journal limit removed (HOST_JOURNAL_MAX is empty)"
    rm -f "$journal_dropin"
    systemctl restart systemd-journald
fi
if [[ -n "$HOST_SWAP_SIZE" ]]; then
    if swapon --show --noheadings | grep -q .; then
        log "host: swap already present, left as it is"
    else
        log "host: swap file /swapfile of $HOST_SWAP_SIZE"
        fallocate -l "$HOST_SWAP_SIZE" /swapfile
        chmod 600 /swapfile
        mkswap /swapfile > /dev/null
        swapon /swapfile
        grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
fi

# Images of an earlier repository name (the deploy clean-up only knows the current IMAGE).
# Opt-in, because a rollback to a commit before the rename needs them; images used by a container
# are never removed.
for old_image in $REMOVE_IMAGES_OF; do
    removed=0
    while IFS= read -r ref; do
        docker image rm "$ref" > /dev/null 2>&1 && removed=$((removed + 1))
    done < <(docker image ls "$old_image" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' || true)
    log "host: removed $removed image(s) of $old_image"
done

printf '%s bootstrap source=%s host=%s https_port=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${SOURCE_SHA:-unknown}" "$(basename "${HOST_FILE:-environment}")" "$HTTPS_PORT" \
    >> "$AAP_ROOT/host-history"
log "done"
