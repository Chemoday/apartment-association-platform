"""Deployment configuration (deploy/): limits, log rotation, edge body limits, host scripts.

The scripts run on the VPS as root or as the deploy user; here they run against stub commands
(docker, du, df, logger) in a temporary /opt/aap, so nothing on this machine is touched.
"""

import fcntl
import os
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
SHA_DEV = "a" * 40
SHA_DEV_PREVIOUS = "b" * 40
SHA_PROD = "c" * 40
SHA_OLD = "d" * 40
SHA_OLDER = "e" * 40
IMAGE = "ghcr.io/example/aap"


def _compose(name: str) -> dict:
    return yaml.safe_load((DEPLOY / name).read_text())


@pytest.mark.parametrize("compose_file", ["docker-compose.deploy.yml", "edge/docker-compose.yml"])
def test_every_service_rotates_its_logs_and_has_a_memory_limit(compose_file: str) -> None:
    for name, service in _compose(compose_file)["services"].items():
        logging = service.get("logging", {})
        assert logging.get("driver") == "json-file", name
        assert logging["options"]["max-size"] == "10m", name
        assert logging["options"]["max-file"] == "3", name
        assert service.get("mem_limit"), name
        assert service.get("pids_limit"), name


def test_backend_runs_read_only_with_a_small_tmpfs() -> None:
    backend = _compose("docker-compose.deploy.yml")["services"]["backend"]

    assert backend["read_only"] is True
    assert backend["tmpfs"] == ["/tmp:size=64m"]
    assert backend["mem_limit"] == "512m"
    assert backend["cpus"] == 2


def test_backend_keeps_uploaded_files_in_the_host_directory_of_its_environment() -> None:
    backend = _compose("docker-compose.deploy.yml")["services"]["backend"]

    [mount] = backend["volumes"]
    assert mount["type"] == "bind"
    assert mount["source"] == "${AAP_ROOT:-/opt/aap}/${APP_ENV}/files"
    assert mount["target"] == backend["environment"]["FILES_DIR"] == "/data/files"
    # A missing directory must fail the deploy, not become an empty root-owned one.
    assert mount["bind"]["create_host_path"] is False


def _settings(env_name: str) -> dict[str, str]:
    lines = (DEPLOY / "environments" / f"{env_name}.env").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if line and not line.startswith("#"))


def test_without_its_settings_an_environment_is_a_real_installation() -> None:
    """Epic E13 R1: demo mode, the seed and uploads in demo only where the settings say so."""
    environment = _compose("docker-compose.deploy.yml")["services"]["backend"]["environment"]

    assert environment["DEMO_MODE_ENABLED"] == "${DEMO_MODE_ENABLED:-false}"
    assert environment["SEED_DEMO_DATA"] == "${SEED_DEMO_DATA:-false}"
    assert environment["FILES_IN_DEMO"] == "${FILES_IN_DEMO:-false}"
    assert environment["ENABLED_PLUGINS"] == "${ENABLED_PLUGINS:-common.csv_export}"
    assert environment["INSTANCE_ID"].startswith("${INSTANCE_ID:?")


def test_dev_and_prod_are_the_public_demo_with_their_own_installation_ids() -> None:
    dev, prod = _settings("dev"), _settings("prod")

    assert (
        sorted(dev)
        == sorted(prod)
        == [
            "DEMO_MODE_ENABLED",
            "ENABLED_PLUGINS",
            "FILES_IN_DEMO",
            "INSTANCE_ID",
            "SEED_DEMO_DATA",
        ]
    )
    for settings in (dev, prod):
        assert settings["DEMO_MODE_ENABLED"] == settings["SEED_DEMO_DATA"] == "true"
        assert re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", settings["INSTANCE_ID"])
    assert (dev["INSTANCE_ID"], prod["INSTANCE_ID"]) == ("project-dev", "project-prod")
    # Uploads in demo mode on dev only (epic E11).
    assert (dev["FILES_IN_DEMO"], prod["FILES_IN_DEMO"]) == ("true", "false")
    # Epic E12: countries.ee.building_registry on dev; prod keeps the default plugins.
    assert dev["ENABLED_PLUGINS"] == "common.csv_export,countries.ee.building_registry"
    assert prod["ENABLED_PLUGINS"] == "common.csv_export"


