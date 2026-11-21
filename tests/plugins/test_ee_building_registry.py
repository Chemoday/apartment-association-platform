"""The Estonian building register provider on its own (epic E12 X2), against a fake register.

The answers below are hand-written in the shape of the real services (docs/external_providers/
ee/sources.md); every code, address and figure is invented, none belongs to a real building.
"""

import json
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from typing import Any

import httpx
import pytest

from src.core.config import Settings
from src.plugins.countries.ee.building_registry import EEBuildingRegistry
from src.plugins.countries.ee.facts import UnitKind
from src.plugins.outbound import MAX_RESPONSE_BYTES
from src.plugins.registry import PluginRegistry, RegistryBuildingNotFound, RegistryUnavailable
from tests.plugins.streams import streamed

CODE = "100000001"
OFFICE_PERSON = "Mari Maasikas"  # an invented person, as the register would name one


def building_answer() -> dict[str, Any]:
    return {
        "ehitis": {
            "ehitiseAndmed": {
                "ehrKood": CODE,
                "esmaneKasutus": "1971",
                "seisund": "EHITIS_SEISUND_OLEMA",
                "seisundTxt": "Olemas",
                "kaosIdPeamine": "11221",
                "kaosIdTxt": "Kolme või enama korteriga elamu",
            },
            "ehitisePohiandmed": {
                "lift": "1",
                "maxKorrusteArv": "5",
                "minKorrusteArv": None,
                "tubadeArv": "40",
                "mitteeluruumideArv": "0",
                "suletud_netopind": "2001.4",
                "koetavPind": "1890.0",
                "yldkasut_pind": "210.3",
                "abiruumidePind": "",
                "ehitisalunePind": "512.0",
                "mahtBruto": "8100",
                "korgus": "16,5",  # a comma: an unexpected form
                "omandiLiik": "EHITIS_OMANDI_LIIK_KINNIS",
                "omandiLiikTxt": "kinnisasi",
                "ehAlustKp": "1969-04-01T00:00:00.000",
            },
            "ehitiseKehand": {
                "kehand": [
                    {
                        "ehitiseOsad": {
                            "ehitiseOsa": [
                                part("10", "K", "61.2"),
                                part(None, "Y", "35.0", name="Üldkasutatav ala"),
                                part("2", "K", "48.5"),
                                part("14A", "K", "33.1"),
                                part("14", "K", "54.3"),
                                part("1", "M", "20.0", name="Äripind"),
                                part("3", "Q", "1.0"),
                            ]
                        }
                    }
                ]
            },
            "ehitiseEnergiamargised": {
                "energiamargis": [
                    {
                        "energiaKlass": "D",
                        "dok_nr": "9000001/00001",
                        "dokLiik": "Olemasoleva hoone energiamärgise teatis",
                        "seisund": "DO_DOKUSEIS_KEHTIV",
                        "energiaValjastKp": "2020-05-04T10:00:00.000",
                        "energiaKehtibKuniKp": "2030-05-03T10:00:00.000",
                        "etaKekVal": "182",
                        "etaKekType": "KEK",
                        "energiaTellija": OFFICE_PERSON,
                        "energiaValjastNimi": "Jaan Tamm",
                        "energiaValjastRegkood": "38001010000",
                        "kommentaar": "Call Mari at +372 5000 0000",
                    }
                ]
            },
            "ehitiseEnergiamargisedV3": {"energiamargis": []},
            "ehitiseTehnilisedNaitajad": {
                "tehnilineNaitaja": [
                    {
                        "klKood": "KONS_KKONSTR",
                        "klNimetus": "Kande- ja jäigastavate konstruktsioonide materjal",
                        "tenaId": "212",
                        "nimetus": "monoliitne raudbetoon",
                        "lisavaartus": "free text of the register",
                    },
                    {"klKood": None, "klNimetus": None, "tenaId": None, "nimetus": None},
                ]
            },
            "ehitiseKatastriyksused": {
                "ehitiseKatastriyksus": [
                    {"katastritunnus": "11111:111:1111"},
                    {"katastritunnus": "11111:111:1111"},
                ]
            },
            "ehitiseKujud": {"ruumikuju": [{"geometry": {"type": "Polygon", "coordinates": []}}]},
        }
    }


def part(number: str | None, kind: str, area: str, name: str | None = None) -> dict[str, Any]:
    return {
        "tahis": number,
        "liik": kind,
        "nimetus": name,
        "ehitiseOsaPohiandmed": {
            "pind": area,
            "tubadeArv": "2",
            "tualettruumide_arv": "1",
            "sissepaasuKorrus": "3",
            "koetavPind": None,
        },
    }


