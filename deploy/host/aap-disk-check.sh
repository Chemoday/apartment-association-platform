#!/usr/bin/env bash
# Disk check of the platform (docs/BACKLOG.md B-11), installed by bootstrap.sh as
# /opt/aap/bin/aap-disk-check and run hourly by aap-disk-check.timer as root.
#
# Warns when the platform uses 70% (and again at 85%) of its disk budget (DISK_BUDGET_GB in
# aap.conf, from the host file; derivation in docs/epics/E11_FILE_STORAGE.md, section 10), or when
# the host has less than 20% of its disk free. A warning goes to the journal (tag aap-disk-check)
# and the run fails, so it shows in `systemctl --failed`. Where an alert goes beyond that is open
# (B-11). Read only: it never deletes anything.
set -euo pipefail

# shellcheck source=/dev/null
source "${AAP_CONF:-/opt/aap/aap.conf}"  # AAP_ROOT, IMAGE, DISK_BUDGET_GB

budget_bytes=$(( ${DISK_BUDGET_GB:-40} * 1024 * 1024 * 1024 ))

# The platform: everything under /opt/aap (files, releases, state), the Docker volumes of the
# project's Compose projects (databases, certificates) and the project's images. The image sizes
# are summed per image, so shared base layers count more than once: a conservative estimate.
# A file may vanish while du scans (a clean-up, the files janitor); du then exits non-zero but its
# total is still right, so an error never makes the check fail without a reason.
incomplete=""
used=0
add_size_of() {  # <path>
    local bytes
    bytes=$(du -sxb "$1" 2> /dev/null | cut -f1) || true
    if [[ "$bytes" =~ ^[0-9]+$ ]]; then
        used=$(( used + bytes ))
    else
        incomplete=" (measurement incomplete: $1)"
    fi
}
add_size_of "$AAP_ROOT"
while read -r volume project; do
    [[ "$project" == aap-* ]] || continue
    if mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2> /dev/null); then
        add_size_of "$mountpoint"
    fi
done < <(docker volume ls --format '{{.Name}} {{.Label "com.docker.compose.project"}}' 2> /dev/null || true)
while IFS= read -r size; do
    if [[ "$size" =~ ^[0-9]+$ ]]; then used=$(( used + size )); fi
done < <(docker image ls "$IMAGE" --quiet 2> /dev/null | sort -u \
    | xargs -r docker image inspect --format '{{.Size}}' 2> /dev/null || true)

read -r disk_size disk_avail < <(df -B1 --output=size,avail / | tail -1)
free_pct=$(( disk_avail * 100 / disk_size ))
used_pct=$(( used * 100 / budget_bytes ))

summary="platform uses $(( used / 1024 / 1024 )) MB = ${used_pct}% of ${DISK_BUDGET_GB:-40} GB${incomplete}; host disk ${free_pct}% free"
problems=()
if (( used_pct >= 85 )); then
    problems+=("platform above 85% of its disk budget")
elif (( used_pct >= 70 )); then
    problems+=("platform above 70% of its disk budget")
fi
(( free_pct < 20 )) && problems+=("host disk below 20% free")

if (( ${#problems[@]} > 0 )); then
    message="WARNING: $(IFS='; '; echo "${problems[*]}"); $summary"
    logger -t aap-disk-check -p user.warning "$message"
    echo "$message"
    exit 1
fi
echo "ok: $summary"