def test_database_caps_its_write_ahead_log_and_temp_files() -> None:
    db = _compose("docker-compose.deploy.yml")["services"]["db"]

    assert "max_wal_size=256MB" in db["command"]
    assert "temp_file_limit=512MB" in db["command"]
    assert db["mem_limit"] == "384m"


INSTALL = DEPLOY.parent / "install"


def test_edge_limits_request_bodies_and_raises_them_only_on_upload_routes() -> None:
    snippet = (DEPLOY / "edge" / "environment.caddy").read_text()
    caddyfile = (DEPLOY / "edge" / "Caddyfile").read_text()
    site = (INSTALL / "Caddyfile").read_text()

    assert re.findall(r"max_size (\S+)", snippet) == ["4MB", "20MB", "1MB"]
    assert "path_regexp ^/api/v1/issues/[^/]+/photos$" in snippet
    # Every environment of both kinds of server goes through the same limits and timeouts.
    for edge in (caddyfile, site):
        assert "import /etc/caddy/environment.caddy" in edge
        assert "max_size" not in edge
        assert (
            _timeouts(edge)
            == _timeouts(caddyfile)
            == ["read_header 10s", "read_body 3m", "idle 2m"]
        )
    assert "import environment aap-prod-backend" in caddyfile
    assert "import environment aap-dev-backend" in caddyfile
    assert "import environment aap-site-backend" in site


def _timeouts(caddyfile: str) -> list[str]:
    block = caddyfile.split("timeouts {", 1)[1].split("}", 1)[0]
    return [line.strip() for line in block.splitlines() if line.strip()]


@pytest.mark.parametrize("script", sorted(p.name for p in DEPLOY.rglob("*.sh")))
def test_shell_scripts_parse(script: str) -> None:
    (path,) = list(DEPLOY.rglob(script))
    subprocess.run(["bash", "-n", str(path)], check=True)


def test_host_and_environment_files_hold_no_secrets() -> None:
    files = [*(DEPLOY / "hosts").glob("*.env"), *(DEPLOY / "environments").glob("*.env")]
    assert len(files) >= 3
    for host_file in files:
        for line in host_file.read_text().splitlines():
            if line.startswith("#") or "=" not in line:
                continue
            key = line.split("=", 1)[0]
            assert not re.search(r"PASSWORD|SECRET|TOKEN|KEY", key), f"{host_file.name}: {key}"


# --- stubs -------------------------------------------------------------------------------------


def _stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def host(tmp_path: Path) -> dict:
    """A temporary /opt/aap with two environments and a stub docker that logs its calls."""
    root = tmp_path / "aap"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for env_name, current, previous in (
        ("dev", SHA_DEV, SHA_DEV_PREVIOUS),
        ("prod", SHA_PROD, None),
    ):
        (root / env_name).mkdir(parents=True)
        (root / env_name / "current_sha").write_text(current + "\n")
        if previous:
            (root / env_name / "previous_sha").write_text(previous + "\n")
    releases = root / "releases"
    three_hours_ago = time.time() - 3 * 3600
    for sha in (SHA_DEV, SHA_DEV_PREVIOUS, SHA_PROD, SHA_OLD, SHA_OLDER):
        (releases / sha / "deploy").mkdir(parents=True)
        os.utime(releases / sha, (three_hours_ago, three_hours_ago))
    conf = tmp_path / "aap.conf"
    conf.write_text(f"AAP_ROOT={root}\nIMAGE={IMAGE}\nDISK_BUDGET_GB=1\n")
    calls = tmp_path / "docker.calls"
    tags = "\n".join([SHA_DEV, SHA_DEV_PREVIOUS, SHA_PROD, SHA_OLD, SHA_OLDER, "main", "<none>"])
    _stub(
        bin_dir,
        "docker",
        f'echo "$*" >> {calls}\n'
        'if [[ "$1 $2" == "image ls" && "$*" == *"{{.Tag}}"* ]]; then\n'
        f"  printf '%s\\n' {' '.join(repr(t) for t in tags.split())}\n"
        "fi\n"
        'if [[ "$1" == compose && "$*" == *" up "* ]]; then\n'
        f'  echo "settings $INSTANCE_ID $DEMO_MODE_ENABLED $SEED_DEMO_DATA $FILES_IN_DEMO'
        f' $ENABLED_PLUGINS" >> {calls}\n'
        '  [[ -z "${FAIL_UP:-}" ]] || exit 1\n'
        "fi\n",
    )
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "AAP_CONF": str(conf)}
    return {"root": root, "releases": releases, "calls": calls, "env": env, "bin": bin_dir}


