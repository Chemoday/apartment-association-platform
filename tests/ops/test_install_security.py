"""Security and privacy of the simple install (install/; docs/DEPLOYMENT.md "The simple install",
epic E13 task R5a): secrets on command lines and in files, the install log, quoting of the
answers, the downloaded archive and the destructive uninstall.

As in tests/ops/test_install.py, the functions of install.sh are sourced into bash against a
temporary AAP_ROOT with stub commands (docker, curl), so nothing on this machine is touched. The
uninstall runs as root inside a user namespace (`unshare -r`), where it cannot harm the host.
"""

import io
import ipaddress
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from tests.ops.test_install import (
    ADDRESS,
    EMAIL,
    INSTALL,
    PASSWORD,
    answers,
    bash,
    secrets,
    settings,
    write,
)

REPO_ROOT = INSTALL.parent
REF = "a" * 40
NAME = "KÜ Näidise 1"
REGISTER_ADDRESS = "Harju maakond, Tallinn, Kesklinna linnaosa, Näidise tn 1"
TOKEN = "invitation-token-Zq81xY"
LINK = f"https://kyhistu.example.ee/login/link#{TOKEN}"

STUB_DOCKER = """#!/usr/bin/env bash
# Records every call, answers like the platform's operator commands would.
printf '%s\\n' "$*" >> "$STUB_CALLS"
case "$1" in
    run)
        if [[ " $* " == *" find-building "* ]]; then
            printf '%s\\n' "$STUB_FIND_JSON"
            exit 0
        fi
        if [[ " $* " == *" -c "* ]]; then  # candidates_of: python -c CODE in the image
            while [[ $# -gt 0 && "$1" != -c ]]; do shift; done
            exec "$STUB_PYTHON" "$@"
        fi ;;
    exec)
        if [[ " $* " == *" create-building "* ]]; then
            echo "building 1 created"
            exit 0
        fi
        if [[ " $* " == *" building-template "* ]]; then
            if [[ "${STUB_TEMPLATE_EXIT:-0}" != 0 ]]; then
                echo "error: the register does not answer usably; try again later" >&2
                exit "$STUB_TEMPLATE_EXIT"
            fi
            printf 'apartment;entrance\\r\\n2;1\\r\\n'
            echo "template - written: 1 apartments, 1 meters (1 apartment, 0 building)" >&2
            echo "left out: part 1 (NON_RESIDENTIAL)" >&2
            exit 0
        fi
        if [[ " $* " == *" create-chairman "* ]]; then
            echo "invitation 00000000-0000-0000-0000-000000000000 created"
            echo "invitation e-mail sent"
            # Printed even when the command fails: the installer must filter it out.
            [[ " $* " == *" --print-link "* ]] && echo "link: $STUB_LINK"
            exit "${STUB_CHAIRMAN_EXIT:-0}"
        fi ;;
esac
exit 0
"""


def _stub_docker(tmp_path: Path, **extra: str) -> dict[str, str]:
    bin_dir = tmp_path / "stub-bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(STUB_DOCKER)
    docker.chmod(0o755)
    find_json = (
        '{"status": "found", "candidates": '
        f'[{{"code": "101036416", "address": "{REGISTER_ADDRESS}"}}]}}'
    )
    return {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "STUB_CALLS": str(tmp_path / "docker.calls"),
        "STUB_FIND_JSON": find_json,
        "STUB_PYTHON": sys.executable,
        "STUB_LINK": LINK,
        **extra,
    }


def _files_under(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()]


REAL_RUN = (
    "YES=true; MODE=real; COUNTRY=EE; RUN_KIND=install; SITE_HOST=kyhistu.example.ee; "
    "SMTP_HOST=''; "
    f"A_ADDRESS={shlex.quote(ADDRESS)}; A_NAME={shlex.quote(NAME)}; A_REGISTRY_CODE=80123456; "
    f"A_CHAIRMAN={shlex.quote(EMAIL)}; "
    'install -d "$AAP_ROOT/site"; log_line start; '
    "ask_building; ask_chairman; create_building; invite_chairman"
)


# --- The install log and the screen --------------------------------------------------------------


