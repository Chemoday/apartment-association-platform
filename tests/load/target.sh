#!/usr/bin/env bash
# Load-test targets: demo installations started from the deploy compose file (tests/load/README.md).
#
#   target.sh up <n> <image> [apartments]   start installation load<n> on port 18000+n, fill it
#   target.sh down <n>                      stop it and delete its data
#   target.sh pgstat <n> [reset]            the costliest queries (pg_stat_statements)
#
# LOAD_EXTRA_COMPOSE=<file> with `up` adds one more compose file to the target (an experiment,
# for example other database settings); it is kept with the target until `down`.
# Runs as root on a throw-away load host, from a checkout of the repository. Every target is a
# demo installation with its own database, secrets and INSTANCE_ID under $LOAD_ROOT/load<n>; it is
# never a real one. The data come from tests/load/seed_load.py, run in the target's own image.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LOAD_ROOT=${LOAD_ROOT:-/srv/aap-load}

usage() { sed -n '3,6p' "$0" >&2; exit 2; }
[[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,2}$ ]] || usage  # no leading zero: it would be octal
CMD=$1
ENV_NAME="load$2"
PORT=$((18000 + $2))
DIR="$LOAD_ROOT/$ENV_NAME"

compose() {
    local files=(-f "$REPO/deploy/docker-compose.deploy.yml" -f "$HERE/docker-compose.load.yml")
    [[ -f "$DIR/extra.yml" ]] && files+=(-f "$DIR/extra.yml")
    docker compose -p "aap-$ENV_NAME" "${files[@]}" --env-file "$DIR/.env" "$@"
}

up() {
    local image=${1:?usage: target.sh up <n> <image> [apartments]} apartments=${2:-60}
    [[ ! -e "$DIR" ]] || { echo "target: $DIR exists; run target.sh down $ENV_NAME first" >&2; exit 1; }
    # A demo answers as anyone who sends X-Demo-User-Id: never publish it on every address.
    case "${LOAD_BIND:-127.0.0.1}" in
        0.0.0.0|::|"[::]"|"") echo "target: LOAD_BIND must be a loopback or private address, not ${LOAD_BIND:-empty}" >&2; exit 2 ;;
    esac
    install -d -m 750 "$DIR"
    install -d -o 1000 -g 1000 -m 700 "$DIR/files" "$DIR/out"
    [[ -z "${LOAD_EXTRA_COMPOSE:-}" ]] || install -m 644 "$LOAD_EXTRA_COMPOSE" "$DIR/extra.yml"
    umask 077
    cat > "$DIR/.env" <<EOF
APP_ENV=$ENV_NAME
AAP_ROOT=$LOAD_ROOT
IMAGE_REF=$image
LOAD_PORT=$PORT
LOAD_BIND=${LOAD_BIND:-127.0.0.1}
ENVIRONMENT=dev
DEMO_MODE_ENABLED=true
SEED_DEMO_DATA=false
FILES_IN_DEMO=true
INSTANCE_ID=$(cat /proc/sys/kernel/random/uuid)
ENABLED_PLUGINS=common.csv_export
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET_KEY=$(openssl rand -hex 32)
AUTH_HASH_SECRET=$(openssl rand -hex 32)
NOTIFICATIONS_HASH_SECRET=$(openssl rand -hex 32)
EOF
    docker network inspect aap-edge > /dev/null 2>&1 || docker network create aap-edge > /dev/null
    compose up -d --wait --wait-timeout 180
    # The database URL goes through a file, so the password never shows in `ps`.
    printf 'DATABASE_URL=postgresql+asyncpg://app:%s@db:5432/app\n' \
        "$(sed -n 's/^POSTGRES_PASSWORD=//p' "$DIR/.env")" > "$DIR/seed.env"
    docker run --rm --network "aap-${ENV_NAME}_internal" --env-file "$DIR/.env" \
        --env-file "$DIR/seed.env" \
        -v "$REPO/tests:/app/tests:ro" -v "$DIR/out:/out" \
        --entrypoint python "$image" -m tests.load.seed_load --apartments "$apartments" \
        --out /out/users.json
    compose exec -T db psql -qU app -d app -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" > /dev/null
    echo "target: $ENV_NAME on ${LOAD_BIND:-127.0.0.1}:$PORT, users in $DIR/out/users.json"
}

down() {
    [[ -f "$DIR/.env" ]] || { echo "target: no $DIR" >&2; exit 1; }
    compose down -v -t 10
    rm -rf -- "$DIR"
}

pgstat() {
    if [[ "${1:-}" == reset ]]; then
        compose exec -T db psql -qU app -d app -c "SELECT pg_stat_statements_reset()" > /dev/null
        return
    fi
    compose exec -T db psql -U app -d app -P pager=off -c "
        SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
               rows, left(regexp_replace(query, '\s+', ' ', 'g'), 110) AS query
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'app')
        ORDER BY total_exec_time DESC LIMIT 15"
}

case "$CMD" in
    up) up "${@:3}" ;;
    down) down ;;
    pgstat) pgstat "${@:3}" ;;
    *) usage ;;
esac