def _removed_images(host: dict) -> set[str]:
    if not host["calls"].exists():
        return set()
    return {
        line.split()[-1].rsplit(":", 1)[1]
        for line in host["calls"].read_text().splitlines()
        if line.startswith("image rm ")
    }


def test_cleanup_keeps_current_and_previous_releases_of_every_environment(host: dict) -> None:
    result = _cleanup(host)

    assert result.returncode == 0, result.stderr
    assert _removed_images(host) == {SHA_OLD, SHA_OLDER}
    remaining = {p.name for p in host["releases"].iterdir() if p.is_dir()}
    assert remaining == {SHA_DEV, SHA_DEV_PREVIOUS, SHA_PROD}
    # Only tags of the project's image are touched, never a host-wide prune.
    assert not any("prune" in line for line in host["calls"].read_text().splitlines())


def _cleanup(host: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(DEPLOY / "cleanup.sh")], env=host["env"], capture_output=True, text=True
    )


def test_cleanup_skips_while_another_deploy_holds_the_lock(host: dict) -> None:
    with open(host["releases"] / ".deploy.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)  # a deploy of the other environment is running
        result = _cleanup(host)

    assert result.returncode == 0
    assert "skipped" in result.stdout
    assert _removed_images(host) == set()
    assert (host["releases"] / SHA_OLD).exists()


def test_cleanup_keeps_a_release_that_was_just_downloaded_or_touched(host: dict) -> None:
    # ssh-gate.sh has fetched (or touched) it; its deploy has not taken the lock yet, or it is a
    # rollback to an old release whose deploy.sh takes no lock at all.
    os.utime(host["releases"] / SHA_OLD)

    result = _cleanup(host)

    assert result.returncode == 0, result.stderr
    assert _removed_images(host) == {SHA_OLDER}
    assert (host["releases"] / SHA_OLD).exists()


def test_cleanup_removes_nothing_without_a_current_release(host: dict) -> None:
    for env_name in ("dev", "prod"):
        for state in ("current_sha", "previous_sha"):
            (host["root"] / env_name / state).unlink(missing_ok=True)

    result = subprocess.run(
        ["bash", str(DEPLOY / "cleanup.sh")], env=host["env"], capture_output=True, text=True
    )

    assert result.returncode == 0
    assert _removed_images(host) == set()
    assert len([p for p in host["releases"].iterdir() if p.is_dir()]) == 5


def _disk_check(host: dict, used_bytes: int, free_pct: int) -> subprocess.CompletedProcess:
    _stub(host["bin"], "du", f'printf "{used_bytes}\\t%s\\n" "${{@: -1}}"\n')
    _stub(
        host["bin"],
        "df",
        f'echo "1B-blocks Avail"\necho "1000 {free_pct * 10}"\n',
    )
    _stub(host["bin"], "logger", f'echo "$*" >> {host["root"]}/logger.calls\n')
    return subprocess.run(
        ["bash", str(DEPLOY / "host" / "aap-disk-check.sh")],
        env=host["env"],
        capture_output=True,
        text=True,
    )


def test_disk_check_is_quiet_within_the_budget(host: dict) -> None:
    result = _disk_check(host, used_bytes=100 * 1024 * 1024, free_pct=50)

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith("ok: platform uses 100 MB = 9% of 1 GB")
    assert not (host["root"] / "logger.calls").exists()


@pytest.mark.parametrize(
    ("used_mb", "free_pct", "expected"),
    [
        (800, 50, "platform above 70% of its disk budget"),
        (900, 50, "platform above 85% of its disk budget"),
        (100, 15, "host disk below 20% free"),
    ],
)
def test_disk_check_warns_in_the_journal_and_fails(
    host: dict, used_mb: int, free_pct: int, expected: str
) -> None:
    result = _disk_check(host, used_bytes=used_mb * 1024 * 1024, free_pct=free_pct)

    assert result.returncode == 1
    assert expected in result.stdout
    logged = (host["root"] / "logger.calls").read_text()
    assert "-t aap-disk-check -p user.warning" in logged
    assert expected in logged


def _deploy(host: dict, sha: str, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(DEPLOY / "deploy.sh"), "dev", sha],
        env={**host["env"], **env},
        capture_output=True,
        text=True,
    )


