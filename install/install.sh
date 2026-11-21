#!/usr/bin/env bash
# Install the Apartment Association Platform on an association's own VPS, or run it again to
# change the answers or update (install/README.md; the contract is docs/DEPLOYMENT.md, "The simple
# install"). As root on x86_64 Debian or Ubuntu:
#
#   bash install.sh [--yes] [options]        (bash install.sh --help lists them)
#
# Three phases: prepare without questions (checks, Docker, the release and its image), the
# questions (or their flags), then the install on its own. Re-running keeps every secret and all
# data. The install log never holds a secret, an e-mail address, a link or the building's address.
set -euo pipefail
# Files this script writes without an explicit mode (edge/.env, the apt source) stay private to
# root even under a loose umask; secrets get 077 on their own.
umask 022

AAP_ROOT=${AAP_ROOT:-/opt/aap}
# The repository the installation was made from (aap.conf) wins on a re-run or an update.
INSTALLED_REPO=""
if [[ -f "$AAP_ROOT/aap.conf" ]]; then
    INSTALLED_REPO=$(sed -n 's/^REPO=//p' "$AAP_ROOT/aap.conf" | head -n 1)
fi
REPO=${AAP_REPO:-${INSTALLED_REPO:-Chemoday/apartment-association-platform}}
if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    echo "install: the repository must look like owner/name" >&2
    exit 2
fi
ENV_NAME=site
SITE_DIR="$AAP_ROOT/$ENV_NAME"
SETTINGS_FILE="$SITE_DIR/settings.env"
SECRETS_FILE="$SITE_DIR/.env"
LOG_FILE="$AAP_ROOT/install.log"
IMAGE="ghcr.io/${REPO,,}"
BACKEND="aap-${ENV_NAME}-backend-1"
APP_UID=1000  # the backend's user in its image; it owns the files directory
DISK_BUDGET_GB=15
CADDY_IMAGE=caddy:2.8.4-alpine
# The version this installer belongs to: .github/scripts/build-release.sh sets it in the installer
# of a release; empty in the repository (docs/DEPLOYMENT.md "Versions and releases").
RELEASE_VERSION=""
RELEASE_ARCHIVE=aap-release.tar.gz
MAX_DOWNLOAD_BYTES=$((200 * 1024 * 1024))  # a release is far smaller; a bigger download stops
# As root, tar would keep the owners and modes of the archive's members; the release gets root's
# own, under this script's umask.
UNTAR=(tar --no-same-owner --no-same-permissions)

# --- Output and the log ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
# The log gets only the first word of the reason (host, smtp, ...), never the rest of the message.
die() { printf 'install: %s\n' "$*" >&2; log_line "stopped ${1%%[: ]*}"; exit 1; }

# One line per step. Callers pass only step names, outcomes and commit ids: never a secret, an
# e-mail address, a link or an address (docs/DEPLOYMENT.md, "The install log and the screen").
log_line() {
    [[ -d "$AAP_ROOT" ]] || return 0
    printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_KIND" "$*" >> "$LOG_FILE"
    chmod 600 "$LOG_FILE"
}

usage() {
    cat <<'EOF'
Usage: bash install.sh [--yes] [options]

  --yes                     ask nothing: take the answers from the options and, on a re-run,
                            from the previous install
  --version <vX.Y.Z>        the version to install (default: the version of this installer,
                            else the latest one; on a re-run the one already installed)
  --ref <sha>               a commit of main instead of a version, for testing
  --allow-downgrade         allow --version to go below the installed version
  --host <name>             the site's own hostname, e.g. kyhistu.example.ee
  --no-domain               no own hostname: <ip-with-dashes>.sslip.io
  --public-ip <ip>          the server's public IPv4 address (default: detected)
  --mode <demo|real>        a demo with a fictitious building, or the real installation
  --building-address <a>    the building's address (looked up in the register)
  --building-code <code>    the register's code of the building, when known
  --association-name <n>    the association's name, e.g. "KÜ Näide 5"
  --registry-code <code>    the association's registry code (optional)
  --country <XX>            the building's country (default EE)
  --chairman-email <e>      the chairman's e-mail
  --invite-chairman         on a re-run, invite the chairman again
  --smtp-host <h>           SMTP server; with --smtp-port, --smtp-user, --smtp-from
  --smtp-password-file <f>  a file holding the SMTP password (never pass it on the command line)
  --no-smtp                 no e-mail (or remove it on a re-run)
  --tls-internal            Caddy's own certificates, only for tests without public DNS
  --help                    this text
EOF
}

# --- Answers --------------------------------------------------------------------------------------

