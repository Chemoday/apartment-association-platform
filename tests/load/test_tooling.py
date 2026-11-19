"""The load-test tooling stays in step with the deployment it loads (tests/load/, issue #168)."""

import subprocess
from pathlib import Path

import pytest
import yaml

LOAD = Path(__file__).resolve().parent
ROOT = LOAD.parents[1]


@pytest.mark.parametrize("script", ["target.sh", "measure.sh"])
def test_the_scripts_parse(script: str) -> None:
    subprocess.run(["bash", "-n", str(LOAD / script)], check=True)


def test_the_load_database_keeps_the_settings_of_the_deploy_file() -> None:
    """The override replaces the database command, so it must start with the deploy file's."""
    deploy = yaml.safe_load((ROOT / "deploy/docker-compose.deploy.yml").read_text())
    load = yaml.safe_load((LOAD / "docker-compose.load.yml").read_text())

    deploy_command = deploy["services"]["db"]["command"]
    load_command = load["services"]["db"]["command"]
    assert load_command[: len(deploy_command)] == deploy_command
    assert "shared_preload_libraries=pg_stat_statements" in load_command


def test_the_backend_is_published_only_where_the_runner_says() -> None:
    load = yaml.safe_load((LOAD / "docker-compose.load.yml").read_text())

    assert load["services"]["backend"]["ports"] == [
        "${LOAD_BIND:-127.0.0.1}:${LOAD_PORT:?set by tests/load/target.sh}:8000"
    ]


def test_every_target_is_a_demo_without_the_seed() -> None:
    """seed_load.py fills an empty demo; a target is never a real installation."""
    script = (LOAD / "target.sh").read_text()

    for line in ("DEMO_MODE_ENABLED=true", "SEED_DEMO_DATA=false", "ENVIRONMENT=dev"):
        assert f"\n{line}\n" in script


def test_the_locustfile_refuses_a_target_that_is_not_a_demo() -> None:
    source = (LOAD / "locustfile.py").read_text()

    assert "@events.test_start.add_listener" in source
    assert "/demo/users" in source and "environment.runner.quit()" in source


def test_locust_is_never_part_of_the_image_or_the_test_environment() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text()
    dev = pyproject.split("dev = [", 1)[1].split("]", 1)[0]

    assert "locust" not in dev
    assert "load = [" in pyproject
    assert "--no-dev" in (ROOT / "Dockerfile").read_text()  # only the main dependencies
