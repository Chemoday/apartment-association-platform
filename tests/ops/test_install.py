"""The simple install (install/; docs/DEPLOYMENT.md "The simple install", epic E13 task R5a).

The scripts run as root on a real server; here their functions are sourced into bash against a
temporary AAP_ROOT and a stub docker, so nothing on this machine is touched. The whole install
runs in throw-away system containers on the test VPS (docs/DEPLOYMENT.md).
"""

import json
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path

import pytest

INSTALL = Path(__file__).resolve().parents[2] / "install"
SCRIPT = INSTALL / "install.sh"
EMAIL = "chair.person@example.ee"
ADDRESS = "Näidise tn 1, Tallinn"
PASSWORD = "smtp-pass-Very$ecret 1"
# The scripts get this environment, never the developer's tokens or keys: a failing assertion
# that prints the environment must not show them.
SAFE_ENV = {
    name: value
    for name, value in os.environ.items()
    if not re.search(r"TOKEN|SECRET|PASSW|KEY|CREDENTIAL|AUTH", name, re.IGNORECASE)
}


def bash(root: Path, body: str, **env: str) -> subprocess.CompletedProcess[str]:
    """Run `body` after sourcing install.sh (main() does not run when sourced)."""
    return subprocess.run(
        ["bash", "-c", f"set -euo pipefail; source {shlex.quote(str(SCRIPT))}; {body}"],
        env={**SAFE_ENV, "AAP_ROOT": str(root), **env},
        capture_output=True,
        text=True,
    )


def answers(**values: str) -> str:
    """Shell assignments of the answers the questions would give."""
    defaults = {
        "SITE_HOST": "kyhistu.example.ee",
        "MODE": "real",
        "COUNTRY": "EE",
        "SMTP_HOST": "",
        "SMTP_PORT": "",
        "SMTP_USERNAME": "",
        "SMTP_FROM": "",
        "SMTP_PASSWORD_NEW": "",
        "RUN_KIND": "install",
        "PUBLIC_IP": "203.0.113.7",
    }
    return " ".join(f"{k}={shlex.quote(v)}" for k, v in {**defaults, **values}.items())


def settings(root: Path) -> dict[str, str]:
    """settings.env as bash reads it (values are shell-quoted)."""
    result = subprocess.run(
        ["bash", "-c", f"set -a; . {shlex.quote(str(root / 'site/settings.env'))}; env -0"],
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ["PATH"]},
    )
    pairs = (item.split("=", 1) for item in result.stdout.split("\0") if "=" in item)
    return dict(pairs)


def secrets(root: Path) -> dict[str, str]:
    lines = (root / "site/.env").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if line)


def write(root: Path, **values: str) -> subprocess.CompletedProcess[str]:
    return bash(root, f"load_previous; {answers(**values)}; write_secrets; write_settings")


# --- Options -------------------------------------------------------------------------------------


@pytest.mark.parametrize("script", sorted(p.name for p in INSTALL.glob("*.sh")))
def test_the_scripts_parse(script: str) -> None:
    subprocess.run(["bash", "-n", str(INSTALL / script)], check=True)


def test_help_lists_every_option() -> None:
    result = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True)

    assert result.returncode == 0
    for option in ("--yes", "--version", "--ref", "--allow-downgrade", "--host", "--no-domain",
                   "--mode", "--building-address", "--association-name", "--chairman-email",
                   "--smtp-password-file", "--no-smtp", "--tls-internal"):  # fmt: skip
        assert option in result.stdout


@pytest.mark.parametrize(
    "args",
    [
        ["--smtp-password", "x"],
        ["--smtp-password=x"],
        ["--ref", "abc"],
        ["--version", "1.2.3"],
        ["--version", "v1.2"],
        ["--version", "v01.2.3"],
        ["--version", "v1.2.3", "--ref", "a" * 40],
        ["--bogus"],
    ],
)
def test_bad_options_stop_before_anything_happens(tmp_path: Path, args: list[str]) -> None:
    result = subprocess.run(
        ["bash", str(SCRIPT), *args],
        env={**SAFE_ENV, "AAP_ROOT": str(tmp_path / "aap")},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert not (tmp_path / "aap").exists()
    if "--smtp-password" in args[0]:
        assert "never pass the SMTP password on the command line" in result.stderr


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("kyhistu.example.ee", True),
        ("example.ee", True),
        ("203-0-113-7.sslip.io", True),
        ("localhost", False),
        ("https://example.ee", False),
        ("example.ee/path", False),
        ("exa mple.ee", False),
        ("-bad.example.ee", False),
    ],
)
def test_hostnames(tmp_path: Path, value: str, valid: bool) -> None:
    result = bash(tmp_path, f"valid_hostname {shlex.quote(value)}")

    assert (result.returncode == 0) is valid


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        (EMAIL, True),
        ("a@b.ee", True),
        ("no-at.example.ee", False),
        ("a b@c.ee", False),
        ("a@b", False),
    ],
)
def test_e_mail_addresses(tmp_path: Path, value: str, valid: bool) -> None:
    assert (bash(tmp_path, f"valid_email {shlex.quote(value)}").returncode == 0) is valid


