"""QA pass over the installer's building template step (install/install.sh `ask_building`,
`create_building`, `write_building_template`, `finish`; docs/API.md section 1, "Filling the
building of a new installation"; docs/epics/E13_ROLLOUT.md section 6a, "The installer").

The functions are sourced into bash with the stub docker of tests/ops/test_install_security.py.
A thin wrapper in front of it adds what these tests need: a register lookup that fails, a
template command with a given output, a building that exists already.
"""

import os
import shlex
import stat
from pathlib import Path

import pytest

from tests.ops.test_install import ADDRESS, bash
from tests.ops.test_install_security import (
    NAME,
    REGISTER_ADDRESS,
    TEMPLATE_RUN,
    _stub_docker,
)

TWO_MATCHES = (
    '{"status": "found", "candidates": ['
    '{"code": "101036416", "address": "Harju maakond, Tallinn, Proovi tn 1"}, '
    '{"code": "101036417", "address": "Harju maakond, Tallinn, Proovi tn 1a"}]}'
)

WRAPPER = """#!/usr/bin/env bash
# QA cases in front of the stub of test_install_security.py; everything else goes to it.
if [[ "$1" == run && " $* " == *" find-building "* && -n "${QA_FIND_EXIT:-}" ]]; then
    printf '%s\\n' "$*" >> "$STUB_CALLS"
    echo '{"status": "unavailable"}'
    exit "$QA_FIND_EXIT"
fi
if [[ "$1" == exec && " $* " == *" create-building "* && -n "${QA_BUILDING_EXISTS:-}" ]]; then
    printf '%s\\n' "$*" >> "$STUB_CALLS"
    echo "error: the installation already has a building"
    exit 1
fi
if [[ "$1" == exec && " $* " == *" building-template "* && -n "${QA_TEMPLATE:-}" ]]; then
    printf '%s\\n' "$*" >> "$STUB_CALLS"
    exec bash "$QA_TEMPLATE"
fi
exec "$(dirname "$0")/docker-base" "$@"
"""


def stub(tmp_path: Path, template: str | None = None, **extra: str) -> dict[str, str]:
    """The stub docker of test_install_security with the QA wrapper; `template` is a bash body
    that plays the template command (its standard output is the template)."""
    env = _stub_docker(tmp_path, **extra)
    bin_dir = tmp_path / "stub-bin"
    (bin_dir / "docker").rename(bin_dir / "docker-base")
    wrapper = bin_dir / "docker"
    wrapper.write_text(WRAPPER)
    wrapper.chmod(0o755)
    if template is not None:
        script = tmp_path / "template.sh"
        script.write_text(template)
        env["QA_TEMPLATE"] = str(script)
    return env


def calls(tmp_path: Path) -> str:
    path = tmp_path / "docker.calls"
    return path.read_text() if path.exists() else ""


def log_of(root: Path) -> str:
    return (root / "install.log").read_text()


TEMPLATE_FILE = "site/building-template.csv"
COUNTED = "building-template --out - --apartments <N>"


# --- Which building the template is drafted for ----------------------------------------------


def test_with_several_matches_the_building_code_picks_the_template_building(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, STUB_FIND_JSON=TWO_MATCHES)

    result = bash(root, f"A_BUILDING_CODE=101036417; {TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    made = calls(tmp_path)
    assert "--from-register 101036417" in made
    assert "--from-register 101036416" not in made
    assert "--address Harju maakond, Tallinn, Proovi tn 1a --country EE" in made
    assert (root / TEMPLATE_FILE).exists()
    assert COUNTED not in result.stdout


def test_with_several_matches_and_no_code_no_template_is_drafted(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, STUB_FIND_JSON=TWO_MATCHES)

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert "Several buildings match" in result.stdout
    assert " building-template " not in calls(tmp_path)
    assert f"--address {ADDRESS} --country EE" in calls(tmp_path)  # kept as typed
    assert not (root / TEMPLATE_FILE).exists()
    assert COUNTED in result.stdout


def _interactive(answers: list[str]) -> str:
    """ask_building on a terminal: `ask` gives the answers in order (the address, the pick,
    the association's name, its registry code)."""
    quoted = " ".join(shlex.quote(answer) for answer in answers)
    return (
        "YES=false; MODE=real; COUNTRY=EE; RUN_KIND=install; SITE_HOST=kyhistu.example.ee; "
        f"SMTP_HOST=''; ANSWERS=({quoted}); N=0; "
        'ask() { printf -v "$1" "%s" "${ANSWERS[$N]:-${3:-}}"; N=$((N + 1)); }; '
        'install -d "$AAP_ROOT/site"; log_line start; '
        "ask_building; create_building; write_building_template; finish"
    )


def test_a_building_picked_on_the_terminal_gets_its_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, STUB_FIND_JSON=TWO_MATCHES)

    result = bash(root, _interactive([ADDRESS, "2", NAME, ""]), **env)

    assert result.returncode == 0, result.stderr
    assert "--from-register 101036417" in calls(tmp_path)
    assert (root / TEMPLATE_FILE).exists()
    assert "holds those of the register" in result.stdout
    for private in (ADDRESS, NAME, "Proovi"):
        assert private not in log_of(root)


