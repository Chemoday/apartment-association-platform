#!/usr/bin/env bash
# Update this installation to another commit of main (install/README.md, "Afterwards"):
#
#   bash /opt/aap/bin/update.sh <full 40-character commit id>
#
# Downloads that commit's release, then runs ITS installer again without questions, so the new
# release's own install logic applies: the answers, secrets and data are kept, only the release
# changes. deploy.sh checks the site's health and rolls back on its own when it fails.
set -euo pipefail

AAP_ROOT=${AAP_ROOT:-/opt/aap}
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: update.sh <full 40-character commit id of main>" >&2
    exit 2
fi
if [[ ! -f "$AAP_ROOT/site/settings.env" ]]; then
    echo "update: no installation in $AAP_ROOT; run install.sh first" >&2
    exit 1
fi
# The download of the installed installer (its functions only: main() does not run when sourced).
# shellcheck source=/dev/null
source "$AAP_ROOT/bin/install.sh"
RUN_KIND=update  # read by the sourced functions (log_line)
export RUN_KIND
REF=$1
fetch_release
AAP_RUN_KIND=update exec bash "$AAP_ROOT/releases/$REF/install/install.sh" --yes --ref "$REF"