def test_a_real_installation_leaves_no_address_name_e_mail_or_link_in_the_log(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    env = _stub_docker(tmp_path)

    result = bash(root, f"{REAL_RUN}; log_line done; finish", **env)

    assert result.returncode == 0, result.stderr
    log = (root / "install.log").read_text()
    steps = [line.split(" ", 2)[2] for line in log.splitlines()]
    assert steps == ["start", "building lookup ok", "building created", "chairman invited", "done"]
    for private in (ADDRESS, REGISTER_ADDRESS, NAME, EMAIL, LINK, TOKEN, "Näidise"):
        assert private not in log
    # The register's address was chosen, and the building was created with it.
    calls = (tmp_path / "docker.calls").read_text()
    assert f"--address {REGISTER_ADDRESS} --country EE" in calls
    # The link is shown once on the screen and saved nowhere (install/README.md).
    assert result.stdout.count(LINK) == 1
    for path in _files_under(root):
        content = path.read_bytes()
        assert TOKEN.encode() not in content, path
        assert EMAIL.encode() not in content, path
    assert stat.S_IMODE((root / "install.log").stat().st_mode) == 0o600


def test_a_failed_chairman_invitation_shows_no_link_and_is_not_marked_done(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = _stub_docker(tmp_path, STUB_CHAIRMAN_EXIT="1")

    result = bash(root, REAL_RUN, **env)

    assert result.returncode == 1
    assert "chairman: the chairman was not invited" in result.stderr
    assert TOKEN not in result.stdout + result.stderr
    assert (root / "install.log").read_text().splitlines()[-1].endswith("install stopped chairman")
    assert not (root / "site/.chairman-invited").exists()
    for path in _files_under(root):
        assert TOKEN.encode() not in path.read_bytes(), path


# --- The SMTP password never leaves its file -----------------------------------------------------

WRAPPED = ("head", "grep", "sed", "tail", "touch", "chmod", "mv", "install", "openssl", "cat",
           "date", "mkdir", "rm")  # fmt: skip


def _wrap_commands(tmp_path: Path) -> dict[str, str]:
    """Every external program the secret steps run records its argv and exported variables."""
    bin_dir = tmp_path / "wrapped-bin"
    bin_dir.mkdir()
    for name in WRAPPED:
        real = shutil.which(name)
        assert real, name
        wrapper = bin_dir / name
        wrapper.write_text(
            "#!/usr/bin/env bash\n"
            '{ printf "%s " "${0##*/}" "$@"; printf "\\n"; export -p; } >> "$ARGV_LOG"\n'
            f'exec {shlex.quote(real)} "$@"\n'
        )
        wrapper.chmod(0o755)
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}", "ARGV_LOG": str(tmp_path / "argv.log")}


def test_the_smtp_password_never_reaches_a_command_line_or_an_environment(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    password_file = tmp_path / "smtp-password"
    password_file.write_text(PASSWORD + "\n")
    env = _wrap_commands(tmp_path)
    smtp = (
        "YES=true; A_SMTP_HOST=smtp.example.ee; A_SMTP_PORT=587; A_SMTP_USER=u@example.ee; "
        f"A_SMTP_FROM=u@example.ee; A_SMTP_PASSWORD_FILE={shlex.quote(str(password_file))}; "
    )
    body = (
        f'install -d "$AAP_ROOT/site"; log_line start; {smtp} ask_smtp; '
        "SITE_HOST=kyhistu.example.ee; MODE=real; COUNTRY=EE; PUBLIC_IP=203.0.113.7; "
        "write_secrets; write_settings; log_line 'settings written mode=real'"
    )

    first = bash(root, body, **env)
    # A re-run with a new password typed at the prompt (held in the same variable).
    again = bash(
        root,
        f"load_previous; {answers(SMTP_HOST='smtp.example.ee', SMTP_PASSWORD_NEW=PASSWORD + '2')}; "
        "write_secrets; write_settings",
        **env,
    )

    assert first.returncode == 0, first.stderr
    assert again.returncode == 0, again.stderr
    assert secrets(root)["SMTP_PASSWORD"] == f"'{PASSWORD}2'"  # the test is not vacuous
    recorded = (tmp_path / "argv.log").read_text()
    assert "openssl rand -hex" in recorded  # the wrappers did run
    assert PASSWORD not in recorded
    for text in (first.stdout, first.stderr, again.stdout, again.stderr):
        assert PASSWORD not in text
    for path in _files_under(root):
        if path.name != ".env":
            assert PASSWORD.encode() not in path.read_bytes(), path


@pytest.mark.parametrize("umask", ["000", "002"])
def test_secrets_and_the_log_are_private_even_with_a_loose_umask(
    tmp_path: Path, umask: str
) -> None:
    body = (
        f'umask {umask}; install -d "$AAP_ROOT/site"; log_line start; '
        f"{answers(SMTP_HOST='smtp.example.ee', SMTP_PASSWORD_NEW=PASSWORD)}; "
        "write_secrets; write_settings; log_line done"
    )

    result = bash(tmp_path, body)

    assert result.returncode == 0, result.stderr
    assert stat.S_IMODE((tmp_path / "site/.env").stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / "install.log").stat().st_mode) == 0o600
    # Not secret, but sourced by deploy.sh as root: nobody else may write it.
    assert stat.S_IMODE((tmp_path / "site/settings.env").stat().st_mode) == 0o644


# --- Answers with shell syntax -------------------------------------------------------------------

TRICKY = [
    "$(touch {canary})",
    "`touch {canary}`",
    "x'; touch {canary}; '",
    'x"; touch {canary}; "',
    "${{HOME}} $PATH \\ #comment",
    "KÜ Näide 5; & | < > *",
    "--yes",
    "-n",
]


@pytest.mark.parametrize("template", TRICKY)
def test_answers_with_shell_syntax_are_kept_literally_and_never_run(
    tmp_path: Path, template: str
) -> None:
    """settings.env is sourced by deploy.sh (`set -a; source`) and by load_previous as root."""
    canary = tmp_path / "canary"
    value = template.format(canary=canary)
    assert write(tmp_path, SMTP_USERNAME=value, SMTP_FROM=value).returncode == 0

    as_deploy_sh = subprocess.run(
        ["bash", "-c", 'set -euo pipefail; set -a; source "$1"; set +a; '
         'printf "%s\\0%s" "$SMTP_USERNAME" "$SMTP_FROM"', "deploy",
         str(tmp_path / "site/settings.env")],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)},
    )  # fmt: skip
    read_back = bash(tmp_path, 'load_previous; printf "%s\\0%s" "$P_SMTP_USERNAME" "$P_SMTP_FROM"')

    assert as_deploy_sh.returncode == 0, as_deploy_sh.stderr
    assert as_deploy_sh.stdout.split("\0") == [value, value]
    assert read_back.stdout.split("\0") == [value, value]
    assert settings(tmp_path)["SITE_HOST"] == "kyhistu.example.ee"
    assert not canary.exists()