# --- Settings and secrets ------------------------------------------------------------------------


def test_a_real_installation_with_e_mail(tmp_path: Path) -> None:
    result = write(
        tmp_path,
        SMTP_HOST="smtp.example.ee",
        SMTP_PORT="465",
        SMTP_USERNAME="site@example.ee",
        SMTP_FROM="site@example.ee",
        SMTP_PASSWORD_NEW=PASSWORD,
    )

    assert result.returncode == 0, result.stderr
    values = settings(tmp_path)
    assert values["SITE_HOST"] == "kyhistu.example.ee"
    assert values["ENVIRONMENT"] == "prod"
    assert (values["DEMO_MODE_ENABLED"], values["SEED_DEMO_DATA"], values["FILES_IN_DEMO"]) == (
        "false",
        "false",
        "false",
    )
    assert values["ENABLED_PLUGINS"] == (
        "common.csv_export,countries.ee.building_registry,common.email_smtp"
    )
    assert values["PUBLIC_BASE_URL"] == "https://kyhistu.example.ee"
    assert (values["SMTP_PORT"], values["SMTP_TLS"]) == ("465", "tls")
    assert values["SMTP_USERNAME"] == "site@example.ee"
    assert values["SITE_MODE"] == "real"
    assert values["PUBLIC_IP"] == "203.0.113.7"
    assert len(values["INSTANCE_ID"]) == 36
    assert "PASSWORD" not in (tmp_path / "site/settings.env").read_text()
    kept = secrets(tmp_path)
    assert kept["SMTP_PASSWORD"] == f"'{PASSWORD}'"  # literal for Docker Compose
    assert sorted(kept) == [
        "AUTH_HASH_SECRET",
        "JWT_SECRET_KEY",
        "NOTIFICATIONS_HASH_SECRET",
        "POSTGRES_PASSWORD",
        "SMTP_PASSWORD",
    ]
    assert stat.S_IMODE((tmp_path / "site/.env").stat().st_mode) == 0o600


def test_a_demo_has_no_mail_and_no_register(tmp_path: Path) -> None:
    assert write(tmp_path, MODE="demo", COUNTRY="LV").returncode == 0

    values = settings(tmp_path)
    assert (values["DEMO_MODE_ENABLED"], values["SEED_DEMO_DATA"]) == ("true", "true")
    assert values["ENABLED_PLUGINS"] == "common.csv_export"
    assert values["ENVIRONMENT"] == "prod"  # so no uploads and no sign-in mail in the demo


def test_a_re_run_keeps_secrets_and_the_installation_id(tmp_path: Path) -> None:
    write(tmp_path, SMTP_HOST="smtp.example.ee", SMTP_PORT="587", SMTP_USERNAME="u@example.ee",
          SMTP_FROM="u@example.ee", SMTP_PASSWORD_NEW=PASSWORD)  # fmt: skip
    first_secrets, first = secrets(tmp_path), settings(tmp_path)

    # Enter at every question: the previous answers, no new password.
    result = write(tmp_path, SMTP_HOST="smtp.example.ee", SMTP_PORT="587",
                   SMTP_USERNAME="u@example.ee", SMTP_FROM="u@example.ee")  # fmt: skip

    assert result.returncode == 0, result.stderr
    assert secrets(tmp_path) == first_secrets
    assert settings(tmp_path)["INSTANCE_ID"] == first["INSTANCE_ID"]
    assert settings(tmp_path)["SMTP_TLS"] == "starttls"


def test_a_re_run_without_e_mail_removes_the_password(tmp_path: Path) -> None:
    write(tmp_path, SMTP_HOST="smtp.example.ee", SMTP_PORT="587", SMTP_USERNAME="u@example.ee",
          SMTP_FROM="u@example.ee", SMTP_PASSWORD_NEW=PASSWORD)  # fmt: skip

    assert write(tmp_path).returncode == 0

    assert "SMTP_PASSWORD" not in secrets(tmp_path)
    assert "common.email_smtp" not in settings(tmp_path)["ENABLED_PLUGINS"]
    assert settings(tmp_path)["SMTP_HOST"] == ""


