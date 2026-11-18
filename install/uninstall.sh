#!/usr/bin/env bash
# Remove this installation together with ALL its data (install/README.md, "Afterwards"):
#
#   bash /opt/aap/bin/uninstall.sh --delete-data [--yes]
#
# Removes the containers, volumes (the database, the certificates) and networks of the site and its
# proxy, the platform's images, the disk check timer and /opt/aap. Docker itself stays. There is no
# way back: the residents' data are gone (backups come with R6).
set -euo pipefail

AAP_ROOT=${AAP_ROOT:-/opt/aap}
DELETE=false
YES=false
for arg in "$@"; do
    case "$arg" in
        --delete-data) DELETE=true ;;
        --yes) YES=true ;;
        *) echo "unknown option $arg" >&2; exit 2 ;;
    esac
done
if ! $DELETE; then
    echo "usage: uninstall.sh --delete-data [--yes]   (deletes every piece of data of the site)" >&2
    exit 2
fi
[[ $EUID -eq 0 ]] || { echo "uninstall: run as root" >&2; exit 1; }
# Only ever this installation's own directory: an AAP_ROOT that holds no installation (a typo, a
# variable left over from something else) is refused, never deleted.
conf=""
[[ -f "$AAP_ROOT/aap.conf" ]] && conf=$(< "$AAP_ROOT/aap.conf")
if [[ ! -f "$AAP_ROOT/site/settings.env" || $'\n'"$conf"$'\n' != *$'\n'ENVIRONMENTS=site$'\n'* ]]; then
    echo "uninstall: $AAP_ROOT holds no installation made by install.sh; nothing was changed" >&2
    exit 1
fi
if ! $YES; then
    read -r -p "This deletes the site and all its data for good. Type delete to go on: " answer < /dev/tty
    [[ "$answer" == delete ]] || { echo "Nothing was changed."; exit 0; }
fi

image=""
# shellcheck source=/dev/null
[[ -f "$AAP_ROOT/aap.conf" ]] && image=$(. "$AAP_ROOT/aap.conf" && echo "${IMAGE:-}")
for project in aap-site aap-edge; do
    label="label=com.docker.compose.project=$project"
    mapfile -t ids < <(docker ps -aq --filter "$label")
    [[ ${#ids[@]} -eq 0 ]] || docker rm -f "${ids[@]}" > /dev/null
    mapfile -t ids < <(docker volume ls -q --filter "$label")
    [[ ${#ids[@]} -eq 0 ]] || docker volume rm "${ids[@]}" > /dev/null
    mapfile -t ids < <(docker network ls -q --filter "$label")
    [[ ${#ids[@]} -eq 0 ]] || docker network rm "${ids[@]}" > /dev/null
done
docker network rm aap-edge > /dev/null 2>&1 || true
if [[ -n "$image" ]]; then
    mapfile -t ids < <(docker image ls "$image" -q | sort -u)
    [[ ${#ids[@]} -eq 0 ]] || docker image rm -f "${ids[@]}" > /dev/null 2>&1 || true
fi
if command -v systemctl > /dev/null; then
    systemctl disable --now aap-disk-check.timer > /dev/null 2>&1 || true
    rm -f /etc/systemd/system/aap-disk-check.service /etc/systemd/system/aap-disk-check.timer
    systemctl daemon-reload || true
fi
rm -rf -- "$AAP_ROOT"
echo "The site and its data are removed. Install again with install.sh."