def test_a_re_run_reads_back_exactly_the_answers_written_or_they_are_refused(
    tmp_path: Path,
) -> None:
    password_file = tmp_path / "pw"
    password_file.write_text("app-password\n")
    smuggled = "u@example.ee\nSITE_HOST=attacker.example.ee\nPUBLIC_IP=198.51.100.66"
    first = bash(
        tmp_path,
        "YES=true; A_SMTP_HOST=smtp.example.ee; A_SMTP_PORT=587; "
        f"A_SMTP_USER={shlex.quote(smuggled)}; A_SMTP_FROM=u@example.ee; "
        f"A_SMTP_PASSWORD_FILE={shlex.quote(str(password_file))}; "
        'install -d "$AAP_ROOT/site"; ask_smtp; '
        "SITE_HOST=kyhistu.example.ee; MODE=real; COUNTRY=EE; PUBLIC_IP=203.0.113.7; "
        "write_secrets; write_settings",
    )
    if first.returncode != 0:  # refused as an invalid answer: also correct
        return

    read_back = bash(
        tmp_path, 'load_previous; printf "%s\\0%s\\0%s" "$P_SITE_HOST" "$P_PUBLIC_IP" '
        '"$P_SMTP_USERNAME"'
    )  # fmt: skip

    assert read_back.stdout.split("\0") == ["kyhistu.example.ee", "203.0.113.7", smuggled]


