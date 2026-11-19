#!/usr/bin/env bash
# Update this installation (install/README.md, "Afterwards"; docs/DEPLOYMENT.md "Running it again"):
#
#   bash /opt/aap/bin/update.sh                    the latest version
#   bash /opt/aap/bin/update.sh v0.3.0             that version
#   bash /opt/aap/bin/update.sh <commit>           a full commit id of main, for testing
#   ... --allow-downgrade                          a version below the installed one
#
# Downloads the release, then runs ITS installer again without questions, so the new release's
# own install logic applies: the answers, secrets and data are kept, only the release changes.
# deploy.sh checks the site's health and rolls back on its own when it fails.
set -euo pipefail

AAP_ROOT=${AAP_ROOT:-/opt/aap}
usage() {
    echo "usage: update.sh [vX.Y.Z | <full 40-character commit id of main>] [--allow-downgrade]" >&2
    exit 2
}
TARGET=""
DOWNGRADE=false
for arg in "$@"; do
    case "$arg" in
        --allow-downgrade) DOWNGRADE=true ;;
        -*) usage ;;
        *) [[ -z "$TARGET" ]] || usage; TARGET=$arg ;;
    esac
done
[[ -z "$TARGET" || "$TARGET" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ \
    || "$TARGET" =~ ^[0-9a-f]{40}$ ]] || usage
if [[ ! -f "$AAP_ROOT/site/settings.env" ]]; then
    echo "update: no installation in $AAP_ROOT; run install.sh first" >&2
    exit 1
fi

# The functions of the installed installer (main() does not run when sourced).
# shellcheck source=/dev/null
source "$AAP_ROOT/bin/install.sh"
export AAP_RUN_KIND=update  # load_previous and the next release's installer log as "update"
load_previous
ALLOW_DOWNGRADE=$DOWNGRADE
if [[ "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then
    REF=$TARGET
elif [[ -n "$TARGET" ]]; then
    A_VERSION=$TARGET
else
    A_VERSION=$(latest_version)
fi
check_forward "$A_VERSION"
fetch_release
VERSION=$(release_version "$REF")
if [[ "$REF" == "$P_SHA" ]]; then
    say "update: this installation runs $(describe_release "$REF" "$VERSION") already; nothing to do"
    log_line "nothing to do sha=$REF"
    exit 0
fi
say "updating to $(describe_release "$REF" "$VERSION")"
exec bash "$AAP_ROOT/releases/$REF/install/install.sh" --yes --ref "$REF"