YES=false
RUN_KIND=install
REF=""
A_VERSION="" ALLOW_DOWNGRADE=false
VERSION=""  # the version of the release being installed; empty for a commit
A_HOST="" A_NO_DOMAIN=false A_PUBLIC_IP=""
A_MODE=""
A_ADDRESS="" A_BUILDING_CODE="" A_NAME="" A_REGISTRY_CODE="" A_COUNTRY=""
A_CHAIRMAN="" A_INVITE=false
A_SMTP_HOST="" A_SMTP_PORT="" A_SMTP_USER="" A_SMTP_FROM="" A_SMTP_PASSWORD_FILE="" A_NO_SMTP=false
A_TLS_INTERNAL=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --yes) YES=true; shift ;;
            --version) A_VERSION=${2:?--version needs a version}; shift 2 ;;
            --ref) REF=${2:?--ref needs a commit}; shift 2 ;;
            --allow-downgrade) ALLOW_DOWNGRADE=true; shift ;;
            --host) A_HOST=${2:?--host needs a name}; shift 2 ;;
            --no-domain) A_NO_DOMAIN=true; shift ;;
            --public-ip) A_PUBLIC_IP=${2:?--public-ip needs an address}; shift 2 ;;
            --mode) A_MODE=${2:?--mode needs demo or real}; shift 2 ;;
            --building-address) A_ADDRESS=${2:?--building-address needs a value}; shift 2 ;;
            --building-code) A_BUILDING_CODE=${2:?--building-code needs a value}; shift 2 ;;
            --association-name) A_NAME=${2:?--association-name needs a value}; shift 2 ;;
            --registry-code) A_REGISTRY_CODE=${2:?--registry-code needs a value}; shift 2 ;;
            --country) A_COUNTRY=${2:?--country needs two letters}; shift 2 ;;
            --chairman-email) A_CHAIRMAN=${2:?--chairman-email needs an address}; shift 2 ;;
            --invite-chairman) A_INVITE=true; shift ;;
            --smtp-host) A_SMTP_HOST=${2:?--smtp-host needs a value}; shift 2 ;;
            --smtp-port) A_SMTP_PORT=${2:?--smtp-port needs a value}; shift 2 ;;
            --smtp-user) A_SMTP_USER=${2:?--smtp-user needs a value}; shift 2 ;;
            --smtp-from) A_SMTP_FROM=${2:?--smtp-from needs a value}; shift 2 ;;
            --smtp-password-file) A_SMTP_PASSWORD_FILE=${2:?--smtp-password-file needs a file}; shift 2 ;;
            --smtp-password|--smtp-password=*)
                say "install: never pass the SMTP password on the command line; use --smtp-password-file" >&2
                exit 2 ;;
            --no-smtp) A_NO_SMTP=true; shift ;;
            --tls-internal) A_TLS_INTERNAL=true; shift ;;
            --help|-h) usage; exit 0 ;;
            *) say "install: unknown option $1 (see --help)" >&2; exit 2 ;;
        esac
    done
    if [[ -n "$REF" && ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
        say "install: --ref must be a full 40-character commit id" >&2
        exit 2
    fi
    if [[ -n "$A_VERSION" ]] && ! valid_version "$A_VERSION"; then
        say "install: --version must look like v1.2.3" >&2
        exit 2
    fi
    if [[ -n "$A_VERSION" && -n "$REF" ]]; then
        say "install: give --version or --ref, not both" >&2
        exit 2
    fi
}

# The previous install's settings: the defaults of a re-run. Read in a subshell, so nothing in the
# file can change this script's own variables.
P_SITE_HOST="" P_SITE_MODE="" P_COUNTRY="" P_SMTP_HOST="" P_SMTP_PORT="" P_SMTP_USERNAME=""
P_SMTP_FROM="" P_INSTANCE_ID="" P_TLS_MODE="" P_PUBLIC_IP="" P_SHA=""
load_previous() {
    [[ -f "$SETTINGS_FILE" ]] || return 0
    RUN_KIND=${AAP_RUN_KIND:-rerun}  # update.sh says update
    local line
    # shellcheck source=/dev/null
    while IFS= read -r line; do
        case "$line" in
            SITE_HOST=*|SITE_MODE=*|COUNTRY=*|SMTP_HOST=*|SMTP_PORT=*|SMTP_USERNAME=*|SMTP_FROM=*|\
INSTANCE_ID=*|TLS_MODE=*|PUBLIC_IP=*)
                printf -v "P_${line%%=*}" '%s' "${line#*=}" ;;
        esac
    done < <(set -a; . "$SETTINGS_FILE"; for key in SITE_HOST SITE_MODE COUNTRY SMTP_HOST \
        SMTP_PORT SMTP_USERNAME SMTP_FROM INSTANCE_ID TLS_MODE PUBLIC_IP; do printf '%s=%s\n' "$key" "${!key:-}"; done)
    P_SHA=$(cat "$SITE_DIR/current_sha" 2> /dev/null || true)
}

# Ask on the terminal unless --yes; the answer goes into the variable named $1.
ask() {  # <var> <prompt> [default]
    local var=$1 prompt=$2 default=${3:-} reply
    if $YES; then
        printf -v "$var" '%s' "$default"
        return 0
    fi
    if [[ -n "$default" ]]; then
        read -r -p "$prompt [$default]: " reply < /dev/tty
    else
        read -r -p "$prompt: " reply < /dev/tty
    fi
    printf -v "$var" '%s' "${reply:-$default}"
}

# One line of printable text: no control characters (a line break in an answer would split it in
# settings.env when a re-run reads it back).
one_line() {
    [[ "$1" != *[[:cntrl:]]* ]]
}