def test_a_valid_public_ip_option_is_taken_as_given(tmp_path: Path) -> None:
    result = bash(tmp_path, "YES=true; A_PUBLIC_IP=203.0.113.7; detect_public_ip; echo $PUBLIC_IP")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "203.0.113.7"


@pytest.mark.parametrize("value", [".*", "203.0.113.7 2", "not-an-ip", "-v"])
def test_a_public_ip_option_that_is_not_an_ipv4_address_is_refused(
    tmp_path: Path, value: str
) -> None:
    result = bash(tmp_path, f"YES=true; A_PUBLIC_IP={shlex.quote(value)}; detect_public_ip")

    assert result.returncode != 0
    assert result.stderr.startswith("install: ")


# --- The downloaded release ----------------------------------------------------------------------


def _tarball(path: Path, members: list[tuple[str, bytes | str]]) -> Path:
    """members: (name, content) for files, (name, "->target") for symlinks."""
    with tarfile.open(path, "w:gz") as archive:
        for name, content in members:
            info = tarfile.TarInfo(name)
            if isinstance(content, str):
                info.type = tarfile.SYMTYPE
                info.linkname = content.removeprefix("->")
                archive.addfile(info)
            else:
                info.size = len(content)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(content))
    return path


def _fetch(tmp_path: Path, tarball: Path) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "curl-bin"
    bin_dir.mkdir()
    curl = bin_dir / "curl"
    # Like curl: the archive goes to the file of -o (install.sh), else to stdout.
    curl.write_text(
        "#!/bin/sh\nout=''\n"
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done\n'
        f'if [ -n "$out" ]; then cat {shlex.quote(str(tarball))} > "$out"; '
        f"else cat {shlex.quote(str(tarball))}; fi\n"
    )
    curl.chmod(0o755)
    return bash(
        tmp_path / "aap", f"REF={REF}; fetch_release", PATH=f"{bin_dir}:{os.environ['PATH']}"
    )


def test_only_deploy_and_install_of_the_archive_are_kept(tmp_path: Path) -> None:
    tarball = _tarball(
        tmp_path / "release.tar.gz",
        [(f"repo-{REF}/deploy/deploy.sh", b"#\n"), (f"repo-{REF}/install/install.sh", b"#\n"),
         (f"repo-{REF}/src/main.py", b"#\n"), (f"repo-{REF}/deploy.sh", b"#\n"),
         (f"repo-{REF}/.env", b"X=1\n")],
    )  # fmt: skip

    result = _fetch(tmp_path, tarball)

    assert result.returncode == 0, result.stderr
    release = tmp_path / "aap/releases" / REF
    kept = sorted(str(p.relative_to(release)) for p in release.rglob("*") if p.is_file())
    assert kept == ["deploy/deploy.sh", "install/install.sh"]
    assert stat.S_IMODE(release.stat().st_mode) == 0o755
    assert [p.name for p in (tmp_path / "aap/releases").iterdir()] == [REF]  # no .incoming left


