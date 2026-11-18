"""The operator command find-building (docs/API.md section 1, "Looking a building up in the
register"; epic E13 task R5a), against a fake register. No database."""

import io
import json
import subprocess
import sys
from collections.abc import Callable

import httpx
import pytest

from src.core.config import Settings
from src.modules.property.__main__ import find_building
from src.plugins.countries.ee.building_registry import EEBuildingRegistry
from tests.plugins.streams import streamed

ADDRESS = "Harju maakond, Tallinn, Näidise tn 1"
ENABLED = Settings(ENABLED_PLUGINS="common.csv_export,countries.ee.building_registry")


@pytest.fixture
def register(monkeypatch: pytest.MonkeyPatch) -> Callable[..., list[httpx.Request]]:
    def install(handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        monkeypatch.setattr(EEBuildingRegistry, "http_transport", httpx.MockTransport(record))
        return seen

    return install


def buildings(count: int) -> dict:
    return {
        "addresses": [
            {"liikVal": "EHITISHOONE", "tunnus": f"10000000{n}", "taisaadress": f"{ADDRESS}-{n}"}
            for n in range(count)
        ]
    }


async def run(settings: Settings = ENABLED, **options: str) -> tuple[int, str]:
    out = io.StringIO()
    code = await find_building(
        settings,
        address=options.get("address", "  Näidise   tn 1, Tallinn "),
        country=options.get("country", "ee"),
        out=out,
    )
    return code, out.getvalue()


async def test_the_matching_buildings_are_printed_as_json(register) -> None:
    seen = register(lambda request: streamed(200, json_body=buildings(3)))

    code, out = await run()

    assert code == 0
    assert json.loads(out) == {
        "status": "found",
        "candidates": [{"code": f"10000000{n}", "address": f"{ADDRESS}-{n}"} for n in range(3)],
    }
    assert out.count("\n") == 1 and "Näidise" in out  # one line, not escaped
    [request] = seen
    assert request.url.params["address"] == "Näidise tn 1, Tallinn"


async def test_no_match_is_an_empty_list(register) -> None:
    register(lambda request: streamed(200, json_body={"addresses": []}))

    assert await run() == (0, '{"status": "found", "candidates": []}\n')


async def test_a_register_that_does_not_answer_is_unavailable(register) -> None:
    register(lambda request: streamed(503, json_body={}))

    assert await run() == (3, '{"status": "unavailable"}\n')


async def test_without_a_provider_of_the_country(register) -> None:
    seen = register(lambda request: streamed(200, json_body=buildings(1)))

    assert await run(Settings(ENABLED_PLUGINS="common.csv_export")) == (
        4,
        '{"status": "no_provider"}\n',
    )
    assert await run(country="LV") == (4, '{"status": "no_provider"}\n')
    assert seen == []


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"address": "  ab  "}, "error: --address at least 3 characters besides spaces"),
        ({"address": "x" * 201}, "error: --address String should have at most 200 characters"),
        ({"address": "Näidise\x00tn"}, "error: --address text must not contain control"),
        ({"country": "ß"}, "error: --country two letters"),
    ],
)
async def test_invalid_options_ask_nothing(register, options: dict, message: str) -> None:
    seen = register(lambda request: streamed(200, json_body=buildings(1)))

    code, out = await run(**options)

    assert code == 2
    assert out.startswith(message), out
    assert seen == []


def test_the_command_runs_alone_without_a_database() -> None:
    """As the installer runs it, in a fresh interpreter; no provider is enabled here."""
    result = subprocess.run(
        [sys.executable, "-m", "src.modules.property", "find-building", "--address", "Näidise 1"],
        env={"PATH": "/usr/bin:/bin", "ENABLED_PLUGINS": "common.csv_export"},
        capture_output=True,
        text=True,
    )

    assert (result.returncode, result.stdout) == (4, '{"status": "no_provider"}\n')


async def test_at_most_ten_candidates_with_only_a_code_and_an_address(register) -> None:
    """docs/API.md section 1: at most 10 candidates; a building, never the people in it."""
    register(lambda request: streamed(200, json_body=buildings(15)))

    code, out = await run()

    assert code == 0
    body = json.loads(out)
    assert body["status"] == "found"
    assert len(body["candidates"]) == 10
    assert all(set(candidate) == {"code", "address"} for candidate in body["candidates"])


async def test_control_characters_from_the_register_stay_escaped_on_one_line(register) -> None:
    """The installer reads the last line of the output: a line break must not split it."""
    hostile = {
        "addresses": [
            {"liikVal": "EHITISHOONE", "tunnus": "101036416", "taisaadress": "Näidise\ntn\r1\t\x1b"}
        ]
    }
    register(lambda request: streamed(200, json_body=hostile))

    code, out = await run()

    assert code == 0
    assert out.count("\n") == 1 and out.endswith("\n")
    assert "\r" not in out and "\t" not in out and "\x1b" not in out
    [candidate] = json.loads(out)["candidates"]
    assert candidate["code"] == "101036416"
    assert "\n" not in candidate["address"]