valid_ipv4() {
    local IFS=. part
    # shellcheck disable=SC2206
    local parts=($1)
    [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ && ${#parts[@]} -eq 4 ]] || return 1
    for part in "${parts[@]}"; do
        [[ $((10#$part)) -le 255 ]] || return 1
    done
}

# vX.Y.Z without leading zeros, so that one version has one spelling.
valid_version() { [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }

valid_hostname() {
    [[ ${#1} -le 253 && "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]
}

valid_email() {
    [[ ${#1} -le 254 && "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

# --- Phase 1: prepare ----------------------------------------------------------------------------

check_server() {
    [[ $EUID -eq 0 ]] || die "run as root (sudo -i, then bash install.sh)"
    local arch
    arch=$(uname -m)
    [[ "$arch" == x86_64 ]] || die "this server is $arch; the platform runs on x86_64 (amd64) only"
    local os_id="" os_like=""
    # shellcheck source=/dev/null
    os_id=$(. /etc/os-release && echo "${ID:-}")
    # shellcheck source=/dev/null
    os_like=$(. /etc/os-release && echo "${ID_LIKE:-}")
    [[ "$os_id" == debian || "$os_id" == ubuntu || " $os_like " == *" debian "* ]] \
        || die "this server runs ${os_id:-an unknown system}; the installer supports Debian and Ubuntu"
}

check_ports() {
    command -v ss > /dev/null || return 0
    local busy
    busy=$(ss -Hltn '( sport = :80 or sport = :443 )' 2> /dev/null || true)
    [[ -z "$busy" ]] && return 0
    if command -v docker > /dev/null \
        && docker ps --filter name=aap-edge-caddy --format '{{.Names}}' 2> /dev/null | grep -q .; then
        return 0  # this installation's own proxy
    fi
    die "ports: port 80 or 443 is used by another program; free them (ss -ltnp shows which)"
}

ensure_packages() {
    local missing=()
    command -v curl > /dev/null || missing+=(curl)
    command -v openssl > /dev/null || missing+=(openssl)
    command -v flock > /dev/null || missing+=(util-linux)
    [[ -d /etc/ssl/certs ]] || missing+=(ca-certificates)
    [[ ${#missing[@]} -eq 0 ]] && return 0
    say "installing ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" > /dev/null
}

# The health checks use start_interval (docs/DEPLOYMENT.md "Resource limits and disk hygiene"):
# an older engine or Compose plugin either fails on it or ignores it.
MIN_DOCKER_MAJOR=25
MIN_COMPOSE_VERSION=2.20.2

ensure_docker() {
    if command -v docker > /dev/null && docker compose version > /dev/null 2>&1; then
        check_docker_version
        say "Docker is present"
        return 0
    fi
    say "installing Docker from Docker's own repository"
    local os_id codename
    # shellcheck source=/dev/null
    os_id=$(. /etc/os-release && echo "$ID")
    # shellcheck source=/dev/null
    codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
    [[ "$os_id" == ubuntu || "$os_id" == debian ]] || os_id=debian
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$os_id/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$os_id" "$codename" > /etc/apt/sources.list.d/docker.list
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-compose-plugin > /dev/null
    systemctl enable --now docker > /dev/null 2>&1 || true
    docker compose version > /dev/null || die "docker: Docker did not start"
    check_docker_version
    log_line "docker installed"
}

check_docker_version() {
    local version major
    version=$(docker version --format '{{.Server.Version}}' 2> /dev/null) || version=""
    major=${version%%.*}
    [[ "$major" =~ ^[0-9]+$ ]] || die "docker: cannot read the version of the Docker Engine; is the Docker service running?"
    [[ "$major" -ge "$MIN_DOCKER_MAJOR" ]] \
        || die "docker: Docker Engine $version is older than $MIN_DOCKER_MAJOR; update Docker (https://docs.docker.com/engine/install/) and run the installer again"
    local compose
    compose=$(docker compose version --short 2> /dev/null) || compose=""
    compose=${compose#v}
    [[ "$compose" =~ ^[0-9]+\.[0-9]+ ]] || die "docker: cannot read the version of Docker Compose"
    [[ "$(printf '%s\n%s\n' "$MIN_COMPOSE_VERSION" "$compose" | sort -V | head -n 1)" == "$MIN_COMPOSE_VERSION" ]] \
        || die "docker: Docker Compose $compose is older than $MIN_COMPOSE_VERSION; update the docker-compose-plugin package and run the installer again"
}

# Which release (docs/DEPLOYMENT.md "What gets downloaded"): --ref or --version as given; on a
# re-run the installed one (update.sh passes --ref), even when this installer is of another
# version: a re-run changes the answers, update.sh changes the version; else the version of this
# installer, else the latest version.
resolve_release() {
    [[ -n "$REF" || -n "$A_VERSION" ]] && return 0
    if [[ -n "$P_SHA" ]]; then
        [[ "$P_SHA" =~ ^[0-9a-f]{40}$ ]] || die "release: $SITE_DIR/current_sha is not a commit id"
        REF=$P_SHA
        local installed
        installed=$(release_version "$P_SHA")
        if [[ -n "$RELEASE_VERSION" && "$RELEASE_VERSION" != "$installed" ]]; then
            say "note: this installer is of $RELEASE_VERSION; the installation keeps $(describe_release "$P_SHA" "$installed")."
            say "      To change the version: bash $AAP_ROOT/bin/update.sh $RELEASE_VERSION"
        fi
        return 0
    fi
    if [[ -n "$RELEASE_VERSION" ]]; then
        A_VERSION=$RELEASE_VERSION
    else
        A_VERSION=$(latest_version)
    fi
}

latest_version() {
    local version
    version=$(curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"tag_name": *"[^"]*"' \
        | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/') || true
    valid_version "$version" || die "release: cannot find the latest version of $REPO (give a version such as v0.2.0)"
    printf '%s\n' "$version"
}

# The version of a downloaded release (its VERSION file); empty for a commit.
release_version() {  # <sha>
    local file="$AAP_ROOT/releases/$1/VERSION" version
    [[ -f "$file" ]] || return 0
    version=$(sed -n 's/^VERSION=//p' "$file" | head -n 1)
    if valid_version "$version"; then printf '%s\n' "$version"; fi
}

describe_release() {  # <sha> <version>
    if [[ -n "$2" ]]; then printf '%s\n' "$2"; else printf 'commit %s\n' "${1:0:12}"; fi
}

# Updates move forward (docs/DEPLOYMENT.md "Running it again"): a version below the installed
# one needs --allow-downgrade, because migrations are never reversed. A commit is not compared.
check_forward() {  # <version asked for>
    local target=$1 installed
    [[ -n "$target" && -n "$P_SHA" ]] || return 0
    installed=$(release_version "$P_SHA")
    [[ -n "$installed" && "$installed" != "$target" ]] || return 0
    [[ "$(printf '%s\n%s\n' "$installed" "$target" | sort -V | head -n 1)" == "$target" ]] || return 0
    $ALLOW_DOWNGRADE && return 0
    die "release: $target is older than the installed $installed, and migrations are never reversed (--allow-downgrade only when the release notes say it is safe)"
}

# The release goes to releases/<commit>/: for a version its archive, whose VERSION file names the
# commit; for a commit its source archive. Only deploy/, install/ and VERSION are kept.
fetch_release() {
    install -d -m 755 "$AAP_ROOT" "$AAP_ROOT/releases"
    if [[ -z "$REF" ]]; then
        fetch_version
        return 0
    fi
    local release_dir="$AAP_ROOT/releases/$REF"
    if [[ -f "$release_dir/deploy/deploy.sh" && -f "$release_dir/install/install.sh" ]]; then
        touch "$release_dir"  # keeps it from the clean-up while this run starts
        return 0
    fi
    local tmp
    tmp=$(mktemp -d "$AAP_ROOT/releases/.incoming.XXXXXX")
    if ! curl -fsSL --retry 3 --max-filesize "$MAX_DOWNLOAD_BYTES" -o "$tmp/.archive.tar.gz" \
            "https://codeload.github.com/$REPO/tar.gz/$REF" \
        || ! "${UNTAR[@]}" -xzf "$tmp/.archive.tar.gz" -C "$tmp" --strip-components=1 --wildcards '*/deploy/*'; then
        rm -rf "$tmp"
        die "release: cannot download commit $REF"
    fi
    # A commit older than the install has no install/: tar fails on the missing pattern, which
    # is told apart below instead of being reported as a failed download.
    "${UNTAR[@]}" -xzf "$tmp/.archive.tar.gz" -C "$tmp" --strip-components=1 --wildcards '*/install/*' 2> /dev/null || true
    rm -f "$tmp/.archive.tar.gz"
    keep_release_parts "$tmp"
    if [[ ! -f "$tmp/install/install.sh" ]]; then
        rm -rf "$tmp"
        die "release: commit $REF has no installer (it is older than the install); pick a newer commit"
    fi
    place_release "$tmp"
}

fetch_version() {
    local tmp version commit
    tmp=$(mktemp -d "$AAP_ROOT/releases/.incoming.XXXXXX")
    say "downloading version $A_VERSION"
    if ! curl -fsSL --retry 3 --max-filesize "$MAX_DOWNLOAD_BYTES" -o "$tmp/.archive.tar.gz" \
            "https://github.com/$REPO/releases/download/$A_VERSION/$RELEASE_ARCHIVE" \
        || ! "${UNTAR[@]}" -xzf "$tmp/.archive.tar.gz" -C "$tmp" --strip-components=1 --wildcards \
            '*/deploy/*' '*/install/*' '*/VERSION'; then
        rm -rf "$tmp"
        die "release: cannot download version $A_VERSION (is it on the Releases page of $REPO?)"
    fi
    rm -f "$tmp/.archive.tar.gz"
    keep_release_parts "$tmp"
    version="" commit=""
    if [[ -f "$tmp/VERSION" && ! -L "$tmp/VERSION" ]]; then
        version=$(sed -n 's/^VERSION=//p' "$tmp/VERSION" 2> /dev/null | head -n 1) || version=""
        commit=$(sed -n 's/^COMMIT=//p' "$tmp/VERSION" 2> /dev/null | head -n 1) || commit=""
    fi
    if [[ "$version" != "$A_VERSION" || ! "$commit" =~ ^[0-9a-f]{40}$ \
        || ! -f "$tmp/deploy/deploy.sh" || ! -f "$tmp/install/install.sh" ]]; then
        rm -rf "$tmp"
        die "release: the archive of $A_VERSION is not a release of that version"
    fi
    REF=$commit
    # A release of the same commit installed with --ref has no VERSION file: it is replaced by the
    # same files with VERSION, so the version shows from now on.
    if [[ "$(release_version "$REF")" == "$A_VERSION" && -f "$AAP_ROOT/releases/$REF/install/install.sh" ]]; then
        rm -rf "$tmp"
        touch "$AAP_ROOT/releases/$REF"  # keeps it from the clean-up while this run starts
        return 0
    fi
    place_release "$tmp"
}

# The patterns of tar match at any depth (src/deploy/x, notes/VERSION): only the top-level
# deploy/, install/ and VERSION are a release.
keep_release_parts() {  # <downloaded directory>
    find "$1" -mindepth 1 -maxdepth 1 ! -name deploy ! -name install ! -name VERSION \
        -exec rm -rf -- {} +
}

place_release() {  # <downloaded directory>
    local release_dir="$AAP_ROOT/releases/$REF"
    rm -rf "$release_dir"
    mv "$1" "$release_dir"
    chmod 755 "$release_dir"
}

pull_image() {
    docker image inspect "$IMAGE:$REF" > /dev/null 2>&1 && return 0
    say "downloading the platform ($(describe_release "$REF" "$VERSION"))"
    local hint="no image for commit $REF yet (CI builds it a few minutes after the merge)"
    [[ -n "$VERSION" ]] && hint="cannot download the image of $VERSION ($IMAGE:$REF); check the server's connection to ghcr.io"
    docker pull --quiet "$IMAGE:$REF" > /dev/null || die "image: $hint"
}

detect_public_ip() {
    if [[ -n "$A_PUBLIC_IP" ]]; then
        valid_ipv4 "$A_PUBLIC_IP" || die "network: --public-ip must be an IPv4 address"
        PUBLIC_IP=$A_PUBLIC_IP
        return 0
    fi
    # A re-run without questions (update.sh) keeps the address it found before: no outside call.
    $YES && [[ -n "$P_PUBLIC_IP" ]] && { PUBLIC_IP=$P_PUBLIC_IP; return 0; }
    PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2> /dev/null \
        || curl -4 -fsS --max-time 10 https://ifconfig.me 2> /dev/null || true)
    valid_ipv4 "$PUBLIC_IP" || die "network: cannot find the server's public IP; pass --public-ip"
}

# --- Phase 2: the questions -----------------------------------------------------------------------

resolves_here() {  # <host>
    getent ahostsv4 "$1" 2> /dev/null | awk '{print $1}' | grep -qxF -- "$PUBLIC_IP"
}

ask_host() {
    local sslip="${PUBLIC_IP//./-}.sslip.io" default answer
    default=${P_SITE_HOST:-}
    [[ -n "$A_HOST" ]] && default=$A_HOST
    $A_NO_DOMAIN && default=$sslip
    if ! $YES; then
        say ""
        say "1. The address of the site. Type the site's own hostname, only the name, for example"
        say "   kyhistu.example.ee or example.ee (no https://, no port, no path). Point it at this"
        say "   server first: a DNS record of type A with the IP $PUBLIC_IP."
        say "   Press Enter for no own address: the site then gets $sslip."
    fi
    while true; do
        ask answer "   Address" "${default:-$sslip}"
        answer=${answer,,}
        answer=${answer#https://}
        answer=${answer#http://}
        answer=${answer%/}
        if ! valid_hostname "$answer"; then
            $YES && die "host: '$answer' is not a hostname"
            say "   That is not a hostname: only letters, digits, '-' and dots, like kyhistu.example.ee."
            continue
        fi
        # An unchanged host on a re-run without questions is not checked again (a proxied DNS
        # record or a NAT must not stop an update).
        if [[ "$answer" == "$sslip" ]] || $A_TLS_INTERNAL || { $YES && [[ "$answer" == "$P_SITE_HOST" ]]; } \
            || resolves_here "$answer"; then
            SITE_HOST=$answer
            return 0
        fi
        $YES && die "host: $answer does not point to $PUBLIC_IP yet (add the DNS record, wait, run again)"
        say "   $answer does not point to $PUBLIC_IP yet. Add or fix its A record, wait a few minutes"
        say "   and press Enter to check again, or type another address."
        default=$answer
    done
}

ask_mode() {
    local default=${A_MODE:-${P_SITE_MODE:-real}} answer
    if ! $YES; then
        say ""
        say "2. A demo (a fictitious building anyone can try, no mail) or the real installation?"
    fi
    while true; do
        ask answer "   demo or real" "$default"
        case "$answer" in
            demo|real) MODE=$answer; return 0 ;;
        esac
        $YES && die "mode: --mode must be demo or real"
        say "   Type demo or real."
    done
}

# The register lookup runs in the downloaded image, with the platform's own provider.
find_building() {  # <address> -> prints the command's JSON line; returns its exit code
    docker run --rm --entrypoint python -e ENABLED_PLUGINS=countries.ee.building_registry \
        -e LOG_LEVEL=WARNING "$IMAGE:$REF" -m src.modules.property find-building \
        --address "$1" --country "$COUNTRY" 2> /dev/null | tail -n 1
    return "${PIPESTATUS[0]}"
}

# Prints "code<TAB>address" per candidate of the command's JSON (no python3 needed on the host).
candidates_of() {  # <json>
    docker run --rm -i --entrypoint python "$IMAGE:$REF" -c '
import json, sys
for c in json.loads(sys.stdin.read()).get("candidates", []):
    print(c["code"] + "\t" + c["address"])' <<< "$1" | tr -d '\000-\010\013-\037\177'
}

ask_building() {
    COUNTRY=${A_COUNTRY:-${P_COUNTRY:-EE}}
    COUNTRY=${COUNTRY^^}
    if [[ -f "$SITE_DIR/.building-done" && -z "$A_ADDRESS" && -z "$A_NAME" ]]; then
        BUILDING_KNOWN=true  # a re-run: the building exists already
        return 0
    fi
    BUILDING_KNOWN=false
    BUILDING_CODE=""  # the register's code of the building the lookup found (for the template)
    if ! $YES; then
        say ""
        say "3. The building. Its address is looked up in the public building register."
    fi
    local address=$A_ADDRESS json status=0 chosen=""
    while true; do
        ask address "   The building's address (street, number, town)" "$address"
        one_line "$address" || die "building: the address must be one line of text"
        [[ ${#address} -ge 3 ]] && break
        $YES && die "building: --building-address is required for a real installation"
    done
    BUILDING_ADDRESS=$address
    json=$(find_building "$address") || status=$?
    if [[ $status -eq 0 ]]; then
        local -a codes=() addresses=()
        local code text
        while IFS=$'\t' read -r code text; do
            codes+=("$code")
            addresses+=("$text")
        done < <(candidates_of "$json")
        if [[ ${#codes[@]} -eq 0 ]]; then
            say "   The register found no building at that address; the address is kept as typed."
        elif $YES; then
            local i
            for i in "${!codes[@]}"; do
                if [[ "${codes[$i]}" == "$A_BUILDING_CODE" || ${#codes[@]} -eq 1 ]]; then
                    chosen=$i
                    break
                fi
            done
            [[ -n "$chosen" ]] || say "   Several buildings match; the address is kept as typed (--building-code picks one)."
        else
            local i
            for i in "${!codes[@]}"; do
                printf '   %d) %s\n' "$((i + 1))" "${addresses[$i]}"
            done
            say "   0) none of these: keep the address as typed"
            local pick
            while true; do
                ask pick "   Which one" "1"
                if [[ "$pick" =~ ^[0-9]+$ && $pick -le ${#codes[@]} ]]; then
                    [[ $pick -gt 0 ]] && chosen=$((pick - 1))
                    break
                fi
            done
        fi
        if [[ -n "$chosen" ]]; then
            BUILDING_ADDRESS=${addresses[$chosen]}
            BUILDING_CODE=${codes[$chosen]}
        fi
        log_line "building lookup ok"
    else
        case $status in
            3) say "   The register does not answer now; the address is kept as typed." ;;
            4) say "   There is no register for $COUNTRY; the address is kept as typed." ;;
            *) say "   The lookup could not run (exit $status); the address is kept as typed." ;;
        esac
        log_line "building lookup failed status=$status"
    fi
    while true; do
        ask ASSOCIATION_NAME "   The association's name (for example KÜ Näide 5)" "$A_NAME"
        one_line "$ASSOCIATION_NAME" || die "building: the name must be one line of text"
        [[ -n "${ASSOCIATION_NAME// /}" ]] && break
        $YES && die "building: --association-name is required for a real installation"
    done
    ask REGISTRY_CODE "   Its registry code (optional, Enter to skip)" "$A_REGISTRY_CODE"
    one_line "$REGISTRY_CODE" || die "building: the registry code must be one line of text"
}

ask_chairman() {
    CHAIRMAN_EMAIL=""
    INVITE=$A_INVITE
    # The first run invites; so does a re-run after a run that stopped before the invitation.
    # Once invited, only --invite-chairman (or a yes below) invites again: a re-run that reuses the
    # first command line to change the e-mail settings must not send a second invitation.
    [[ -f "$SITE_DIR/.chairman-invited" ]] || INVITE=true
    if [[ -f "$SITE_DIR/.chairman-invited" ]] && ! $INVITE; then
        if $YES; then
            [[ -n "$A_CHAIRMAN" ]] && say "   The chairman was invited before; --chairman-email is ignored (add --invite-chairman)."
            return 0
        fi
        local again
        ask again "4. Invite the chairman again? (yes/no)" "no"
        [[ "$again" == yes ]] || return 0
        INVITE=true
    fi
    $YES || say ""
    while true; do
        ask CHAIRMAN_EMAIL "4. The chairman's e-mail" "$A_CHAIRMAN"
        valid_email "$CHAIRMAN_EMAIL" && return 0
        $YES && die "chairman: --chairman-email is not an e-mail address"
        say "   That is not an e-mail address."
    done
}

ask_smtp() {
    SMTP_PASSWORD_NEW=""
    if $A_NO_SMTP; then
        SMTP_HOST=""
        return 0
    fi
    if ! $YES; then
        say ""
        say "5. E-mail (SMTP) of the mailbox the site sends from. Press Enter to skip:"
        say "   the platform works, but residents get invitations only once it is set."
        say "   Type none to remove settings made before."
    fi
    ask SMTP_HOST "   SMTP server" "${A_SMTP_HOST:-$P_SMTP_HOST}"
    [[ "$SMTP_HOST" == none ]] && SMTP_HOST=""
    [[ -z "$SMTP_HOST" ]] && return 0
    valid_hostname "${SMTP_HOST,,}" || die "smtp: '$SMTP_HOST' is not a hostname"
    ask SMTP_PORT "   Port" "${A_SMTP_PORT:-${P_SMTP_PORT:-587}}"
    [[ "$SMTP_PORT" =~ ^[0-9]+$ && $SMTP_PORT -ge 1 && $SMTP_PORT -le 65535 ]] \
        || die "smtp: '$SMTP_PORT' is not a port"
    ask SMTP_USERNAME "   User name" "${A_SMTP_USER:-$P_SMTP_USERNAME}"
    if [[ -z "$SMTP_USERNAME" || "$SMTP_USERNAME" == *[[:space:][:cntrl:]]* ]]; then
        die "smtp: the user name must be one word without spaces"
    fi
    ask SMTP_FROM "   Sender address" "${A_SMTP_FROM:-${P_SMTP_FROM:-$SMTP_USERNAME}}"
    valid_email "$SMTP_FROM" || die "smtp: the sender '$SMTP_FROM' is not an e-mail address"
    if [[ -n "$A_SMTP_PASSWORD_FILE" ]]; then
        [[ -r "$A_SMTP_PASSWORD_FILE" ]] || die "smtp: cannot read --smtp-password-file"
        SMTP_PASSWORD_NEW=$(head -n 1 "$A_SMTP_PASSWORD_FILE")
        SMTP_PASSWORD_NEW=${SMTP_PASSWORD_NEW%$'\r'}  # a file saved on Windows
    elif ! $YES; then
        local hint="Password (not shown)"
        grep -q '^SMTP_PASSWORD=.' "$SECRETS_FILE" 2> /dev/null && hint="Password (not shown; Enter keeps the saved one)"
        IFS= read -r -s -p "   $hint: " SMTP_PASSWORD_NEW < /dev/tty
        echo
    fi
    # Kept in single quotes in .env, which Docker Compose reads literally, except that \' escapes
    # the closing quote: no ', no \ and no line break.
    if [[ "$SMTP_PASSWORD_NEW" == *"'"* || "$SMTP_PASSWORD_NEW" == *"\\"* || "$SMTP_PASSWORD_NEW" == *$'\n'* ]]; then
        die "smtp: the password must not contain ' or \\ or a line break; make an app password without them"
    fi
    if [[ -z "$SMTP_PASSWORD_NEW" ]] && ! grep -q '^SMTP_PASSWORD=.' "$SECRETS_FILE" 2> /dev/null; then
        die "smtp: a password is needed (or --smtp-password-file)"
    fi
}

confirm() {
    $YES && return 0
    say ""
    say "Ready to install:"
    say "  version    $(describe_release "$REF" "$VERSION")"
    say "  site       https://$SITE_HOST"
    say "  mode       $MODE"
    if [[ "$MODE" == real ]]; then
        if $BUILDING_KNOWN; then
            say "  building   kept as it is"
        else
            say "  building   $ASSOCIATION_NAME, $BUILDING_ADDRESS"
        fi
        [[ -n "$CHAIRMAN_EMAIL" ]] && say "  chairman   $CHAIRMAN_EMAIL (invited)"
        if [[ -n "$SMTP_HOST" ]]; then
            say "  e-mail     $SMTP_USERNAME via $SMTP_HOST:$SMTP_PORT"
        else
            say "  e-mail     not set"
        fi
    fi
    local go
    ask go "Go on? (yes/no)" "yes"
    [[ "$go" == yes ]] || { say "Nothing was changed."; exit 0; }
}

# --- Phase 3: install -----------------------------------------------------------------------------

# The marker of the data decides, not the answer: a demo never becomes the real installation on
# the same data, nor the other way round (docs/DEPLOYMENT.md, "Running it again").
guard_mode_switch() {
    [[ -n "$P_SITE_MODE" && "$P_SITE_MODE" != "$MODE" ]] || return 0
    if docker volume inspect "aap-${ENV_NAME}_pgdata" > /dev/null 2>&1; then
        die "mode: this server holds the data of a $P_SITE_MODE installation; a $MODE one needs fresh data (bash $AAP_ROOT/bin/uninstall.sh --delete-data, then install again)"
    fi
}

secret() { openssl rand -hex "$1"; }

write_secrets() {
    local old_umask
    old_umask=$(umask)
    umask 077
    _write_secrets
    umask "$old_umask"
}

# Docker Compose reads .env as a dotenv file and expands $ in unquoted values: every value is a
# hex secret, except the SMTP password, which is written in single quotes (taken literally).
_write_secrets() {
    install -d -m 750 "$SITE_DIR"
    touch "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
    [[ -z "$(tail -c1 "$SECRETS_FILE")" ]] || echo >> "$SECRETS_FILE"
    grep -q '^POSTGRES_PASSWORD=' "$SECRETS_FILE" || printf 'POSTGRES_PASSWORD=%s\n' "$(secret 24)" >> "$SECRETS_FILE"
    local name
    for name in JWT_SECRET_KEY AUTH_HASH_SECRET NOTIFICATIONS_HASH_SECRET; do
        grep -q "^$name=" "$SECRETS_FILE" || printf '%s=%s\n' "$name" "$(secret 32)" >> "$SECRETS_FILE"
    done
    if [[ -n "$SMTP_PASSWORD_NEW" ]]; then
        local kept
        kept=$(grep -v '^SMTP_PASSWORD=' "$SECRETS_FILE" || true)
        printf "%s\nSMTP_PASSWORD='%s'\n" "$kept" "$SMTP_PASSWORD_NEW" | sed '/^$/d' > "$SECRETS_FILE.new"
        chmod 600 "$SECRETS_FILE.new"
        mv "$SECRETS_FILE.new" "$SECRETS_FILE"
    fi
    if [[ -z "$SMTP_HOST" ]] && grep -q '^SMTP_PASSWORD=' "$SECRETS_FILE"; then
        grep -v '^SMTP_PASSWORD=' "$SECRETS_FILE" > "$SECRETS_FILE.new" || true
        chmod 600 "$SECRETS_FILE.new"
        mv "$SECRETS_FILE.new" "$SECRETS_FILE"
    fi
}

write_settings() {
    local instance_id=${P_INSTANCE_ID:-$(cat /proc/sys/kernel/random/uuid)}
    local demo=false plugins=common.csv_export tls=starttls
    [[ "$MODE" == demo ]] && demo=true
    [[ "$COUNTRY" == EE ]] && plugins+=,countries.ee.building_registry
    if [[ -n "$SMTP_HOST" ]]; then
        plugins+=,common.email_smtp
        [[ "$SMTP_PORT" == 465 ]] && tls=tls
    fi
    TLS_MODE=acme
    $A_TLS_INTERNAL && TLS_MODE=internal
    [[ "$P_TLS_MODE" == internal ]] && TLS_MODE=internal
    {
        echo "# Written by install.sh; run it again to change these (docs/DEPLOYMENT.md, \"The simple install\")."
        printf 'SITE_HOST=%q\n' "$SITE_HOST"
        printf 'SITE_MODE=%q\n' "$MODE"
        printf 'PUBLIC_IP=%q\n' "$PUBLIC_IP"
        printf 'COUNTRY=%q\n' "$COUNTRY"
        printf 'INSTANCE_ID=%q\n' "$instance_id"
        printf 'TLS_MODE=%q\n' "$TLS_MODE"
        echo "ENVIRONMENT=prod"
        printf 'DEMO_MODE_ENABLED=%s\nSEED_DEMO_DATA=%s\nFILES_IN_DEMO=false\n' "$demo" "$demo"
        printf 'ENABLED_PLUGINS=%q\n' "$plugins"
        printf 'PUBLIC_BASE_URL=%q\n' "https://$SITE_HOST"
        printf 'SMTP_HOST=%q\n' "$SMTP_HOST"
        printf 'SMTP_PORT=%q\n' "${SMTP_PORT:-587}"
        printf 'SMTP_USERNAME=%q\n' "${SMTP_USERNAME:-}"
        printf 'SMTP_FROM=%q\n' "${SMTP_FROM:-}"
        printf 'SMTP_TLS=%q\n' "$tls"
    } > "$SETTINGS_FILE.new"
    chmod 644 "$SETTINGS_FILE.new"
    mv "$SETTINGS_FILE.new" "$SETTINGS_FILE"
}

write_layout() {
    install -d -m 755 "$AAP_ROOT" "$AAP_ROOT/bin" "$AAP_ROOT/edge" "$AAP_ROOT/edge/caddy" "$AAP_ROOT/releases"
    install -d -m 750 "$SITE_DIR"
    install -d -o "$APP_UID" -g "$APP_UID" -m 700 "$SITE_DIR/files"
    cat > "$AAP_ROOT/aap.conf" <<EOF
AAP_ROOT=$AAP_ROOT
REPO=$REPO
IMAGE=$IMAGE
DISK_BUDGET_GB=$DISK_BUDGET_GB
ENVIRONMENTS=$ENV_NAME
EOF
    chmod 644 "$AAP_ROOT/aap.conf"
    write_secrets
    write_settings
    # The first install gets its scripts at once (uninstall.sh must work even if the deploy fails).
    [[ -f "$AAP_ROOT/bin/install.sh" ]] || install_bin
}

# bin/ holds the scripts of the release that runs: after a failed deploy rolled back, a re-run of
# bin/install.sh must not be the installer of the release that failed.
install_bin() {
    local release="$AAP_ROOT/releases/$REF"
    install -m 755 "$release/install/install.sh" "$release/install/update.sh" \
        "$release/install/uninstall.sh" "$AAP_ROOT/bin/"
}

ensure_swap() {
    swapon --show --noheadings 2> /dev/null | grep -q . && return 0
    local mem_kb
    mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    [[ "$mem_kb" -lt $((4 * 1024 * 1024)) ]] || return 0
    if fallocate -l 2G /swapfile 2> /dev/null && chmod 600 /swapfile && mkswap /swapfile > /dev/null \
        && swapon /swapfile 2> /dev/null; then
        grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        log_line "swap created"
    else
        rm -f /swapfile
        say "note: no swap file could be made here (a container?); the site runs without one"
    fi
}

install_disk_check() {
    command -v systemctl > /dev/null || return 0
    local host="$AAP_ROOT/releases/$REF/deploy/host"
    install -m 755 "$host/aap-disk-check.sh" "$AAP_ROOT/bin/aap-disk-check"
    install -m 644 "$host/aap-disk-check.service" "$host/aap-disk-check.timer" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now aap-disk-check.timer > /dev/null 2>&1 || true
}

start_edge() {
    local release="$AAP_ROOT/releases/$REF"
    local staged
    staged=$(mktemp -d)
    cp "$release/install/Caddyfile" "$release/deploy/edge/environment.caddy" "$staged/"
    chmod 755 "$staged"
    chmod 644 "$staged"/*
    local checked
    if ! checked=$(docker run --rm -v "$staged:/etc/caddy:ro" -e SITE_HOST="$SITE_HOST" -e TLS_MODE="$TLS_MODE" \
        "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
        rm -rf "$staged"
        printf '%s\n' "$checked" | tail -n 5 >&2
        die "edge: the proxy configuration does not validate"
    fi
    install -m 644 "$release/deploy/edge/docker-compose.yml" "$AAP_ROOT/edge/"
    install -m 644 "$staged/Caddyfile" "$staged/environment.caddy" "$AAP_ROOT/edge/caddy/"
    rm -rf "$staged"
    printf 'HTTPS_PORT=443\nSITE_HOST=%s\nTLS_MODE=%s\n' "$SITE_HOST" "$TLS_MODE" > "$AAP_ROOT/edge/.env"
    docker network inspect aap-edge > /dev/null 2>&1 || docker network create aap-edge > /dev/null
    local edge=(docker compose -p aap-edge -f "$AAP_ROOT/edge/docker-compose.yml" --env-file "$AAP_ROOT/edge/.env")
    "${edge[@]}" up -d --remove-orphans > /dev/null 2>&1 || die "edge: the proxy did not start"
    local _
    for _ in $(seq 1 15); do
        "${edge[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1 && return 0
        sleep 1
    done
    die "edge: the proxy did not take its configuration"
}

deploy_release() {
    local output status=0
    output=$(AAP_CONF="$AAP_ROOT/aap.conf" bash "$AAP_ROOT/releases/$REF/deploy/deploy.sh" "$ENV_NAME" "$REF" 2>&1) \
        || status=$?
    if [[ $status -ne 0 ]]; then
        printf '%s\n' "$output" | tail -n 30 >&2
        die "deploy: the site did not start; it runs the previous version if there was one"
    fi
    log_line "deploy ok sha=$REF version=$VERSION"
}

in_backend() { docker exec "$BACKEND" python -m "$@"; }

create_building() {
    [[ "$MODE" == real ]] || return 0
    $BUILDING_KNOWN && return 0
    local args=(src.modules.property create-building --name "$ASSOCIATION_NAME" --address "$BUILDING_ADDRESS" --country "$COUNTRY")
    [[ -n "$REGISTRY_CODE" ]] && args+=(--registry-code "$REGISTRY_CODE")
    local output status=0
    output=$(in_backend "${args[@]}" 2>&1) || status=$?
    if [[ $status -eq 0 ]]; then
        log_line "building created"
    elif [[ "$output" == *"already has a building"* ]]; then
        say "The building exists already; it is kept as it is."
        log_line "building kept"
    else
        printf '%s\n' "$output" | tail -n 3 >&2
        die "building: the building was not created; run the installer again with a corrected answer"
    fi
    touch "$SITE_DIR/.building-done"
}

# The building template, prefilled from the register when the lookup found the building
# (docs/API.md section 1, "Filling the building of a new installation"). Never overwritten.
TEMPLATE_FILE=""
write_building_template() {
    [[ "$MODE" == real ]] || return 0
    $BUILDING_KNOWN && return 0
    [[ -n "${BUILDING_CODE:-}" ]] || return 0
    local file="$SITE_DIR/building-template.csv" status=0
    [[ -e "$file" ]] && return 0
    # The template is the standard output; the command's messages (no personal data: counts,
    # parts of the building it left out, errors) are its standard error.
    in_backend src.core.filling building-template --out - --from-register "$BUILDING_CODE" \
        > "$file.new" 2> "$file.err" || status=$?
    if [[ $status -eq 0 && -s "$file.new" ]]; then
        chmod 644 "$file.new"
        mv "$file.new" "$file"
        TEMPLATE_FILE=$file
        local line
        # Register text on the terminal: control characters stripped, as in candidates_of.
        while IFS= read -r line; do
            say "   $line"
        done < <(grep '^left out: ' "$file.err" | tr -d '\000-\010\013-\037\177' || true)
        log_line "building template written"
    else
        rm -f "$file.new"
        local reason
        reason=$(grep '^error: ' "$file.err" | tail -n 1 | tr -d '\000-\037\177' || true)
        say "note: the building template was not written${reason:+ (${reason#error: })}."
        log_line "building template failed status=$status"
    fi
    rm -f "$file.err"
}

CHAIRMAN_LINK=""
CHAIRMAN_MAILED=false
invite_chairman() {
    [[ "$MODE" == real && -n "$CHAIRMAN_EMAIL" ]] || return 0
    local args=(src.modules.auth create-chairman --email "$CHAIRMAN_EMAIL" --print-link)
    # Inviting again on purpose replaces a chairman who lost the mailbox (create-chairman --force).
    [[ -f "$SITE_DIR/.chairman-invited" ]] && args+=(--force)
    local output status=0
    output=$(in_backend "${args[@]}" 2>&1) || status=$?
    if [[ $status -ne 0 ]]; then
        printf '%s\n' "$output" | grep -v '^link:' | tail -n 3 >&2
        die "chairman: the chairman was not invited"
    fi
    CHAIRMAN_LINK=$(printf '%s\n' "$output" | sed -n 's/^link: //p' | tail -n 1)
    [[ "$output" == *"invitation e-mail sent"* ]] && CHAIRMAN_MAILED=true
    if [[ "$output" == *"could not be sent"* ]]; then
        say "note: the mail server did not take the chairman's e-mail; check the e-mail settings (the link below works anyway)."
        log_line "chairman mail failed"
    fi
    touch "$SITE_DIR/.chairman-invited"
    log_line "chairman invited"
}

finish() {
    say ""
    say "Done: https://$SITE_HOST ($(describe_release "$REF" "$VERSION"))"
    if [[ "$MODE" == demo ]]; then
        say "This is a demo: open the site and pick a role at the top. No mail is sent."
    else
        if [[ -n "$CHAIRMAN_LINK" ]]; then
            say ""
            say "The chairman's invitation link (shown only now, not saved anywhere):"
            say "  $CHAIRMAN_LINK"
            $CHAIRMAN_MAILED && say "An e-mail with the same link went to the mail server; if it does not arrive, check the e-mail settings."
        fi
        say ""
        say "Next steps:"
        say "  1. The chairman opens the link and sets a password."
        local template=${TEMPLATE_FILE:-$SITE_DIR/building-template.csv}
        if [[ -n "$TEMPLATE_FILE" ]]; then
            say "  2. The apartments: $template holds those of the register. Fill in the entrances and"
            say "     the meters (a spreadsheet opens it), then check and import it:"
        elif [[ -e "$template" ]]; then
            # A re-run: never print a command that would write over the chairman's work.
            say "  2. The apartments: fill in $template if not done yet, then check and import it:"
        elif [[ -n "${BUILDING_CODE:-}" ]]; then
            # The register was found but the template was not written (the register was down):
            # the same command with the building it found.
            say "  2. The apartments: write the template from the register again, fill it in, then check and import it:"
            say "     docker exec $BACKEND python -m src.core.filling building-template --out - --from-register $BUILDING_CODE > $template"
        else
            say "  2. The apartments: write a template for <N> apartments (or --from-register <the code"
            say "     find-building gives>), fill it in, then check and import it:"
            say "     docker exec $BACKEND python -m src.core.filling building-template --out - --apartments <N> > $template"
        fi
        say "     docker exec -i $BACKEND python -m src.core.filling import-building --file - --dry-run < $template"
        say "     (the same without --dry-run imports it; docs/API.md section 1, \"Filling the building\")"
        [[ -n "$SMTP_HOST" ]] || say "  3. Set the e-mail (run bash $AAP_ROOT/bin/install.sh again) so residents get their invitations."
    fi
    say "  Updates: bash $AAP_ROOT/bin/update.sh (the latest version; read its release notes first)."
    say "  The log: $LOG_FILE"
}

main() {
    parse_args "$@"
    step "Preparing the server (no questions yet)"
    check_server
    load_previous
    log_line "start"
    check_ports
    ensure_packages
    ensure_docker
    resolve_release
    check_forward "$A_VERSION"
    fetch_release
    VERSION=$(release_version "$REF")
    pull_image
    detect_public_ip

    step "Questions"
    ask_host
    ask_mode
    COUNTRY=${A_COUNTRY:-${P_COUNTRY:-EE}}
    COUNTRY=${COUNTRY^^}
    BUILDING_KNOWN=true ASSOCIATION_NAME="" BUILDING_ADDRESS="" REGISTRY_CODE=""
    CHAIRMAN_EMAIL="" INVITE=false SMTP_HOST="" SMTP_PORT="" SMTP_USERNAME="" SMTP_FROM=""
    SMTP_PASSWORD_NEW=""
    if [[ "$MODE" == real ]]; then
        ask_building
        ask_chairman
        ask_smtp
    fi
    confirm

    step "Installing (no more questions)"
    guard_mode_switch
    write_layout
    log_line "settings written mode=$MODE"
    ensure_swap
    install_disk_check
    start_edge
    log_line "edge ok"
    say "starting the site (a few minutes on the first run)"
    deploy_release
    install_bin
    create_building
    write_building_template
    invite_chairman
    log_line "done"
    finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