def test_the_previous_answers_are_read_back(tmp_path: Path) -> None:
    write(tmp_path, SITE_HOST="maja.example.ee", MODE="demo", SMTP_HOST="smtp.example.ee",
          SMTP_PORT="2525", SMTP_USERNAME="u@example.ee", SMTP_FROM="u@example.ee",
          SMTP_PASSWORD_NEW=PASSWORD)  # fmt: skip
    (tmp_path / "site/current_sha").write_text("a" * 40 + "\n")

    result = bash(
        tmp_path,
        "load_previous; echo $RUN_KIND $P_SITE_HOST $P_SITE_MODE $P_SMTP_HOST $P_SMTP_PORT $P_SHA",
    )

    assert result.stdout.split() == [
        "rerun", "maja.example.ee", "demo", "smtp.example.ee", "2525", "a" * 40
    ]  # fmt: skip


# --- The log and the questions without a terminal ------------------------------------------------


def test_the_log_holds_no_personal_data_and_no_secret(tmp_path: Path) -> None:
    (tmp_path / "site").mkdir(parents=True)
    body = (
        f"{answers(SMTP_PASSWORD_NEW=PASSWORD)}; log_line start; write_secrets; write_settings; "
        f"log_line 'settings written mode=real'; "
        f"die {shlex.quote('chairman: ' + EMAIL + ' at ' + ADDRESS + ' is wrong')}"
    )

    result = bash(tmp_path, body)

    assert result.returncode == 1
    assert EMAIL in result.stderr  # the operator sees it on the screen
    log = (tmp_path / "install.log").read_text()
    assert log.splitlines()[-1].endswith("install stopped chairman")
    for value in (EMAIL, ADDRESS, PASSWORD, *secrets(tmp_path).values()):
        assert value not in log
    assert stat.S_IMODE((tmp_path / "install.log").stat().st_mode) == 0o600


def test_with_yes_a_missing_answer_stops_instead_of_asking(tmp_path: Path) -> None:
    body = "YES=true; RUN_KIND=install; A_CHAIRMAN=''; install -d \"$AAP_ROOT/site\"; ask_chairman"

    result = bash(tmp_path, body)

    assert result.returncode == 1
    assert "--chairman-email is not an e-mail address" in result.stderr


def test_with_yes_an_own_hostname_must_point_to_the_server(tmp_path: Path) -> None:
    body = "YES=true; PUBLIC_IP=203.0.113.7; A_HOST=nowhere.invalid; ask_host"

    result = bash(tmp_path, body)

    assert result.returncode == 1
    assert "does not point to 203.0.113.7" in result.stderr


def test_without_an_own_hostname_the_site_gets_sslip(tmp_path: Path) -> None:
    result = bash(
        tmp_path, "YES=true; PUBLIC_IP=203.0.113.7; A_NO_DOMAIN=true; ask_host; echo $SITE_HOST"
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "203-0-113-7.sslip.io"


# --- Demo and real never switch on the same data -------------------------------------------------


def _stub_docker(tmp_path: Path, volume_exists: bool) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text("#!/usr/bin/env bash\n" + ("exit 0\n" if volume_exists else "exit 1\n"))
    docker.chmod(0o755)
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}


@pytest.mark.parametrize(("previous", "now"), [("demo", "real"), ("real", "demo")])
def test_the_mode_never_switches_on_existing_data(tmp_path: Path, previous: str, now: str) -> None:
    env = _stub_docker(tmp_path, volume_exists=True)

    result = bash(tmp_path / "aap", f"P_SITE_MODE={previous}; MODE={now}; guard_mode_switch", **env)

    assert result.returncode == 1
    assert f"holds the data of a {previous} installation" in result.stderr
    assert "uninstall.sh --delete-data" in result.stderr


def test_the_mode_may_change_when_there_are_no_data(tmp_path: Path) -> None:
    env = _stub_docker(tmp_path, volume_exists=False)

    body = "P_SITE_MODE=demo; MODE=real; guard_mode_switch"
    assert bash(tmp_path / "aap", body, **env).returncode == 0


def _docker_works() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