def test_a_healthy_deploy_records_the_release_and_then_cleans_up(host: dict) -> None:
    new_sha = "f" * 40
    (host["root"] / "dev" / ".env").write_text("")

    result = _deploy(host, new_sha)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (host["root"] / "dev" / "current_sha").read_text().strip() == new_sha
    assert (host["root"] / "dev" / "previous_sha").read_text().strip() == SHA_DEV
    # Kept: dev's new current and previous, prod's current; SHA_DEV_PREVIOUS is no longer needed.
    assert _removed_images(host) == {SHA_DEV_PREVIOUS, SHA_OLD, SHA_OLDER}
    # The deploy released its shared lock before the clean-up took the exclusive one.
    assert "skipped" not in result.stdout


@pytest.mark.parametrize("env_name", ["dev", "prod"])
def test_a_deploy_starts_the_environment_with_its_settings(host: dict, env_name: str) -> None:
    (host["root"] / env_name / ".env").write_text("")

    result = subprocess.run(
        ["bash", str(DEPLOY / "deploy.sh"), env_name, "f" * 40],
        env=host["env"],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    settings = _settings(env_name)
    expected = " ".join(
        settings[key]
        for key in (
            "INSTANCE_ID",
            "DEMO_MODE_ENABLED",
            "SEED_DEMO_DATA",
            "FILES_IN_DEMO",
            "ENABLED_PLUGINS",
        )
    )
    assert f"settings {expected}" in host["calls"].read_text().splitlines()


def test_a_deploy_without_settings_for_its_environment_starts_nothing(host: dict) -> None:
    result = subprocess.run(
        ["bash", str(DEPLOY / "deploy.sh"), "staging", "f" * 40],
        env=host["env"],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert "no settings for staging" in result.stdout
    assert not host["calls"].exists()


def test_a_failed_deploy_never_cleans_up(host: dict) -> None:
    result = _deploy(host, "f" * 40, FAIL_UP="1")

    assert result.returncode == 1
    assert "health check FAILED" in result.stdout
    assert _removed_images(host) == set()
    assert (host["root"] / "dev" / "current_sha").read_text().strip() == SHA_DEV


def _docker_works() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.mark.skipif(not _docker_works(), reason="needs a running docker daemon")
def _caddy_validate(etc_caddy: Path, *env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "docker", "run", "--rm", "-v", f"{etc_caddy}:/etc/caddy:ro",
            *[arg for pair in env for arg in ("-e", pair)], "caddy:2.8.4-alpine",
            "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )  # fmt: skip


def test_caddyfile_validates_with_the_pinned_caddy() -> None:
    result = _caddy_validate(
        DEPLOY / "edge",
        "HTTPS_PORT=8443",
        "PROD_HOST=prod.example.test",
        "DEV_HOST=dev.example.test",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Valid configuration" in result.stdout + result.stderr


@pytest.mark.skipif(not _docker_works(), reason="needs a running docker daemon")
@pytest.mark.parametrize("tls_mode", ["acme", "internal"])
def test_the_caddyfile_of_an_installation_validates(tmp_path: Path, tls_mode: str) -> None:
    """As install.sh lays it out: install/Caddyfile next to the shared snippet."""
    shutil.copy(INSTALL / "Caddyfile", tmp_path / "Caddyfile")
    shutil.copy(DEPLOY / "edge" / "environment.caddy", tmp_path / "environment.caddy")

    result = _caddy_validate(tmp_path, "SITE_HOST=kyhistu.example.test", f"TLS_MODE={tls_mode}")

    assert result.returncode == 0, result.stdout + result.stderr
