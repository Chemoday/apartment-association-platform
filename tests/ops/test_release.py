"""Versioned releases (docs/DEPLOYMENT.md "Versions and releases", epic E13 task R5b).

The release files are built from a throw-away git repository holding this checkout's deploy/ and
install/. The installer's functions are sourced into bash against a temporary AAP_ROOT with a stub
curl that serves those files, so nothing is downloaded and nothing on this machine is touched.
"""

import io
import os
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest
import yaml

from tests.ops.test_install import INSTALL, SAFE_ENV, answers, bash

REPO_ROOT = INSTALL.parent
BUILD = REPO_ROOT / ".github/scripts/build-release.sh"
WORKFLOW = REPO_ROOT / ".github/workflows/release.yml"
OLD = "b" * 40  # a release installed before


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture(scope="module")
def source(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, str]:
    """A repository with one commit of this checkout's deploy/ and install/."""
    repo = tmp_path_factory.mktemp("repo")
    for name in ("deploy", "install"):
        shutil.copytree(REPO_ROOT / name, repo / name, ignore=shutil.ignore_patterns("__pycache__"))
    (repo / "README.md").write_text("not part of a release\n")
    _git(repo, "init", "-q")
    _git(repo, "add", ".")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c")
    return repo, _git(repo, "rev-parse", "HEAD")


def _build(repo: Path, out: Path, version: str, commit: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(BUILD), version, commit, str(out)],
        cwd=repo,
        capture_output=True,
        text=True,
    )


@pytest.fixture(scope="module")
def release(source: tuple[Path, str], tmp_path_factory: pytest.TempPathFactory) -> Path:
    repo, commit = source
    out = tmp_path_factory.mktemp("dist")
    result = _build(repo, out, "v0.3.0", commit)
    assert result.returncode == 0, result.stderr
    return out


# --- build-release.sh ----------------------------------------------------------------------------


def test_the_release_holds_deploy_install_and_its_version(
    release: Path, source: tuple[Path, str]
) -> None:
    _, commit = source
    with tarfile.open(release / "aap-release.tar.gz") as archive:
        names = archive.getnames()
        version = archive.extractfile("aap-v0.3.0/VERSION").read().decode()  # type: ignore[union-attr]
        members = archive.getmembers()

    assert version == f"VERSION=v0.3.0\nCOMMIT={commit}\n"
    tops = {name.split("/")[1] for name in names if "/" in name}
    assert tops == {"deploy", "install", "VERSION"}
    # The files of the project's own VPS are no part of an install.
    assert not any(
        n.startswith(("aap-v0.3.0/deploy/hosts", "aap-v0.3.0/deploy/HOST_")) for n in names
    )
    assert all(name.startswith("aap-v0.3.0") for name in names)
    assert "aap-v0.3.0/deploy/deploy.sh" in names
    assert all(m.uid == 0 and m.gid == 0 and not m.uname for m in members)


def test_the_installer_of_a_release_differs_only_by_its_version(release: Path) -> None:
    baked = (release / "install.sh").read_text().splitlines()
    original = (INSTALL / "install.sh").read_text().splitlines()

    changed = [(a, b) for a, b in zip(original, baked, strict=True) if a != b]
    assert changed == [('RELEASE_VERSION=""', 'RELEASE_VERSION="v0.3.0"')]
    with tarfile.open(release / "aap-release.tar.gz") as archive:
        inner = archive.extractfile("aap-v0.3.0/install/install.sh").read().decode()  # type: ignore[union-attr]
    assert inner == (release / "install.sh").read_text()
    assert os.access(release / "install.sh", os.X_OK)


def test_the_same_commit_builds_the_same_archive(
    release: Path, source: tuple[Path, str], tmp_path: Path
) -> None:
    repo, commit = source
    assert _build(repo, tmp_path, "v0.3.0", commit).returncode == 0

    assert (tmp_path / "aap-release.tar.gz").read_bytes() == (
        release / "aap-release.tar.gz"
    ).read_bytes()


def test_the_release_holds_only_committed_files(source: tuple[Path, str], tmp_path: Path) -> None:
    repo, commit = source
    (repo / "deploy/uncommitted.env").write_text("SECRET=1\n")
    try:
        assert _build(repo, tmp_path, "v0.3.1", commit).returncode == 0
    finally:
        (repo / "deploy/uncommitted.env").unlink()

    with tarfile.open(tmp_path / "aap-release.tar.gz") as archive:
        assert not any(name.endswith("uncommitted.env") for name in archive.getnames())


