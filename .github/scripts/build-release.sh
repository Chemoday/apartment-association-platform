#!/usr/bin/env bash
# Build the files of a release (docs/DEPLOYMENT.md "Versions and releases"):
#
#   build-release.sh <vX.Y.Z> <commit> <output dir>
#
# Run by .github/workflows/release.yml from a checkout of the repository. Takes the commit's
# deploy/ and install/ with git archive (only committed files), bakes the version into
# install/install.sh and writes into the output directory:
#   install.sh           the installer of this version
#   aap-release.tar.gz   aap-<version>/ with deploy/, install/ and VERSION (VERSION=, COMMIT=)
set -euo pipefail

die() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

if [[ $# -ne 3 ]]; then
    echo "usage: build-release.sh <vX.Y.Z> <full commit id> <output dir>" >&2
    exit 2
fi
VERSION=$1
COMMIT=$2
OUT=$3
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must look like v1.2.3, not $VERSION"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the commit must be a full 40-character commit id"
git cat-file -e "$COMMIT^{commit}" 2> /dev/null || die "no commit $COMMIT in this repository"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
top="aap-$VERSION"
git archive --format=tar --prefix="$top/" "$COMMIT" deploy install | tar -x -C "$work"

installer="$work/$top/install/install.sh"
[[ -f "$installer" && -f "$work/$top/deploy/deploy.sh" ]] || die "the commit has no installer"
# Exactly one line is replaced; anything else means install.sh changed its form.
[[ $(grep -c '^RELEASE_VERSION=""$' "$installer") -eq 1 ]] \
    || die 'install/install.sh must hold exactly one line RELEASE_VERSION=""'
sed -i "s/^RELEASE_VERSION=\"\"\$/RELEASE_VERSION=\"$VERSION\"/" "$installer"
printf 'VERSION=%s\nCOMMIT=%s\n' "$VERSION" "$COMMIT" > "$work/$top/VERSION"

mkdir -p "$OUT"
install -m 755 "$installer" "$OUT/install.sh"
# Same content, same archive: sorted names, no local owners, the commit's time.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$(git log -1 --format=%ct "$COMMIT")" \
    -czf "$OUT/aap-release.tar.gz" -C "$work" "$top"
echo "built $VERSION ($COMMIT): $OUT/install.sh $OUT/aap-release.tar.gz"