def test_an_archive_cannot_write_outside_its_release(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    tarball = _tarball(
        tmp_path / "evil.tar.gz",
        [(f"repo-{REF}/deploy/deploy.sh", b"#\n"), (f"repo-{REF}/install/install.sh", b"#\n"),
         (f"repo-{REF}/deploy/../../../../outside/dotdot.txt", b"pwned\n"),
         (f"repo-{REF}/deploy/link", f"->{outside}"),
         (f"repo-{REF}/deploy/link/through-link.txt", b"pwned\n")],
    )  # fmt: skip

    _fetch(tmp_path, tarball)  # GNU tar refuses such members; the run then stops

    assert list(outside.iterdir()) == []
    release = tmp_path / "aap/releases" / REF
    kept = [str(p.relative_to(release)) for p in release.rglob("*")] if release.exists() else []
    assert set(kept) <= {"deploy", "deploy/deploy.sh", "install", "install/install.sh"}


OLD_COMMIT = [(f"repo-{REF}/deploy/deploy.sh", b"#\n")]  # main before install/ existed


def test_a_commit_without_an_installer_is_refused_and_leaves_nothing(tmp_path: Path) -> None:
    result = _fetch(tmp_path, _tarball(tmp_path / "old.tar.gz", OLD_COMMIT))

    assert result.returncode == 1
    assert list((tmp_path / "aap/releases").iterdir()) == []
    assert (tmp_path / "aap/install.log").read_text().splitlines()[-1].endswith("stopped release")


def test_a_commit_without_an_installer_says_so_instead_of_a_failed_download(
    tmp_path: Path,
) -> None:
    """docs/DEPLOYMENT.md: refusals print one line saying what to fix."""
    result = _fetch(tmp_path, _tarball(tmp_path / "old.tar.gz", OLD_COMMIT))

    assert result.returncode == 1
    assert "has no installer" in result.stderr
    assert "cannot download" not in result.stderr


# --- uninstall.sh --------------------------------------------------------------------------------


def _can_fake_root() -> bool:
    try:
        probe = subprocess.run(["unshare", "-r", "id", "-u"], capture_output=True, text=True)
    except FileNotFoundError:
        return False
    return probe.returncode == 0 and probe.stdout.strip() == "0"


def _uninstall(tmp_path: Path, root: Path) -> subprocess.CompletedProcess[str]:
    """As root in a user namespace, with a stub docker and no systemctl on PATH."""
    bin_dir = tmp_path / "uninstall-bin"
    bin_dir.mkdir()
    for tool in ("bash", "rm", "sort"):
        real = shutil.which(tool)
        assert real, tool
        (bin_dir / tool).symlink_to(real)
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> {shlex.quote(str(tmp_path / "docker.calls"))}\n'
        '[[ "$1 $2" == "image ls" ]] && echo sha256:feed\n'
        "exit 0\n"
    )
    docker.chmod(0o755)
    unshare = shutil.which("unshare")
    assert unshare
    return subprocess.run(
        [unshare, "-r", str(bin_dir / "bash"), str(INSTALL / "uninstall.sh"), "--delete-data",
         "--yes"],
        env={"PATH": str(bin_dir), "AAP_ROOT": str(root)},
        capture_output=True,
        text=True,
    )  # fmt: skip


@pytest.mark.skipif(not _can_fake_root(), reason="needs unprivileged user namespaces")
def test_uninstall_removes_the_installation_its_containers_and_its_image(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    (root / "site").mkdir(parents=True)
    (root / "site/settings.env").write_text("SITE_MODE=real\n")
    # As write_layout of install.sh lays it out.
    (root / "aap.conf").write_text(
        f"AAP_ROOT={root}\nIMAGE=ghcr.io/example/aap\nENVIRONMENTS=site\n"
    )

    result = _uninstall(tmp_path, root)

    assert result.returncode == 0, result.stderr
    assert not root.exists()
    calls = (tmp_path / "docker.calls").read_text().splitlines()
    for project in ("aap-site", "aap-edge"):
        assert f"volume ls -q --filter label=com.docker.compose.project={project}" in calls
    assert "image ls ghcr.io/example/aap -q" in calls
    assert "image rm -f sha256:feed" in calls


@pytest.mark.skipif(not _can_fake_root(), reason="needs unprivileged user namespaces")
def test_uninstall_refuses_a_directory_that_holds_no_installation(tmp_path: Path) -> None:
    unrelated = tmp_path / "srv"
    unrelated.mkdir()
    (unrelated / "important.txt").write_text("not the platform's\n")

    result = _uninstall(tmp_path, unrelated)

    assert (unrelated / "important.txt").exists()
    assert result.returncode != 0


# --- Data committed with the install -------------------------------------------------------------

# Addresses that may appear in examples: documentation, private and loopback ranges, and the
# project's own VPS, which docs/DEPLOYMENT.md publishes.
PUBLISHED = {ipaddress.ip_address("164.68.121.228")}
DOCUMENTATION = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24",
                                                   "203.0.113.0/24")]  # fmt: skip
IPV4 = re.compile(r"(?<![\w.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?![\w-]|\.\d)")


def _example_addresses(text: str) -> set[ipaddress.IPv4Address]:
    found = set()
    for match in IPV4.finditer(text):
        try:
            found.add(ipaddress.IPv4Address(".".join(match.groups())))
        except ValueError:
            continue
    return found