def test_none_of_the_matches_on_the_terminal_drafts_no_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, STUB_FIND_JSON=TWO_MATCHES)

    result = bash(root, _interactive([ADDRESS, "0", NAME, ""]), **env)

    assert result.returncode == 0, result.stderr
    assert " building-template " not in calls(tmp_path)
    assert f"--address {ADDRESS} --country EE" in calls(tmp_path)
    assert COUNTED in result.stdout


@pytest.mark.parametrize(
    ("status", "said"),
    [("3", "The register does not answer now"), ("4", "There is no register for EE")],
)
def test_a_register_that_is_down_or_missing_drafts_no_template(
    tmp_path: Path, status: str, said: str
) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, QA_FIND_EXIT=status)

    result = bash(root, f"A_BUILDING_CODE=101036416; {TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert said in result.stdout
    assert " building-template " not in calls(tmp_path)
    assert not (root / TEMPLATE_FILE).exists()
    assert COUNTED in result.stdout
    assert f"building lookup failed status={status}" in log_of(root)


# --- When the step does not run -----------------------------------------------------------------


def test_a_demo_never_drafts_a_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path)

    result = bash(
        root,
        "MODE=demo; BUILDING_KNOWN=false; BUILDING_CODE=101036416; SITE_HOST=x.example.ee; "
        'SMTP_HOST=""; install -d "$AAP_ROOT/site"; write_building_template; finish',
        **env,
    )

    assert result.returncode == 0, result.stderr
    assert calls(tmp_path) == ""
    assert not (root / TEMPLATE_FILE).exists()
    assert "building-template" not in result.stdout and "import-building" not in result.stdout


def test_a_re_run_of_a_known_building_never_drafts_a_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path)

    result = bash(
        root,
        "MODE=real; BUILDING_KNOWN=true; BUILDING_CODE=101036416; "
        'install -d "$AAP_ROOT/site"; write_building_template',
        **env,
    )

    assert result.returncode == 0, result.stderr
    assert calls(tmp_path) == ""
    assert not (root / TEMPLATE_FILE).exists()


def test_a_building_that_exists_already_still_gets_a_template_attempt_and_a_clear_note(
    tmp_path: Path,
) -> None:
    """A re-run with --building-address: the building is kept; the template command itself
    refuses a filled building, and the installer passes its reason on."""
    root = tmp_path / "aap"
    env = stub(
        tmp_path,
        template=(
            "echo 'error: the building already has apartments or meters: a new building is "
            "filled once' >&2; exit 1"
        ),
        QA_BUILDING_EXISTS="1",
    )

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert "The building exists already; it is kept as it is." in result.stdout
    assert (
        "note: the building template was not written (the building already has apartments "
        "or meters: a new building is filled once)."
    ) in result.stdout
    assert not (root / TEMPLATE_FILE).exists()
    assert "building template failed status=1" in log_of(root)


# --- What is written ----------------------------------------------------------------------------


def test_a_template_command_that_prints_nothing_leaves_no_file(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path, template="echo 'template - written: 0 apartments' >&2; exit 0")

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert not (root / TEMPLATE_FILE).exists()
    assert not (root / f"{TEMPLATE_FILE}.new").exists()
    assert "note: the building template was not written." in result.stdout
    # The register found the building: the next steps name it instead of a counted template.
    assert "building-template --out - --from-register 101036416 >" in result.stdout