@pytest.mark.parametrize(
    ("version", "commit"),
    [
        ("0.3.0", None),
        ("v0.3", None),
        ("v01.2.3", None),
        ("v0.3.0-rc1", None),
        ("v0.3.0", "abc"),
        ("v0.3.0", "c" * 40),
    ],
)
def test_a_bad_version_or_commit_builds_nothing(
    source: tuple[Path, str], tmp_path: Path, version: str, commit: str | None
) -> None:
    repo, head = source
    out = tmp_path / "dist"

    result = _build(repo, out, version, commit or head)

    assert result.returncode != 0
    assert not out.exists()


# --- The release workflow ------------------------------------------------------------------------


def test_the_workflow_runs_on_version_tags_and_keeps_the_tag_out_of_its_scripts() -> None:
    text = WORKFLOW.read_text()
    workflow = yaml.safe_load(text)

    assert workflow[True] == {"push": {"tags": ["v*"]}}  # YAML reads the key `on` as true
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["release"]["permissions"] == {"contents": "write", "packages": "write"}
    assert "build-release.sh" in text
    assert "imagetools create" in text  # the image CI built, never a rebuild
    assert "docker/build-push-action" not in text
    release = workflow["jobs"]["release"]
    assert "GH_TOKEN" not in release["env"]  # only the steps that call GitHub get the token
    assert release["steps"][0]["with"]["persist-credentials"] is False
    assert "git tag --points-at" in text  # one version per commit
    # The tag name reaches the shell only through the environment, after its check.
    scripts = [step["run"] for step in workflow["jobs"]["release"]["steps"] if "run" in step]
    assert len(scripts) == 5
    for script in scripts:
        assert "${{" not in script


def test_the_workflow_compares_only_with_published_releases() -> None:
    """A draft or tag of a failed run never blocks its re-run (docs/DEPLOYMENT.md)."""
    text = WORKFLOW.read_text()

    assert '$1 == "false"' in text  # published: not a draft
    assert "-X DELETE" in text  # a draft by its id: the tag stays
    assert "gh release delete" not in text  # by tag it finds no draft, and could take the tag


# --- The installer: which release ----------------------------------------------------------------


def _curl(tmp_path: Path, release: Path, latest: str = "v0.3.0") -> dict[str, str]:
    """A stub curl: the GitHub API's latest release, and the files of `release` by name."""
    bin_dir = tmp_path / "curl-bin"
    bin_dir.mkdir(exist_ok=True)
    curl = bin_dir / "curl"
    archive = shlex.quote(str(release / "aap-release.tar.gz"))
    curl.write_text(
        "#!/bin/sh\nout='' url=''\n"
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -H) shift 2 ;; -*) shift ;; '
        '*) url=$1; shift ;; esac; done\n'
        f'echo "$url" >> {shlex.quote(str(tmp_path / "curl.calls"))}\n'
        'case "$url" in\n'
        f'  */releases/latest) printf \'{{"url": "x", "tag_name": "%s"}}\\n\' {latest} ;;\n'
        f'  */releases/download/*/aap-release.tar.gz) cat {archive} > "$out" ;;\n'
        "  *) exit 22 ;;\n"
        "esac\n"
    )  # fmt: skip
    curl.chmod(0o755)
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}


def _installed(root: Path, sha: str, version: str | None) -> None:
    """An installation that runs `sha` (of `version`, or of a commit)."""
    (root / "site").mkdir(parents=True, exist_ok=True)
    (root / "site/settings.env").write_text("SITE_HOST=kyhistu.example.ee\nSITE_MODE=real\n")
    (root / "site/current_sha").write_text(f"{sha}\n")
    release = root / "releases" / sha
    (release / "deploy").mkdir(parents=True, exist_ok=True)
    (release / "install").mkdir(exist_ok=True)
    (release / "deploy/deploy.sh").write_text("#\n")
    (release / "install/install.sh").write_text("#\n")
    if version:
        (release / "VERSION").write_text(f"VERSION={version}\nCOMMIT={sha}\n")