def search_answer() -> dict[str, Any]:
    building = {"liikVal": "EHITISHOONE", "taisaadress": "Harju maakond, Tallinn, Näidise tn 1"}
    return {
        "addresses": [
            {**building, "tunnus": CODE},
            {**building, "tunnus": CODE},  # the same building twice
            {**building, "tunnus": "100000002", "taisaadress": "Harju maakond, Näidise tn 1a"},
            {"liikVal": "KATASTRIYKSUS", "tunnus": "11111:111:1111", "taisaadress": "..."},
            {"liikVal": "EHITISHOONE", "tunnus": "", "taisaadress": "no code"},
        ]
    }


@pytest.fixture
def register(monkeypatch: pytest.MonkeyPatch) -> Callable[..., list[httpx.Request]]:
    """Answer the provider's requests with `handler`; returns the requests it made."""

    def install(handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        monkeypatch.setattr(EEBuildingRegistry, "http_transport", httpx.MockTransport(record))
        return seen

    return install


def answer(status: int, body: Any) -> Callable[[httpx.Request], httpx.Response]:
    return lambda request: streamed(status, json_body=body)


def test_the_plugin_registers_the_estonian_register() -> None:
    plugins = PluginRegistry(Settings())
    plugins.load(["countries.ee.building_registry"])
    assert isinstance(plugins.building_registry("ee"), EEBuildingRegistry)
    assert plugins.building_registry("LV") is None


async def test_search_lists_buildings_only_once_each(register) -> None:
    requests = register(answer(200, search_answer()))
    found = await EEBuildingRegistry().search("Näidise tn 1, Tallinn")

    assert [(c.code, c.address) for c in found] == [
        (CODE, "Harju maakond, Tallinn, Näidise tn 1"),
        ("100000002", "Harju maakond, Näidise tn 1a"),
    ]
    (request,) = requests
    assert request.url.host == "inaadress.maaamet.ee"
    assert request.url.params["address"] == "Näidise tn 1, Tallinn"
    assert request.headers["user-agent"] == "apartment-association-platform"


async def test_search_without_a_match_is_empty(register) -> None:
    register(answer(200, {"host": "x"}))
    assert await EEBuildingRegistry().search("nothing here") == []


async def test_the_block_follows_ee_1(register) -> None:
    requests = register(answer(200, building_answer()))
    facts = await EEBuildingRegistry().fetch(CODE)

    assert requests[0].url.host == "livekluster.ehr.ee"
    assert requests[0].url.params["ehr_code"] == CODE
    assert facts.country_code == "EE" and facts.schema_version == "ee/1"
    assert facts.source.building_code == CODE
    b = facts.building
    assert b.first_use_year == 1971
    assert b.purpose is not None and b.purpose.code == "11221"
    assert (b.floors_max, b.floors_min, b.lifts, b.rooms) == (5, None, 1, 40)
    assert b.closed_net_area_m2 == Decimal("2001.4") and b.volume_m3 == Decimal("8100")
    assert b.auxiliary_area_m2 is None, "an empty string is no value"
    assert b.height_m is None, "a comma is not a decimal point: dropped, not guessed"
    assert b.construction_started_on == date(1969, 4, 1)

    assert [(u.number, u.kind) for u in facts.units] == [
        ("1", UnitKind.NON_RESIDENTIAL),
        ("2", UnitKind.APARTMENT),
        ("3", UnitKind.OTHER),
        ("10", UnitKind.APARTMENT),
        ("14", UnitKind.APARTMENT),
        ("14A", UnitKind.APARTMENT),
        (None, UnitKind.COMMON),
    ]
    assert facts.units[1].area_m2 == Decimal("48.5")
    assert (facts.units[1].rooms, facts.units[1].toilets, facts.units[1].entrance_floor) == (
        2,
        1,
        3,
    )

    (certificate,) = facts.energy_certificates
    assert certificate.energy_class == "D"
    assert certificate.valid_until == date(2030, 5, 3)
    assert (certificate.value, certificate.value_type) == (182, "KEK")
    assert certificate.state is not None and certificate.state.code == "DO_DOKUSEIS_KEHTIV"

    (indicator,) = facts.technical
    assert (indicator.group.code, indicator.value.code) == ("KONS_KKONSTR", "212")
    assert [unit.code for unit in facts.cadastral_units] == ["11111:111:1111"]


async def test_no_person_free_text_or_geometry_leaves_the_plugin(register) -> None:
    register(answer(200, building_answer()))
    dumped = json.dumps(
        (await EEBuildingRegistry().fetch(CODE)).model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
    )
    for never in (OFFICE_PERSON, "Jaan Tamm", "38001010000", "+372", "free text", "Polygon"):
        assert never not in dumped, never
    assert '"schema": "ee/1"' in dumped and '"register": "EHR"' in dumped


async def test_dropped_fields_are_logged_by_name_only(register, log_capture) -> None:
    register(answer(200, building_answer()))
    await EEBuildingRegistry().fetch(CODE)
    (record,) = [r for r in log_capture.records if r["event"] == "ee_registry_fields_dropped"]
    assert record["fields"] == ["korgus"]
    assert "16,5" not in log_capture.raw


async def test_an_unknown_building_is_not_found(register) -> None:
    register(answer(400, {"message": "Building Not Found!"}))
    with pytest.raises(RegistryBuildingNotFound):
        await EEBuildingRegistry().fetch(CODE)


async def test_a_not_found_page_that_is_not_json_is_still_not_found(register) -> None:
    register(lambda request: streamed(404, text="<html>Not Found</html>"))
    with pytest.raises(RegistryBuildingNotFound):
        await EEBuildingRegistry().fetch(CODE)


async def test_the_apartment_draft_takes_numbered_apartments_only(register) -> None:
    """Epic E12 X3: the building template drafts apartments only; shops, common and unknown
    parts and apartments without a number are left out with their reason."""
    answer_ = building_answer()
    parts = answer_["ehitis"]["ehitiseKehand"]["kehand"][0]["ehitiseOsad"]["ehitiseOsa"]
    nameless = part("x", "K", "30.0")
    nameless.pop("tahis")
    parts.append(nameless)
    register(answer(200, answer_))
    provider = EEBuildingRegistry()

    draft = provider.apartment_draft(await provider.fetch(CODE))

    assert [(a.number, a.area_m2, a.floor) for a in draft.apartments] == [
        ("2", Decimal("48.5"), 3),
        ("10", Decimal("61.2"), 3),
        ("14", Decimal("54.3"), 3),
        ("14A", Decimal("33.1"), 3),
    ]
    assert sorted((p.number or "", p.reason) for p in draft.left_out) == [
        ("", "COMMON"),
        ("", "NO_NUMBER"),
        ("1", "NON_RESIDENTIAL"),
        ("3", "OTHER"),
    ]


async def test_odd_apartment_numbers_never_break_the_order(register) -> None:
    answer_ = building_answer()
    parts = answer_["ehitis"]["ehitiseKehand"]["kehand"][0]["ehitiseOsad"]["ehitiseOsa"]
    parts.append(part("1²", "K", "10.0"))
    parts.append(part("٣", "K", "10.0"))  # an Arabic-Indic digit
    register(answer(200, answer_))
    numbers = [unit.number for unit in (await EEBuildingRegistry().fetch(CODE)).units]
    assert numbers == ["1", "1²", "2", "3", "٣", "10", "14", "14A", None]


@pytest.mark.parametrize(
    "handler",
    [
        answer(500, {"error": "down"}),
        answer(400, {"error": "Validation failed"}),
        answer(200, {"unexpected": True}),
        lambda request: streamed(200, text="<html>maintenance</html>"),
        lambda request: streamed(302, headers={"location": "https://elsewhere.example"}),
        lambda request: streamed(200, content=b"x" * (MAX_RESPONSE_BYTES + 1)),
    ],
)
async def test_anything_unexpected_is_unavailable(register, handler) -> None:
    register(handler)
    with pytest.raises(RegistryUnavailable):
        await EEBuildingRegistry().fetch(CODE)


async def test_a_network_failure_is_unavailable(register) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    register(fail)
    with pytest.raises(RegistryUnavailable):
        await EEBuildingRegistry().search("Näidise tn 1")


async def test_a_malformed_code_never_reaches_the_register(register) -> None:
    requests = register(answer(200, building_answer()))
    provider = EEBuildingRegistry()
    for bad in ("12345", "1234567890123", "10000000x", "../1"):
        assert not provider.valid_code(bad)
        with pytest.raises(RegistryBuildingNotFound):
            await provider.fetch(bad)
    assert requests == []