def test_the_address_scan_sees_dashed_and_dotted_forms() -> None:
    assert _example_addresses("x 203-0-113-7.sslip.io and 198.51.100.4, v2.8.4") == {
        ipaddress.IPv4Address("203.0.113.7"),
        ipaddress.IPv4Address("198.51.100.4"),
    }


def test_the_install_examples_use_documentation_addresses_only() -> None:
    files = [
        *sorted(INSTALL.iterdir()),
        REPO_ROOT / "docs/DEPLOYMENT.md",
        REPO_ROOT / "docs/epics/E13_ROLLOUT.md",
        REPO_ROOT / "tests/ops/test_install.py",
    ]
    leaked = {}
    for path in files:
        for address in _example_addresses(path.read_text(encoding="utf-8")):
            allowed = (
                address in PUBLISHED
                or address.is_loopback
                or address.is_unspecified
                or any(address in network for network in DOCUMENTATION)
                or (address.is_private and not address.is_global)
            )
            if not allowed:
                leaked.setdefault(str(path.relative_to(REPO_ROOT)), []).append("<address>")

    assert leaked == {}


# --- The building template (epic E13 R3) ---------------------------------------------------------

TEMPLATE_RUN = REAL_RUN.replace("create_building;", "create_building; write_building_template;")


def test_a_building_found_in_the_register_gets_a_prefilled_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = _stub_docker(tmp_path)

    result = bash(root, f"{TEMPLATE_RUN}; log_line done; finish", **env)

    assert result.returncode == 0, result.stderr
    template = root / "site/building-template.csv"
    assert template.read_bytes() == b"apartment;entrance\r\n2;1\r\n"
    calls = (tmp_path / "docker.calls").read_text()
    assert "building-template --out - --from-register 101036416" in calls
    assert f"import-building --file - --dry-run < {template}" in result.stdout
    assert "left out: part 1 (NON_RESIDENTIAL)" in result.stdout
    assert "building template written" in (root / "install.log").read_text()
    assert not (root / "site/building-template.csv.err").exists()


def test_the_template_is_never_overwritten_and_a_failure_leaves_none(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    (root / "site").mkdir(parents=True)
    (root / "site/building-template.csv").write_text("filled in by the chairman")
    kept = bash(root, TEMPLATE_RUN, **_stub_docker(tmp_path))
    assert kept.returncode == 0, kept.stderr
    assert (root / "site/building-template.csv").read_text() == "filled in by the chairman"

    other = tmp_path / "other"
    failed = bash(
        other, f"{TEMPLATE_RUN}; finish", **_stub_docker(tmp_path, STUB_TEMPLATE_EXIT="3")
    )
    assert failed.returncode == 0, failed.stderr
    assert not (other / "site/building-template.csv").exists()
    assert not (other / "site/building-template.csv.new").exists()
    assert "building-template --out - --from-register 101036416 >" in failed.stdout
    assert "not written (the register does not answer usably" in failed.stdout


def test_a_re_run_never_suggests_writing_over_the_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    (root / "site").mkdir(parents=True)
    template = root / "site/building-template.csv"
    template.write_text("filled in by the chairman")

    # A re-run of an installation whose building exists: no lookup, no new template.
    result = bash(
        root,
        "MODE=real; BUILDING_KNOWN=true; SMTP_HOST=x; SITE_HOST=kyhistu.example.ee; "
        "REF=x; VERSION=v1; finish",
        **_stub_docker(tmp_path),
    )

    assert result.returncode == 0, result.stderr
    assert f"fill in {template} if not done yet" in result.stdout
    assert "building-template --out" not in result.stdout
    assert template.read_text() == "filled in by the chairman"


def test_without_a_register_match_the_next_steps_explain_a_counted_template(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    env = _stub_docker(tmp_path, STUB_FIND_JSON='{"status": "found", "candidates": []}')

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert not (root / "site/building-template.csv").exists()
    assert " building-template " not in (tmp_path / "docker.calls").read_text()
    assert "building-template --out - --apartments <N>" in result.stdout