def test_a_fresh_install_takes_the_latest_version(tmp_path: Path, release: Path) -> None:
    result = bash(
        tmp_path / "aap",
        'load_previous; resolve_release; echo "version=$A_VERSION ref=$REF"',
        **_curl(tmp_path, release, latest="v0.4.1"),
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "version=v0.4.1 ref="


def test_the_installer_of_a_release_installs_its_own_version(tmp_path: Path, release: Path) -> None:
    script = shlex.quote(str(release / "install.sh"))
    result = subprocess.run(
        ["bash", "-c", f"source {script}; load_previous; resolve_release; echo $A_VERSION"],
        env={**SAFE_ENV, **_curl(tmp_path, release, latest="v9.9.9"), "AAP_ROOT": str(tmp_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "v0.3.0"
    assert not (tmp_path / "curl.calls").exists()  # no need to ask GitHub


def _baked(tmp_path: Path, release: Path, root: Path, body: str) -> subprocess.CompletedProcess:
    """Run `body` after sourcing the installer of the release (v0.3.0)."""
    script = shlex.quote(str(release / "install.sh"))
    return subprocess.run(
        ["bash", "-c", f"set -euo pipefail; source {script}; {body}"],
        env={**SAFE_ENV, **_curl(tmp_path, release), "AAP_ROOT": str(root)},
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize("installed", ["v0.2.0", None])
def test_an_installer_of_another_version_keeps_the_installed_one_and_says_how_to_change_it(
    tmp_path: Path, release: Path, installed: str | None
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, installed)

    result = _baked(tmp_path, release, root, 'load_previous; resolve_release; echo "ref=$REF"')

    assert result.returncode == 0, result.stderr
    assert f"ref={OLD}" in result.stdout
    assert "this installer is of v0.3.0" in result.stdout
    assert "update.sh v0.3.0" in result.stdout


def test_the_installer_of_the_installed_version_re_runs_quietly(
    tmp_path: Path, release: Path
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.3.0")

    result = _baked(tmp_path, release, root, "load_previous; resolve_release")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_bin_gets_the_new_scripts_only_after_a_healthy_deploy(tmp_path: Path) -> None:
    """After a failed update rolled back, bin/install.sh is still the installer that runs."""
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.2.0")
    new = "c" * 40
    _installed(root, new, "v0.3.0")
    (root / "site/current_sha").write_text(f"{OLD}\n")
    for sha, mark in ((OLD, "old"), (new, "new")):
        for name in ("install.sh", "update.sh", "uninstall.sh"):
            (root / "releases" / sha / "install" / name).write_text(f"# {mark}\n")
    (root / "bin").mkdir()
    (root / "bin/install.sh").write_text("# old\n")
    layout = f"load_previous; {answers()}; APP_UID=$(id -u); REF={new}; write_layout"

    assert bash(root, layout).returncode == 0
    assert (root / "bin/install.sh").read_text() == "# old\n"

    assert bash(root, f"REF={new}; install_bin").returncode == 0
    assert (root / "bin/install.sh").read_text() == "# new\n"


def test_main_copies_the_scripts_after_the_deploy() -> None:
    source = (INSTALL / "install.sh").read_text()
    main = source[source.index("\nmain() {") :]

    assert main.index("    deploy_release\n") < main.index("    install_bin\n")


def test_the_first_install_gets_its_scripts_before_the_deploy(tmp_path: Path) -> None:
    """uninstall.sh must be there even when the first deploy fails."""
    root = tmp_path / "aap"
    release = root / "releases" / OLD / "install"
    release.mkdir(parents=True)
    for name in ("install.sh", "update.sh", "uninstall.sh"):
        (release / name).write_text("#\n")

    result = bash(root, f"{answers()}; APP_UID=$(id -u); REF={OLD}; write_layout")

    assert result.returncode == 0, result.stderr
    assert sorted(p.name for p in (root / "bin").iterdir()) == [
        "install.sh",
        "uninstall.sh",
        "update.sh",
    ]


def test_a_re_run_keeps_the_installed_release(tmp_path: Path, release: Path) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.2.0")

    result = bash(
        root,
        'load_previous; resolve_release; echo "version=$A_VERSION ref=$REF"',
        **_curl(tmp_path, release),
    )

    assert result.stdout.strip() == f"version= ref={OLD}"


def test_no_release_at_all_stops_with_a_hint(tmp_path: Path, release: Path) -> None:
    result = bash(
        tmp_path / "aap", "load_previous; resolve_release", **_curl(tmp_path, release, latest="")
    )

    assert result.returncode == 1
    assert "give a version such as" in result.stderr


def test_a_version_is_downloaded_into_the_release_of_its_commit(
    tmp_path: Path, release: Path, source: tuple[Path, str]
) -> None:
    _, commit = source
    root = tmp_path / "aap"

    result = bash(
        root,
        'A_VERSION=v0.3.0; fetch_release; echo "$REF $(release_version "$REF")"',
        **_curl(tmp_path, release),
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.split()[-2:] == [commit, "v0.3.0"]
    kept = sorted(p.name for p in (root / "releases" / commit).iterdir())
    assert kept == ["VERSION", "deploy", "install"]
    assert [p.name for p in (root / "releases").iterdir()] == [commit]  # no .incoming left


def test_an_archive_of_another_version_is_refused_and_leaves_nothing(
    tmp_path: Path, release: Path
) -> None:
    root = tmp_path / "aap"

    result = bash(root, "A_VERSION=v0.3.5; fetch_release", **_curl(tmp_path, release))

    assert result.returncode == 1
    assert "not a release of that version" in result.stderr
    assert list((root / "releases").iterdir()) == []


def test_an_archive_without_its_version_file_is_refused(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    with tarfile.open(dist / "aap-release.tar.gz", "w:gz") as archive:
        for name in ("aap-v0.3.0/deploy/deploy.sh", "aap-v0.3.0/install/install.sh"):
            info = tarfile.TarInfo(name)
            info.size = 2
            archive.addfile(info, io.BytesIO(b"#\n"))
    root = tmp_path / "aap"

    result = bash(root, "A_VERSION=v0.3.0; fetch_release", **_curl(tmp_path, dist))

    assert result.returncode == 1
    assert list((root / "releases").iterdir()) == []


@pytest.mark.parametrize(
    ("installed", "target", "allow", "refused"),
    [
        ("v0.3.0", "v0.2.9", False, True),
        ("v0.10.0", "v0.9.0", False, True),  # compared as versions, not as text
        ("v0.3.0", "v0.2.9", True, False),
        ("v0.3.0", "v0.3.0", False, False),
        ("v0.3.0", "v0.4.0", False, False),
        ("v0.9.0", "v0.10.0", False, False),
        (None, "v0.1.0", False, False),  # a commit runs: not compared
    ],
)
def test_a_version_below_the_installed_one_needs_allow_downgrade(
    tmp_path: Path, installed: str | None, target: str, allow: bool, refused: bool
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, installed)

    result = bash(
        root, f"load_previous; ALLOW_DOWNGRADE={str(allow).lower()}; check_forward {target}"
    )

    assert result.returncode == (1 if refused else 0), result.stderr
    if refused:
        assert "--allow-downgrade" in result.stderr


# --- update.sh -----------------------------------------------------------------------------------


def _update(tmp_path: Path, root: Path, env: dict[str, str], *args: str):
    (root / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copy(INSTALL / "install.sh", root / "bin/install.sh")
    return subprocess.run(
        ["bash", str(INSTALL / "update.sh"), *args],
        env={**SAFE_ENV, **env, "AAP_ROOT": str(root)},
        capture_output=True,
        text=True,
    )


def test_update_runs_the_installer_of_the_new_release(
    tmp_path: Path, source: tuple[Path, str]
) -> None:
    """The archive's own installer runs, without questions, on the release of its commit."""
    _, commit = source
    dist = tmp_path / "dist"
    dist.mkdir()
    with tarfile.open(dist / "aap-release.tar.gz", "w:gz") as archive:
        files = {
            "aap-v0.3.0/VERSION": f"VERSION=v0.3.0\nCOMMIT={commit}\n",
            "aap-v0.3.0/deploy/deploy.sh": "#\n",
            "aap-v0.3.0/install/install.sh": 'echo "next installer: $* as $AAP_RUN_KIND"\n',
        }
        for name, text in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(text.encode())
            archive.addfile(info, io.BytesIO(text.encode()))
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.2.0")

    result = _update(tmp_path, root, _curl(tmp_path, dist, latest="v0.3.0"))

    assert result.returncode == 0, result.stderr
    assert f"next installer: --yes --ref {commit} as update" in result.stdout
    assert (root / f"releases/{commit}/VERSION").exists()


def test_update_to_the_running_version_does_nothing(tmp_path: Path, release: Path) -> None:
    root = tmp_path / "aap"
    env = _curl(tmp_path, release)
    first = bash(root, "A_VERSION=v0.3.0; fetch_release; echo $REF", **env)
    commit = first.stdout.split()[-1]
    _installed(root, commit, "v0.3.0")

    result = _update(tmp_path, root, env, "v0.3.0")

    assert result.returncode == 0, result.stderr
    assert "runs v0.3.0 already" in result.stdout
    assert (
        (root / "install.log")
        .read_text()
        .splitlines()[-1]
        .endswith(f"update nothing to do sha={commit}")
    )


def test_update_refuses_an_older_version_before_downloading_it(
    tmp_path: Path, release: Path
) -> None:
    root = tmp_path / "aap"
    _installed(root, OLD, "v0.4.0")

    result = _update(tmp_path, root, _curl(tmp_path, release), "v0.3.0")

    assert result.returncode == 1
    assert "older than the installed v0.4.0" in result.stderr
    assert not (tmp_path / "curl.calls").exists()


def test_a_release_is_unpacked_with_root_s_own_owners_and_modes() -> None:
    """As root, tar would keep the owners and modes (a setuid bit too) of the archive."""
    source = (INSTALL / "install.sh").read_text()

    assert "UNTAR=(tar --no-same-owner --no-same-permissions)" in source
    assert source.count('"${UNTAR[@]}" -xzf') == 3
    assert "tar -xzf" not in source
    assert source.count('--max-filesize "$MAX_DOWNLOAD_BYTES"') == 2
