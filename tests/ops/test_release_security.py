"""Security and privacy of versioned releases (docs/DEPLOYMENT.md "Versions and releases",
"What gets downloaded", "Running it again, updates and refusals", "The install log and the
screen"; epic E13 task R5b).

Nothing here touches the network or this machine: the release files are built from throw-away
git repositories, the installer's functions are sourced into bash against a temporary AAP_ROOT
with a stub curl, and the tag check of the release workflow runs with stub git and gh.
"""

import io
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest
import yaml

from tests.ops.test_install import EMAIL, INSTALL, PASSWORD, SAFE_ENV, answers, bash
from tests.ops.test_release import BUILD, OLD, WORKFLOW, _build, _git, _installed

REPO_ROOT = INSTALL.parent
NEW = "c" * 40  # the commit of the release under test
VERSION_FILE = f"VERSION=v0.3.0\nCOMMIT={NEW}\n"
LOG_LINE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ (install|rerun|update) [a-z]+( [a-z]+)*")


# --- Helpers -------------------------------------------------------------------------------------


def _archive(path: Path, members: list[tuple]) -> Path:
    """members: (name, bytes) files, (name, "->target") symlinks, (name, "=>target") hard links,
    (name, "/") directories; an optional third item is the mode."""
    with tarfile.open(path, "w:gz") as archive:
        for name, content, *mode in members:
            info = tarfile.TarInfo(name)
            info.mode = mode[0] if mode else 0o644
            if isinstance(content, bytes):
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
                continue
            if content == "/":
                info.type = tarfile.DIRTYPE
                info.mode = mode[0] if mode else 0o755
            elif content.startswith("->"):
                info.type = tarfile.SYMTYPE
                info.linkname = content[2:]
            else:
                info.type = tarfile.LNKTYPE
                info.linkname = content[2:]
            archive.addfile(info)
    return path


def _good(top: str = "aap-v0.3.0", version: str = VERSION_FILE) -> list[tuple]:
    return [
        (f"{top}/VERSION", version.encode()),
        (f"{top}/deploy/deploy.sh", b"#\n"),
        (f"{top}/install/install.sh", b"#\n"),
    ]


def _server(tmp_path: Path, archive: Path | None = None, latest: str | None = None) -> dict:
    """A stub curl: `latest` is the body of the GitHub API's latest release, `archive` the
    release file of every version and the source archive of every commit. Every URL asked for
    is written to curl.calls."""
    bin_dir = tmp_path / "server-bin"
    bin_dir.mkdir(exist_ok=True)
    body = tmp_path / "latest.json"
    body.write_text(latest if latest is not None else "{}")
    served = shlex.quote(str(archive)) if archive else "/nonexistent"
    curl = bin_dir / "curl"
    curl.write_text(
        "#!/bin/sh\nout='' url=''\n"
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -H) shift 2 ;; -*) shift ;; '
        '*) url=$1; shift ;; esac; done\n'
        f'printf "%s\\n" "$url" >> {shlex.quote(str(tmp_path / "curl.calls"))}\n'
        'case "$url" in\n'
        f'  */releases/latest) cat {shlex.quote(str(body))} ;;\n'
        f'  */releases/download/*/aap-release.tar.gz) cat {served} > "$out" || exit 22 ;;\n'
        f'  https://codeload.github.com/*/tar.gz/*) cat {served} > "$out" || exit 22 ;;\n'
        "  *) exit 22 ;;\n"
        "esac\n"
    )  # fmt: skip
    curl.chmod(0o755)
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}


def _calls(tmp_path: Path) -> list[str]:
    calls = tmp_path / "curl.calls"
    return calls.read_text().splitlines() if calls.exists() else []


def _fetch(tmp_path: Path, archive: Path, version: str = "v0.3.0"):
    root = tmp_path / "aap"
    result = bash(
        root,
        f'A_VERSION={version}; fetch_release; echo "REF=$REF"',
        **_server(tmp_path, archive),
    )
    return root, result


def _assert_refused_cleanly(root: Path, result: subprocess.CompletedProcess[str]) -> None:
    """A refusal: exit 1, one line saying what to fix, nothing kept, the log says where."""
    assert result.returncode == 1, (result.stdout, result.stderr)
    # tar may complain first; the installer's own refusal is the last line.
    assert result.stderr.splitlines()[-1].startswith("install: release: "), result.stderr
    assert list((root / "releases").iterdir()) == []  # no release and no .incoming directory
    assert (root / "install.log").read_text().splitlines()[-1].endswith("stopped release")


def _tree(path: Path) -> set[str]:
    return {str(p.relative_to(path)) for p in path.rglob("*")}


# --- build-release.sh: only committed files of deploy/ and install/ ------------------------------