def test_a_leftover_of_an_interrupted_run_never_becomes_the_template(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    (root / "site").mkdir(parents=True)
    (root / f"{TEMPLATE_FILE}.new").write_text("half a template of an earlier run\n")
    (root / f"{TEMPLATE_FILE}.err").write_text("error: an old message\n")
    env = stub(tmp_path, template="printf 'apartment;entrance\\r\\n1;1\\r\\n'")

    result = bash(root, TEMPLATE_RUN, **env)

    assert result.returncode == 0, result.stderr
    assert (root / TEMPLATE_FILE).read_bytes() == b"apartment;entrance\r\n1;1\r\n"
    assert not (root / f"{TEMPLATE_FILE}.new").exists()
    assert not (root / f"{TEMPLATE_FILE}.err").exists()
    assert "an old message" not in result.stdout


def test_the_template_is_readable_and_its_side_files_are_gone(tmp_path: Path) -> None:
    root = tmp_path / "aap"
    env = stub(tmp_path)

    result = bash(root, TEMPLATE_RUN, **env)

    assert result.returncode == 0, result.stderr
    mode = stat.S_IMODE((root / TEMPLATE_FILE).stat().st_mode)
    assert mode == 0o644
    assert sorted(p.name for p in (root / "site").iterdir() if "template" in p.name) == [
        "building-template.csv"
    ]


def test_a_failed_template_shows_only_the_last_error_and_logs_only_its_status(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    env = stub(
        tmp_path,
        template=(
            "printf 'apartment;entrance\\r\\n'; "
            "echo 'a traceback line with Proovi tn 1' >&2; "
            "echo 'error: first' >&2; "
            "echo 'error: the register does not answer usably; try again later' >&2; exit 3"
        ),
    )

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert not (root / TEMPLATE_FILE).exists()  # a partial output is never kept
    assert (
        "note: the building template was not written (the register does not answer usably; "
        "try again later)."
    ) in result.stdout
    assert "error: first" not in result.stdout and "traceback" not in result.stdout
    log = log_of(root)
    assert "building template failed status=3" in log
    for private in ("Proovi", "register does not answer", ADDRESS, REGISTER_ADDRESS):
        assert private not in log


def test_left_out_parts_reach_the_screen_without_terminal_control_characters(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aap"
    env = stub(
        tmp_path,
        template=(
            "printf 'apartment;entrance\\r\\n1;1\\r\\n'; "
            "printf 'left out: part K\\033]0;owned\\007\\033[2J1 (NON_RESIDENTIAL)\\n' >&2"
        ),
    )

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert "left out: part " in result.stdout
    assert "\x1b" not in result.stdout and "\x07" not in result.stdout


# --- The next steps -----------------------------------------------------------------------------


@pytest.mark.parametrize("found", [True, False])
def test_the_next_steps_move_the_template_through_stdin_and_stdout_of_the_container(
    tmp_path: Path, found: bool
) -> None:
    """Paths inside the backend container are not the host's: the printed commands must pipe
    the file (`--out -` with `>`, `--file -` with `docker exec -i` and `<`)."""
    root = tmp_path / "aap"
    lookup = {} if found else {"STUB_FIND_JSON": '{"status": "found", "candidates": []}'}

    result = bash(root, f"{TEMPLATE_RUN}; finish", **stub(tmp_path, **lookup))

    assert result.returncode == 0, result.stderr
    template = root / TEMPLATE_FILE
    assert template.exists() is found
    tool = "python -m src.core.filling"
    assert (
        f"docker exec -i aap-site-backend-1 {tool} import-building --file - --dry-run < {template}"
    ) in result.stdout
    drafted = f"docker exec aap-site-backend-1 {tool} {COUNTED} > {template}"
    assert (drafted in result.stdout) is not found
    assert "--out " + str(root) not in result.stdout


def test_the_installer_never_runs_the_import_itself(tmp_path: Path) -> None:
    """The chairman fills the template first; the installer only prints the import."""
    root = tmp_path / "aap"
    env = stub(tmp_path)

    result = bash(root, f"{TEMPLATE_RUN}; finish", **env)

    assert result.returncode == 0, result.stderr
    assert "import-building" not in calls(tmp_path)
    assert os.path.getsize(root / TEMPLATE_FILE) > 0