@pytest.mark.skipif(not _docker_works(), reason="needs docker compose")
@pytest.mark.parametrize("password", [PASSWORD, 'a$b ${c} #d \\e "f" `g`', '"starts-with-quote'])
def test_docker_compose_reads_the_smtp_password_literally(tmp_path: Path, password: str) -> None:
    """Compose expands $ and strips comments in unquoted .env values (R5a review, finding 1)."""
    write(tmp_path, SMTP_HOST="smtp.example.ee", SMTP_PORT="587", SMTP_USERNAME="u@example.ee",
          SMTP_FROM="u@example.ee", SMTP_PASSWORD_NEW=password)  # fmt: skip
    compose = tmp_path / "compose.yml"
    compose.write_text(
        "services:\n  x:\n    image: busybox\n    environment:\n"
        "      SMTP_PASSWORD: ${SMTP_PASSWORD:-}\n      JWT: ${JWT_SECRET_KEY:-}\n"
    )

    result = subprocess.run(
        ["docker", "compose", "-f", str(compose), "--env-file", str(tmp_path / "site/.env"),
         "config", "--format", "json"],
        # Only the file speaks: a variable of the test process would win over it.
        env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")},
        capture_output=True,
        text=True,
    )  # fmt: skip

    assert result.returncode == 0, result.stderr
    assert "not set" not in result.stderr
    environment = json.loads(result.stdout)["services"]["x"]["environment"]
    # `config` prints the resolved model, escaping a literal $ as $$ for its own YAML.
    assert environment["SMTP_PASSWORD"].replace("$$", "$") == password
    assert len(environment["JWT"]) == 64


@pytest.mark.parametrize("password", ["it's", "ends-with\\", "mid\\dle"])
def test_a_password_compose_cannot_keep_literally_is_refused(tmp_path: Path, password: str) -> None:
    (tmp_path / "pw").write_text(password + "\n")
    body = (
        "YES=true; A_SMTP_HOST=smtp.example.ee; A_SMTP_PORT=587; A_SMTP_USER=u@example.ee; "
        f"A_SMTP_FROM=u@example.ee; A_SMTP_PASSWORD_FILE={shlex.quote(str(tmp_path / 'pw'))}; "
        'install -d "$AAP_ROOT/site"; ask_smtp'
    )

    result = bash(tmp_path, body)

    assert result.returncode == 1
    assert "must not contain ' or \\ or a line break" in result.stderr


def test_a_re_run_never_invites_the_chairman_again_unless_asked(tmp_path: Path) -> None:
    (tmp_path / "site").mkdir(parents=True)
    (tmp_path / "site/.chairman-invited").touch()
    body = f"YES=true; A_CHAIRMAN={EMAIL}; ask_chairman; echo invite=$INVITE email=$CHAIRMAN_EMAIL"

    result = bash(tmp_path, body)
    asked = bash(tmp_path, f"A_INVITE=true; {body}")

    assert result.returncode == 0, result.stderr
    assert "--chairman-email is ignored" in result.stdout
    assert result.stdout.strip().endswith("invite=false email=")
    assert asked.stdout.strip().endswith(f"invite=true email={EMAIL}")


def test_an_update_keeps_the_test_certificates_and_the_public_ip(tmp_path: Path) -> None:
    write(tmp_path)
    settings_file = tmp_path / "site/settings.env"
    settings_file.write_text(
        settings_file.read_text().replace("TLS_MODE=acme", "TLS_MODE=internal")
    )

    # update.sh: --yes, no --public-ip; detecting it again would call an outside service.
    body = (
        f"load_previous; {answers(RUN_KIND='update')}; YES=true; PUBLIC_IP=''; "
        "detect_public_ip; write_settings"
    )
    result = bash(tmp_path, body)

    assert result.returncode == 0, result.stderr
    assert settings(tmp_path)["TLS_MODE"] == "internal"
    assert settings(tmp_path)["PUBLIC_IP"] == "203.0.113.7"


def test_with_yes_an_unchanged_hostname_is_not_checked_again(tmp_path: Path) -> None:
    body = "YES=true; PUBLIC_IP=203.0.113.7; P_SITE_HOST=nowhere.invalid; ask_host; echo $SITE_HOST"

    result = bash(tmp_path, body)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "nowhere.invalid"


# --- update.sh and uninstall.sh ------------------------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        ["abc"],
        ["a" * 40, "extra"],
        ["v1.2"],
        ["1.2.3"],
        ["v1.02.3"],
        ["v1.2.3", "v1.2.4"],
        ["--force"],
    ],
)
def test_update_needs_a_version_or_one_full_commit(tmp_path: Path, args: list[str]) -> None:
    result = subprocess.run(
        ["bash", str(INSTALL / "update.sh"), *args],
        env={**SAFE_ENV, "AAP_ROOT": str(tmp_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert "usage: update.sh" in result.stderr


def test_update_needs_an_installation(tmp_path: Path) -> None:
    result = subprocess.run(
        ["bash", str(INSTALL / "update.sh"), "a" * 40],
        env={**SAFE_ENV, "AAP_ROOT": str(tmp_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    assert "no installation" in result.stderr


def test_uninstall_deletes_nothing_without_its_flag(tmp_path: Path) -> None:
    (tmp_path / "site").mkdir()

    result = subprocess.run(
        ["bash", str(INSTALL / "uninstall.sh")],
        env={**SAFE_ENV, "AAP_ROOT": str(tmp_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert (tmp_path / "site").exists()
