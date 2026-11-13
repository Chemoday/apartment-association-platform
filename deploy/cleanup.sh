#!/usr/bin/env bash
# Remove the project's images and release directories that no environment needs any more.
#
#   cleanup.sh
#
# Run by deploy.sh after a healthy deploy, as the "deploy" user. Kept: the current and the previous
# release of every environment (a rollback needs the previous one). Every image of the project is
# tagged with its commit, so `docker image prune` never removes one (docs/BACKLOG.md B-11). Images
# of other services on the host are never touched: only tags of $IMAGE are listed.
#
# A deploy of the other environment may be pulling or starting an image right now: every deploy
# holds a shared lock on $AAP_ROOT/releases/.deploy.lock while it runs, and this script only works
# when it gets the exclusive lock at once; otherwise it skips and the next deploy cleans up.
# ssh-gate.sh downloads (or touches) a release directory before its deploy takes the lock, and a
# rollback to an old release runs a deploy.sh that takes no lock at all, so every release whose
# directory changed in the last two hours is kept as well, together with its image.
set -euo pipefail

# shellcheck source=/dev/null
source "${AAP_CONF:-/opt/aap/aap.conf}"  # AAP_ROOT, IMAGE

log() { echo "[cleanup $(date -u +%H:%M:%S)] $*"; }

RELEASES="$AAP_ROOT/releases"
exec 8> "$RELEASES/.deploy.lock"
if ! flock -x -n 8; then
    log "another deploy is running; skipped"
    exit 0
fi

declare -A keep=()
for env_name in dev prod; do
    for state in current_sha previous_sha; do
        sha=$(cat "$AAP_ROOT/$env_name/$state" 2>/dev/null || true)
        [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && keep[$sha]=1
    done
done
while IFS= read -r dir; do
    keep[$(basename "$dir")]=1
done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9a-f]{40}' -mmin -120)
if [[ ${#keep[@]} -eq 0 ]]; then
    log "no environment has a current release; nothing removed"
    exit 0
fi

removed=0
while IFS= read -r tag; do
    [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue  # never touch other tags (main, latest, <none>)
    [[ -n "${keep[$tag]:-}" ]] && continue
    if docker image rm "$IMAGE:$tag" > /dev/null 2>&1; then
        removed=$((removed + 1))
    else
        log "could not remove image $IMAGE:$tag (still in use?)"
    fi
done < <(docker image ls "$IMAGE" --format '{{.Tag}}')

dirs=0
for dir in "$RELEASES"/*/; do
    [[ -d "$dir" ]] || continue
    sha=$(basename "$dir")
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ -n "${keep[$sha]:-}" ]] && continue
    rm -rf -- "$dir"
    dirs=$((dirs + 1))
done
# Downloads that ssh-gate.sh never finished.
find "$RELEASES" -maxdepth 1 -name '.incoming.*' -mmin +60 -exec rm -rf -- {} + 2> /dev/null || true

log "kept ${#keep[@]} release(s); removed $removed image(s) and $dirs release director(ies)"