def _minimal_repo(repo: Path) -> str:
    (repo / "deploy").mkdir(parents=True)
    (repo / "install").mkdir()
    (repo / "deploy/deploy.sh").write_text("#!/bin/sh\n")
    (repo / "install/install.sh").write_text('#!/bin/sh\nRELEASE_VERSION=""\n')
    _git(repo, "init", "-q")
    _git(repo, "add", ".")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c")
    return _git(repo, "rev-parse", "HEAD")


def _names(out: Path) -> list[str]:
    with tarfile.open(out / "aap-release.tar.gz") as archive:
        return archive.getnames()


def test_secrets_local_files_and_uncommitted_changes_never_enter_a_release(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _minimal_repo(repo)
    # Committed, but outside deploy/ and install/.
    (repo / ".env").write_text("JWT_SECRET_KEY=committed-by-mistake\n")
    (repo / "local").mkdir()
    (repo / "local/BACKLOG-SECURITY.md").write_text("S-1 private\n")
    (repo / "src").mkdir()
    (repo / "src/deploy.py").write_text("x = 1\n")
    (repo / ".gitignore").write_text("*.key\nsecret.env\n")
    _git(repo, "add", ".")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c2")
    commit = _git(repo, "rev-parse", "HEAD")
    # Ignored, untracked, staged but not committed, and an edit that was never committed.
    (repo / "install/id_ed25519.key").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
    (repo / "deploy/secret.env").write_text("SMTP_PASSWORD=ignored\n")
    (repo / "deploy/hosts").mkdir()
    (repo / "deploy/hosts/new.env").write_text("TOKEN=untracked\n")
    (repo / "install/staged.env").write_text("TOKEN=staged\n")
    _git(repo, "add", "install/staged.env")
    (repo / "install/install.sh").write_text('#!/bin/sh\nRELEASE_VERSION=""\nLEAK=uncommitted\n')
    out = tmp_path / "dist"

    result = _build(repo, out, "v0.3.0", commit)

    assert result.returncode == 0, result.stderr
    assert sorted(_names(out)) == [
        "aap-v0.3.0",
        "aap-v0.3.0/VERSION",
        "aap-v0.3.0/deploy",
        "aap-v0.3.0/deploy/deploy.sh",
        "aap-v0.3.0/install",
        "aap-v0.3.0/install/install.sh",
    ]
    assert "LEAK" not in (out / "install.sh").read_text()
    assert sorted(p.name for p in out.iterdir()) == ["aap-release.tar.gz", "install.sh"]


def test_a_release_of_this_repository_holds_no_key_token_secret_value_or_real_e_mail(
    tmp_path: Path,
) -> None:
    """Built from the committed HEAD of this repository, as the workflow does."""
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    head = _git(REPO_ROOT, "rev-parse", "HEAD")
    if 'RELEASE_VERSION=""' not in _git(REPO_ROOT, "show", f"{head}:install/install.sh"):
        pytest.skip("HEAD predates versioned releases")
    out = tmp_path / "dist"
    result = subprocess.run(
        ["bash", str(BUILD), "v0.3.0", head, str(out)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env={**SAFE_ENV, "TMPDIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr

    secret_value = re.compile(
        r"^(POSTGRES_PASSWORD|JWT_SECRET_KEY|AUTH_HASH_SECRET|NOTIFICATIONS_HASH_SECRET|"
        r"SMTP_PASSWORD|GH_TOKEN|GITHUB_TOKEN)=['\"]?[A-Za-z0-9+/_-]{8,}",
        re.MULTILINE,
    )
    keys = re.compile(r"BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|github_pat_|AKIA[0-9A-Z]{16}")
    e_mail = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[a-z]{2,}")
    with tarfile.open(out / "aap-release.tar.gz") as archive:
        for member in archive.getmembers():
            parts = member.name.split("/")
            assert parts[0] == "aap-v0.3.0"
            assert len(parts) == 1 or parts[1] in {"deploy", "install", "VERSION"}, member.name
            assert member.isfile() or member.isdir(), member.name  # no links, no devices
            assert not member.mode & (stat.S_ISUID | stat.S_ISGID | stat.S_IWOTH), member.name
            if not member.isfile():
                continue
            name = parts[-1]
            if name.endswith(".env") or name.startswith(".env"):
                assert parts[2] in {"environments", "hosts"}, member.name  # settings, no secrets
            text = archive.extractfile(member).read().decode(errors="replace")  # type: ignore[union-attr]
            assert not secret_value.search(text), member.name
            assert not keys.search(text), member.name
            for found in e_mail.finditer(text):
                domain = found.group(0).rsplit("@", 1)[1]
                assert domain.startswith("example.") or ".example." in domain, (member.name, found)


@pytest.mark.parametrize(
    "version",
    [
        "v1.2.3;touch PWNED",
        "v1.2.3$(touch PWNED)",
        "v1.2.3`touch PWNED`",
        "v1.2.3\nRELEASE_VERSION=x",
        "v1.2.3/../../x",
        "../v1.2.3",
        "v1.2.3 ",
        "v1.2.3.4",
        "v1.2.3-rc1",
    ],
)
def test_a_version_with_shell_syntax_or_a_path_builds_nothing_and_runs_nothing(
    tmp_path: Path, version: str
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    commit = _minimal_repo(repo)
    out = tmp_path / "dist"

    result = _build(repo, out, version, commit)

    assert result.returncode != 0
    assert not out.exists()
    assert not (repo / "PWNED").exists() and not (tmp_path / "PWNED").exists()


@pytest.mark.parametrize("commit", ["HEAD", "$(touch PWNED)", "C" * 40, "c" * 39, "main"])
def test_a_commit_that_is_not_a_full_lowercase_id_builds_nothing(
    tmp_path: Path, commit: str
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _minimal_repo(repo)
    out = tmp_path / "dist"

    result = _build(repo, out, "v0.3.0", commit)

    assert result.returncode != 0
    assert not out.exists()
    assert not (repo / "PWNED").exists()


# --- The release workflow ------------------------------------------------------------------------


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def _check_script() -> str:
    steps = _workflow()["jobs"]["release"]["steps"]
    return next(step["run"] for step in steps if step.get("id") == "check")


STUB_GIT = """#!/bin/bash
printf 'git %s\\n' "$*" >> "$STUB_CALLS"
case "$1" in
    fetch) exit 0 ;;
    rev-parse) echo "$STUB_COMMIT" ;;
    merge-base) exit "$STUB_ON_MAIN" ;;
    *) exit 1 ;;
esac
"""

STUB_GH = """#!/bin/bash
printf 'gh %s\\n' "$*" >> "$STUB_CALLS"
if [[ "$*" == *"-X DELETE"* ]]; then exit 0; fi
printf '%s' "$STUB_RELEASES"
"""


def _run_check(
    tmp_path: Path, version: str, releases: list[str], on_main: bool = True
) -> tuple[subprocess.CompletedProcess[str], list[str], str]:
    bin_dir = tmp_path / "gh-bin"
    bin_dir.mkdir()
    for name, text in (("git", STUB_GIT), ("gh", STUB_GH)):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    script = tmp_path / "check.sh"
    script.write_text(_check_script())
    output = tmp_path / "github_output"
    output.write_text("")
    calls = tmp_path / "calls"
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],  # as GitHub runs it
        cwd=tmp_path,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "VERSION": version,
            "GH_TOKEN": "token-must-never-show",
            "GITHUB_REPOSITORY": "Owner/Repo",
            "GITHUB_OUTPUT": str(output),
            "STUB_CALLS": str(calls),
            "STUB_COMMIT": NEW,
            "STUB_ON_MAIN": "0" if on_main else "1",
            "STUB_RELEASES": "".join(f"{line}\n" for line in releases),
        },
        capture_output=True,
        text=True,
    )
    assert "token-must-never-show" not in result.stdout + result.stderr
    made = calls.read_text().splitlines() if calls.exists() else []
    return result, made, output.read_text()


def test_the_tag_check_publishes_a_new_highest_version_of_main(tmp_path: Path) -> None:
    result, calls, output = _run_check(
        tmp_path, "v0.11.0", ["false v0.2.0 1", "false v0.10.0 2", "false nightly 3"]
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert output.splitlines() == [f"commit={NEW}", "image=ghcr.io/owner/repo"]
    assert not any("DELETE" in call for call in calls)


@pytest.mark.parametrize(
    ("version", "releases", "on_main", "says"),
    [
        ("v0.4.0", ["false v0.3.0 1"], False, "not a commit of main"),
        ("v0.3.0", ["false v0.3.0 1"], True, "published already"),
        ("v0.9.0", ["false v0.10.0 1"], True, "the highest is v0.10.0"),
        ("v0.3.0", ["false v0.3.1 1", "false v0.2.0 2"], True, "the highest is v0.3.1"),
    ],
)
def test_the_tag_check_refuses_a_tag_off_main_a_published_or_a_lower_version(
    tmp_path: Path, version: str, releases: list[str], on_main: bool, says: str
) -> None:
    result, calls, output = _run_check(
        tmp_path, version, [*releases, f"true {version} 9"], on_main=on_main
    )

    assert result.returncode == 1
    assert says in result.stdout
    assert output == ""
    assert not any("DELETE" in call for call in calls)  # a refused run deletes no draft


def test_a_draft_of_the_same_version_is_deleted_by_its_id_and_other_drafts_are_kept(
    tmp_path: Path,
) -> None:
    result, calls, _ = _run_check(
        tmp_path, "v0.4.0", ["false v0.3.0 1", "true v0.4.0 7", "true v0.9.0 8"]
    )

    assert result.returncode == 0, result.stdout + result.stderr
    deletes = [call for call in calls if "DELETE" in call]
    assert deletes == ["gh api -X DELETE repos/Owner/Repo/releases/7"]


@pytest.mark.parametrize(
    "version",
    [
        "v1.2.3;touch PWNED",
        "v1.2.3$(touch PWNED)",
        "v1.2.3`touch PWNED`",
        'v1.2.3"; touch PWNED; "',
        "v1.2.3\ntouch PWNED",
        "v1.2.3/../../x",
        "v1.2.3-rc1",
        "v1.2",
        "1.2.3",
    ],
)
def test_the_tag_check_refuses_a_tag_with_shell_syntax_before_any_git_or_api_call(
    tmp_path: Path, version: str
) -> None:
    result, calls, output = _run_check(tmp_path, version, [])

    assert result.returncode == 1
    assert "A version tag looks like v1.2.3" in result.stdout
    assert calls == []
    assert output == ""
    assert not (tmp_path / "PWNED").exists()


def test_the_workflow_never_prints_or_hands_the_token_to_a_script() -> None:
    workflow = _workflow()
    job = workflow["jobs"]["release"]
    scripts = [step["run"] for step in job["steps"] if "run" in step]

    for script in scripts:
        assert "set -x" not in script
        assert "TOKEN" not in script  # gh reads GH_TOKEN itself; no script echoes or writes it
        assert "secrets." not in script
    # The tag name reaches a script only through the environment: not in names a script sees.
    for step in job["steps"]:
        for value in (step.get("env") or {}).values():
            assert "github.ref_name" not in value or step.get("run") is None
    assert job["env"]["VERSION"] == "${{ github.ref_name }}"
    # Only the login action gets the token as an input; no step uploads files other than dist/.
    with_token = [s for s in job["steps"] if "secrets.GITHUB_TOKEN" in json.dumps(s.get("with"))]
    assert [s["uses"].split("@")[0] for s in with_token] == ["docker/login-action"]
    assert not any("upload-artifact" in step.get("uses", "") for step in job["steps"])
    assert set(workflow[True]) == {"push"}  # never pull_request_target or workflow_run


# --- The downloaded archive: refused or contained ------------------------------------------------


def test_a_valid_archive_is_kept_as_its_release(tmp_path: Path) -> None:
    root, result = _fetch(tmp_path, _archive(tmp_path / "a.tar.gz", _good()))

    assert result.returncode == 0, result.stderr
    assert f"REF={NEW}" in result.stdout
    assert _tree(root / "releases") == {
        NEW,
        f"{NEW}/VERSION",
        f"{NEW}/deploy",
        f"{NEW}/deploy/deploy.sh",
        f"{NEW}/install",
        f"{NEW}/install/install.sh",
    }


@pytest.mark.parametrize(
    "evil",
    [
        [("aap-v0.3.0/deploy/../../../../outside/dotdot.txt", b"pwned\n")],
        [("aap-v0.3.0/../outside/dotdot.txt", b"pwned\n")],
        [("aap-v0.3.0/deploy/link", "->{outside}"), ("aap-v0.3.0/deploy/link/x.txt", b"pwned\n")],
        [("aap-v0.3.0/install/up", "->../../../../outside"), ("aap-v0.3.0/install/up/x", b"p\n")],
        [("aap-v0.3.0/deploy/hard", "=>{outside}/secret.txt"),
         ("aap-v0.3.0/deploy/hard", b"overwritten\n")],
    ],
)  # fmt: skip
def test_an_archive_never_writes_outside_the_releases_directory(
    tmp_path: Path, evil: list[tuple]
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("keep\n")
    members = [
        (name, content.format(outside=outside) if isinstance(content, str) else content)
        for name, content in evil
    ]

    root, _ = _fetch(tmp_path, _archive(tmp_path / "evil.tar.gz", [*_good(), *members]))

    assert sorted(p.name for p in outside.iterdir()) == ["secret.txt"]
    assert (outside / "secret.txt").read_text() == "keep\n"
    assert {p.name for p in root.iterdir()} <= {"releases", "install.log"}
    for path in (root / "releases").rglob("*"):
        assert not path.is_symlink() or not path.resolve().is_relative_to(outside), path


def test_an_archive_with_absolute_member_names_stays_inside_the_releases_directory(
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    members = [(f"{outside}/deploy/x.sh", b"pwned\n"), (f"/{outside.name}/install/y", b"p\n")]

    root, _ = _fetch(tmp_path, _archive(tmp_path / "abs.tar.gz", [*_good(), *members]))

    assert list(outside.iterdir()) == []
    assert {p.name for p in root.iterdir()} <= {"releases", "install.log"}


@pytest.mark.parametrize(
    "version_file",
    [
        f"VERSION=$(touch {{pwned}})\nCOMMIT={NEW}\n",
        f"VERSION=v0.3.0$(touch {{pwned}})\nCOMMIT={NEW}\n",
        "VERSION=v0.3.0\nCOMMIT=$(touch {pwned})\n",
        f"VERSION=v0.3.0\nCOMMIT={NEW};touch {{pwned}}\n",
        f"VERSION=v0.3.0\nCOMMIT=`touch {{pwned}}`{NEW}\n",
        f"VERSION=v0.3.0\nCOMMIT={NEW}/../../x\n",
        f"VERSION=v0.3.0\nCOMMIT={NEW.upper()}\n",
        f"VERSION=v0.3.0\nCOMMIT={NEW[:39]}\n",
        f"VERSION=v0.3.0\nCOMMIT={NEW}0\n",
        f"VERSION=v0.3.0\r\nCOMMIT={NEW}\r\n",
        f"VERSION=v0.3.0 \nCOMMIT={NEW}\n",
        f"VERSION=v0.3.1\nCOMMIT={NEW}\n",
        f"VERSION=V0.3.0\nCOMMIT={NEW}\n",
        f"COMMIT={NEW}\n",
        "VERSION=v0.3.0\n",
        "",
    ],
)
def test_a_version_file_that_is_not_exactly_that_of_the_release_is_refused_and_never_run(
    tmp_path: Path, version_file: str
) -> None:
    pwned = tmp_path / "PWNED"
    text = version_file.format(pwned=pwned)

    root, result = _fetch(tmp_path, _archive(tmp_path / "v.tar.gz", _good(version=text)))

    _assert_refused_cleanly(root, result)
    assert "not a release of that version" in result.stderr
    assert not pwned.exists()


@pytest.mark.parametrize(
    "broken",
    [
        [("aap-v0.3.0/VERSION", "/"), ("aap-v0.3.0/VERSION/x", b"VERSION=v0.3.0\n")],
        [("aap-v0.3.0/VERSION", "->/nonexistent/VERSION")],
    ],
    ids=["a directory", "a dangling symlink"],
)
def test_a_version_file_that_cannot_be_read_is_a_clean_refusal(
    tmp_path: Path, broken: list[tuple]
) -> None:
    """docs/DEPLOYMENT.md: refusals print one line saying what to fix; nothing is kept."""
    members = [*_good()[1:], *broken]

    root, result = _fetch(tmp_path, _archive(tmp_path / "b.tar.gz", members))

    _assert_refused_cleanly(root, result)


@pytest.mark.parametrize(
    "extra",
    [
        "aap-v0.3.0/src/deploy/evil.sh",
        "aap-v0.3.0/src/install/evil.sh",
        "aap-v0.3.0/notes/VERSION",
    ],
)
def test_only_deploy_install_and_version_of_a_version_archive_are_kept(
    tmp_path: Path, extra: str
) -> None:
    """docs/DEPLOYMENT.md "What gets downloaded": keeps only deploy/, install/ and VERSION."""
    members = [*_good(), (extra, b"#\n"), ("aap-v0.3.0/.env", b"X=1\n"), ("aap-v0.3.0/src/a", b"")]

    root, result = _fetch(tmp_path, _archive(tmp_path / "x.tar.gz", members))

    assert result.returncode == 0, result.stderr
    kept = {p.name for p in (root / "releases" / NEW).iterdir()}
    assert kept == {"VERSION", "deploy", "install"}


def test_only_deploy_and_install_of_a_commit_archive_are_kept_at_any_depth(tmp_path: Path) -> None:
    """docs/DEPLOYMENT.md "What gets downloaded": of a commit only deploy/ and install/ are kept."""
    top = f"repo-{NEW}"
    archive = _archive(
        tmp_path / "c.tar.gz",
        [(f"{top}/deploy/deploy.sh", b"#\n"), (f"{top}/install/install.sh", b"#\n"),
         (f"{top}/frontend/deploy/nginx.conf", b"#\n"), (f"{top}/docs/install/x.md", b"#\n")],
    )  # fmt: skip
    root = tmp_path / "aap"

    result = bash(root, f"REF={NEW}; fetch_release", **_server(tmp_path, archive))

    assert result.returncode == 0, result.stderr
    assert {p.name for p in (root / "releases" / NEW).iterdir()} == {"deploy", "install"}


def _empty_tar_gz(path: Path) -> Path:
    with tarfile.open(path, "w:gz"):
        pass
    return path


@pytest.mark.parametrize("kind", ["empty file", "empty archive", "not gzip", "truncated"])
def test_an_empty_or_broken_archive_is_refused_and_leaves_nothing(
    tmp_path: Path, kind: str
) -> None:
    path = tmp_path / "broken.tar.gz"
    if kind == "empty file":
        path.write_bytes(b"")
    elif kind == "empty archive":
        _empty_tar_gz(path)
    elif kind == "not gzip":
        path.write_bytes(b"<html>Not Found</html>\n")
    else:
        whole = _archive(
            tmp_path / "whole.tar.gz", [*_good(), ("aap-v0.3.0/deploy/big", b"x" * 50000)]
        )
        path.write_bytes(whole.read_bytes()[:200])

    root, result = _fetch(tmp_path, path)

    _assert_refused_cleanly(root, result)
    assert "cannot download version v0.3.0" in result.stderr


def test_an_archive_without_the_installer_or_deploy_script_is_refused(tmp_path: Path) -> None:
    for missing in ("deploy/deploy.sh", "install/install.sh"):
        case = tmp_path / missing.split("/")[0]
        case.mkdir()
        members = [m for m in _good() if not m[0].endswith(missing)]
        members.append((f"aap-v0.3.0/{missing.split('/')[0]}/other.sh", b"#\n"))

        root, result = _fetch(case, _archive(case / "m.tar.gz", members))

        _assert_refused_cleanly(root, result)


# --- tag_name from the GitHub API ----------------------------------------------------------------


@pytest.mark.parametrize(
    "tag",
    [
        "v1.2.3; touch {pwned}",
        "$(touch {pwned})",
        "v1.2.3$(touch {pwned})",
        "`touch {pwned}`",
        "../../v1.2.3",
        "v1.2.3/../../../x",
        "v1.2.3\nv1.2.4",
        'v1.2.3"; touch {pwned}; "',
        "v1.2.3 ",
        " v1.2.3",
        "v1.2.3.4",
        "v1.2.3-rc1",
        "1.2.3",
        "",
    ],
)
def test_a_latest_release_tag_that_is_not_a_version_is_never_used(tmp_path: Path, tag: str) -> None:
    pwned = tmp_path / "PWNED"
    body = json.dumps({"url": "x", "tag_name": tag.format(pwned=pwned), "draft": False}, indent=2)
    root = tmp_path / "aap"

    result = bash(root, "latest_version", **_server(tmp_path, latest=body))

    assert result.returncode == 1
    assert result.stdout == ""
    assert "cannot find the latest version" in result.stderr
    assert _calls(tmp_path) == [
        "https://api.github.com/repos/Chemoday/apartment-association-platform/releases/latest"
    ]
    assert not pwned.exists()


@pytest.mark.parametrize("indent", [None, 2])
def test_the_latest_version_is_the_release_tag_not_a_tag_name_quoted_in_its_notes(
    tmp_path: Path, indent: int | None
) -> None:
    body = json.dumps(
        {"body": 'Use "tag_name": "v9.9.9" ...', "name": "v9.9.8", "tag_name": "v0.3.0"},
        indent=indent,
    )

    result = bash(tmp_path / "aap", "latest_version", **_server(tmp_path, latest=body))

    assert result.returncode == 0, result.stderr
    assert result.stdout == "v0.3.0\n"


def test_update_with_a_bad_latest_tag_downloads_nothing_and_logs_only_the_step(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.2.0")
    pwned = tmp_path / "PWNED"
    body = json.dumps({"tag_name": f"v0.3.0$(touch {pwned})"})
    archive = _archive(tmp_path / "a.tar.gz", _good())

    result = _update(root, _server(tmp_path, archive, latest=body))

    assert result.returncode == 1
    assert not any("/releases/download/" in call for call in _calls(tmp_path))
    assert not pwned.exists()
    assert (root / "install.log").read_text().splitlines()[-1].endswith("update stopped release")
    assert [p.name for p in (root / "releases").iterdir()] == [OLD]


# --- update.sh arguments -------------------------------------------------------------------------


def _update(root: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    (root / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copy(INSTALL / "install.sh", root / "bin/install.sh")
    # A clean environment: only what update.sh itself hands on can reach the next installer.
    clean = {"PATH": os.environ["PATH"], "HOME": str(root.parent), "LANG": "C.UTF-8"}
    return subprocess.run(
        ["bash", str(INSTALL / "update.sh"), *args],
        env={**clean, **env, "AAP_ROOT": str(root)},
        capture_output=True,
        text=True,
        cwd=root.parent,
    )


@pytest.mark.parametrize(
    "args",
    [
        ["v1.2.3.4"],
        ["1.2.3"],
        ["V1.2.3"],
        ["v1.2"],
        ["v1.2.3-rc1"],
        ["v1.2.3;touch PWNED"],
        ["$(touch PWNED)"],
        ["v1.2.3\ntouch PWNED"],
        ["../../etc"],
        ["v1.2.3/../x"],
        ["A" * 40],
        ["a" * 39],
        ["a" * 41],
        ["v0.3.0", "v0.4.0"],
        ["v0.3.0", "a" * 40],
        ["--allow-downgrade=yes"],
        ["--allow-downgrade", "-x"],
        ["--", "v0.3.0"],
        ["--version", "v0.3.0"],
        ["--ref", "a" * 40],
    ],
)
def test_update_refuses_odd_arguments_before_it_reads_or_downloads_anything(
    tmp_path: Path, args: list[str]
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.2.0")
    archive = _archive(tmp_path / "a.tar.gz", _good())

    result = _update(root, _server(tmp_path, archive, latest='{"tag_name": "v0.3.0"}'), *args)

    assert result.returncode == 2
    assert result.stderr.startswith("usage: update.sh")
    assert _calls(tmp_path) == []
    assert not (root / "install.log").exists()
    assert not (tmp_path / "PWNED").exists() and not (root.parent / "PWNED").exists()


def _next_installer(tmp_path: Path, version: str = "v0.3.0") -> Path:
    """A release whose installer prints how it was started and what it inherited."""
    text = f"VERSION={version}\nCOMMIT={NEW}\n"
    installer = b'printf "next installer: %s\\n" "$*"; env > "$NEXT_ENV"\n'
    return _archive(
        tmp_path / "next.tar.gz",
        [
            (f"aap-{version}/VERSION", text.encode()),
            (f"aap-{version}/deploy/deploy.sh", b"#\n"),
            (f"aap-{version}/install/install.sh", installer),
        ],
    )


@pytest.mark.parametrize(
    "args",
    [["--allow-downgrade", "v0.3.0"], ["v0.3.0", "--allow-downgrade"]],
    ids=["flag first", "flag last"],
)
def test_allow_downgrade_works_before_or_after_the_version(tmp_path: Path, args: list[str]) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.4.0")
    env = {**_server(tmp_path, _next_installer(tmp_path)), "NEXT_ENV": str(tmp_path / "env")}

    result = _update(root, env, *args)

    assert result.returncode == 0, result.stderr
    assert f"next installer: --yes --ref {NEW}" in result.stdout


def test_a_downgrade_refusal_is_one_line_and_the_log_holds_only_the_step(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.4.0")
    env = _server(tmp_path, _next_installer(tmp_path))

    result = _update(root, env, "v0.3.0")

    assert result.returncode == 1
    assert result.stderr.count("\n") == 1
    assert "--allow-downgrade" in result.stderr
    assert _calls(tmp_path) == []
    steps = [line.split(" ", 2)[2] for line in (root / "install.log").read_text().splitlines()]
    assert steps == ["stopped release"]


def _private_installation(root: Path, sha: str, version: str | None) -> None:
    """An installation with an SMTP password, a chairman-like e-mail and a mail sender."""
    _installed(root, sha, version)
    values = {
        "SMTP_HOST": "smtp.example.ee",
        "SMTP_PORT": "587",
        "SMTP_USERNAME": EMAIL,
        "SMTP_FROM": EMAIL,
        "SMTP_PASSWORD_NEW": PASSWORD,
    }
    result = bash(root, f"load_previous; {answers(**values)}; write_secrets; write_settings")
    assert result.returncode == 0, result.stderr
    (root / "site/current_sha").write_text(f"{sha}\n")
    (root / "install.log").unlink(missing_ok=True)


def _assert_private(root: Path, *outputs: str) -> None:
    log_file = root / "install.log"
    log = log_file.read_text() if log_file.exists() else ""
    for line in log.splitlines():
        assert LOG_LINE.match(line), line
    for text in (log, *outputs):
        for private in (PASSWORD, EMAIL, "smtp-pass", "chair.person"):
            assert private not in text


def test_the_next_installer_gets_no_settings_or_secrets_through_its_arguments_or_environment(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    _private_installation(root, OLD, "v0.2.0")
    env = {**_server(tmp_path, _next_installer(tmp_path)), "NEXT_ENV": str(tmp_path / "env")}

    result = _update(root, env, "v0.3.0")

    assert result.returncode == 0, result.stderr
    inherited = dict(
        line.split("=", 1) for line in (tmp_path / "env").read_text().splitlines() if "=" in line
    )
    given = {"PATH", "HOME", "LANG", "AAP_ROOT", "NEXT_ENV"}
    added = set(inherited) - given - {"PWD", "OLDPWD", "SHLVL", "_"}
    assert added == {"AAP_RUN_KIND"}
    assert inherited["AAP_RUN_KIND"] == "update"
    for value in inherited.values():
        assert PASSWORD not in value and EMAIL not in value
    _assert_private(root, result.stdout, result.stderr)


def test_nothing_to_do_and_the_version_note_show_no_secret_or_e_mail(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    archive = _archive(tmp_path / "a.tar.gz", _good())
    env = _server(tmp_path, archive, latest='{"tag_name": "v0.3.0"}')
    first = bash(root, "A_VERSION=v0.3.0; fetch_release", **env)
    assert first.returncode == 0, first.stderr
    _private_installation(root, NEW, None)
    (root / f"releases/{NEW}/VERSION").write_text(VERSION_FILE)

    update = _update(root, env)
    baked = tmp_path / "install-v0.4.0.sh"
    baked.write_text(
        (INSTALL / "install.sh")
        .read_text()
        .replace('RELEASE_VERSION=""', 'RELEASE_VERSION="v0.4.0"')
    )
    note = subprocess.run(
        ["bash", "-c", f"source {shlex.quote(str(baked))}; load_previous; resolve_release"],
        env={**SAFE_ENV, **env, "AAP_ROOT": str(root)},
        capture_output=True,
        text=True,
    )

    assert update.returncode == 0, update.stderr
    assert "runs v0.3.0 already" in update.stdout
    assert note.returncode == 0, note.stderr
    assert "this installer is of v0.4.0" in note.stdout
    assert (
        (root / "install.log")
        .read_text()
        .splitlines()[-1]
        .endswith(f" update nothing to do sha={NEW}")
    )
    _assert_private(root, update.stdout, update.stderr, note.stdout, note.stderr)


@pytest.mark.parametrize(("version", "shown"), [("v0.3.0", "v0.3.0"), (None, "")])
def test_a_healthy_deploy_logs_only_the_commit_and_the_version(
    tmp_path: Path, version: str | None, shown: str
) -> None:
    root = tmp_path / "aap"
    _private_installation(root, NEW, version)
    (root / f"releases/{NEW}/deploy/deploy.sh").write_text("echo deployed\n")
    (root / "aap.conf").write_text("ENVIRONMENTS=site\n")

    result = bash(
        root, f"RUN_KIND=update; VERSION=$(release_version {NEW}); REF={NEW}; deploy_release"
    )

    assert result.returncode == 0, result.stderr
    line = (root / "install.log").read_text().splitlines()[-1]
    assert re.fullmatch(
        rf"\d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\dZ update deploy ok sha={NEW} version={shown}", line
    ), line
    _assert_private(root, result.stdout, result.stderr)


# --- The downgrade guard and the installed release's VERSION file --------------------------------


@pytest.mark.parametrize(
    "installed_file",
    [
        "VERSION=$(touch {pwned})\nCOMMIT=" + OLD + "\n",
        "VERSION=`touch {pwned}`\n",
        "VERSION=v0.4.0;touch {pwned}\n",
    ],
)
def test_an_installed_version_file_with_shell_syntax_is_never_run(
    tmp_path: Path, installed_file: str
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, None)
    pwned = tmp_path / "PWNED"
    (root / f"releases/{OLD}/VERSION").write_text(installed_file.format(pwned=pwned))

    result = bash(
        root,
        f"load_previous; check_forward v0.1.0; v=$(release_version {OLD}); "
        f'echo "[$v] $(describe_release {OLD} "$v")"',
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"[] commit {OLD[:12]}"
    assert not pwned.exists()


@pytest.mark.parametrize(
    "version_file",
    [
        f"VERSION=v0.4.0\nCOMMIT={NEW}\n",
        f"COMMIT={NEW}\nVERSION=v0.4.0\n",
        f"VERSION=v0.4.0\nVERSION=v0.1.0\nCOMMIT={NEW}\n",
        f"# release\nVERSION=v0.4.0\nCOMMIT={NEW}\nCOMMIT={OLD}\n",
    ],
)
def test_every_version_file_the_download_accepts_is_one_the_downgrade_guard_compares(
    tmp_path: Path, version_file: str
) -> None:
    """A release that was accepted as v0.4.0 can never be taken for a commit (not compared)."""
    root = tmp_path / "aap"
    archive = _archive(tmp_path / "a.tar.gz", _good("aap-v0.4.0", version_file))
    fetched = bash(root, "A_VERSION=v0.4.0; fetch_release; echo $REF", **_server(tmp_path, archive))
    assert fetched.returncode == 0, fetched.stderr
    assert fetched.stdout.split()[-1] == NEW
    (root / "site").mkdir()
    (root / "site/settings.env").write_text("SITE_HOST=kyhistu.example.ee\n")
    (root / "site/current_sha").write_text(f"{NEW}\n")

    result = bash(root, "load_previous; ALLOW_DOWNGRADE=false; check_forward v0.3.9")

    assert result.returncode == 1
    assert "older than the installed v0.4.0" in result.stderr
