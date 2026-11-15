"""Estonian building register provider (plugin "countries.ee.building_registry", epic E12 X2).

Search: the In-ADS address service of Maa- ja Ruumiamet (buildings only). Fetch: the building
register's per-building endpoint, mapped to the block `ee/1`
(docs/external_providers/ee/building_facts.md). Both are public and need no key.

Never taken: who ordered or issued an energy certificate, free text, documents, geometry. A
field of an unexpected form becomes `None` (logged by name only), never an error for the user.
"""

import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, ClassVar

import httpx
import structlog

from src.plugins.countries.ee.facts import (
    SCHEMA,
    Classified,
    EEBuilding,
    EEBuildingFacts,
    EECadastralUnit,
    EEEnergyCertificate,
    EESource,
    EETechnical,
    EEUnit,
    UnitKind,
)
from src.plugins.outbound import OutboundError, get_json
from src.plugins.registry import (
    PluginRegistry,
    RegistryBuildingNotFound,
    RegistryCandidate,
    RegistryUnavailable,
)

logger = structlog.get_logger(__name__)

SEARCH_URL = "https://inaadress.maaamet.ee/inaadress/gazetteer"
BUILDING_URL = "https://livekluster.ehr.ee/api/building/v2/buildingData"
ALLOWED_HOSTS = frozenset({"inaadress.maaamet.ee", "livekluster.ehr.ee"})
MAX_CANDIDATES = 10
BUILDING_KIND = "EHITISHOONE"  # In-ADS object type of a building
VALID_CERTIFICATE = "DO_DOKUSEIS_KEHTIV"  # the register's state of a valid certificate
_CODE = re.compile(r"[0-9]{6,12}")
_WHOLE = re.compile(r"[0-9]{1,9}")
_DECIMAL = re.compile(r"[0-9]{1,12}(\.[0-9]{1,6})?")
_DATE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})")
_TEXT_MAX = 200
_UNIT_KINDS = {"K": UnitKind.APARTMENT, "M": UnitKind.NON_RESIDENTIAL, "Y": UnitKind.COMMON}


class EEBuildingRegistry:
    country_code = "EE"
    schema = SCHEMA
    # Tests swap in an httpx.MockTransport (a fake register); None means the real network.
    http_transport: ClassVar[httpx.AsyncBaseTransport | None] = None

    def valid_code(self, code: str) -> bool:
        return bool(_CODE.fullmatch(code))

    async def search(self, query: str) -> list[RegistryCandidate]:
        status, body = await self._get(SEARCH_URL, {"address": query, "results": "20"})
        if status != 200:
            raise RegistryUnavailable()
        found: list[RegistryCandidate] = []
        for item in _list(_dict(body).get("addresses")):
            item = _dict(item)
            code = _text(item.get("tunnus"))
            if item.get("liikVal") != BUILDING_KIND or not code or not _CODE.fullmatch(code):
                continue
            if any(candidate.code == code for candidate in found):
                continue
            address = _text(item.get("taisaadress")) or _text(item.get("pikkaadress")) or code
            found.append(RegistryCandidate(code=code, address=address, kind_label=BUILDING_KIND))
            if len(found) == MAX_CANDIDATES:
                break
        return found

    async def fetch(self, code: str) -> EEBuildingFacts:
        if not self.valid_code(code):
            raise RegistryBuildingNotFound()
        status, body = await self._get(BUILDING_URL, {"ehr_code": code})
        message = str(_dict(body).get("message", "")).lower()
        if status == 404 or (status == 400 and "not found" in message):
            raise RegistryBuildingNotFound()
        building = _dict(body).get("ehitis")
        if status != 200 or not isinstance(building, dict):
            raise RegistryUnavailable()
        mapper = _Mapper()
        return mapper.facts(code, building)

    def certificate_valid_until(self, block: EEBuildingFacts) -> date | None:
        """The latest validity among the certificates the register marks valid; None without one
        (an annulled certificate is never reported as expiring)."""
        dates = [
            c.valid_until
            for c in block.energy_certificates
            if c.valid_until is not None
            and c.state is not None
            and c.state.code == VALID_CERTIFICATE
        ]
        return max(dates) if dates else None

    async def _get(self, url: str, params: dict[str, str]) -> tuple[int, Any]:
        try:
            return await get_json(url, params, ALLOWED_HOSTS, transport=self.http_transport)
        except OutboundError as exc:
            logger.warning("ee_registry_unavailable", reason=exc.reason, status=exc.status)
            raise RegistryUnavailable() from None


class _Mapper:
    """Maps one answer of the building register; remembers the fields it had to drop."""

    def __init__(self) -> None:
        self.dropped: set[str] = set()

    def facts(self, code: str, e: dict[str, Any]) -> EEBuildingFacts:
        facts = EEBuildingFacts(
            source=EESource(
                building_code=_text(_dict(e.get("ehitiseAndmed")).get("ehrKood")) or code,
                fetched_at=datetime.now(UTC),
            ),
            building=self.building(e),
            units=self.units(e),
            energy_certificates=self.certificates(e),
            technical=self.technical(e),
            cadastral_units=self.cadastral(e),
        )
        if self.dropped:  # names only: values could be anything
            logger.info("ee_registry_fields_dropped", fields=sorted(self.dropped))
        return facts

    def building(self, e: dict[str, Any]) -> EEBuilding:
        a, p = _dict(e.get("ehitiseAndmed")), _dict(e.get("ehitisePohiandmed"))
        return EEBuilding(
            first_use_year=self.as_int(a, "esmaneKasutus"),
            purpose=_classified(a.get("kaosIdPeamine"), a.get("kaosIdTxt")),
            state=_classified(a.get("seisund"), a.get("seisundTxt")),
            ownership=_classified(p.get("omandiLiik"), p.get("omandiLiikTxt")),
            construction_started_on=self.as_date(p, "ehAlustKp"),
            floors_max=self.as_int(p, "maxKorrusteArv"),
            floors_min=self.as_int(p, "minKorrusteArv"),
            lifts=self.as_int(p, "lift"),
            rooms=self.as_int(p, "tubadeArv"),
            non_residential_units=self.as_int(p, "mitteeluruumideArv"),
            closed_net_area_m2=self.as_decimal(p, "suletud_netopind"),
            heated_area_m2=self.as_decimal(p, "koetavPind"),
            common_area_m2=self.as_decimal(p, "yldkasut_pind"),
            auxiliary_area_m2=self.as_decimal(p, "abiruumidePind"),
            footprint_m2=self.as_decimal(p, "ehitisalunePind"),
            volume_m3=self.as_decimal(p, "mahtBruto"),
            height_m=self.as_decimal(p, "korgus"),
        )

    def units(self, e: dict[str, Any]) -> list[EEUnit]:
        units = []
        for body in _list(_dict(e.get("ehitiseKehand")).get("kehand")):
            for part in _list(_dict(_dict(body).get("ehitiseOsad")).get("ehitiseOsa")):
                part = _dict(part)
                basics = _dict(part.get("ehitiseOsaPohiandmed"))
                units.append(
                    EEUnit(
                        number=_text(part.get("tahis")),
                        kind=_UNIT_KINDS.get(str(part.get("liik", "")).upper(), UnitKind.OTHER),
                        area_m2=self.as_decimal(basics, "pind"),
                        heated_area_m2=self.as_decimal(basics, "koetavPind"),
                        rooms=self.as_int(basics, "tubadeArv"),
                        toilets=self.as_int(basics, "tualettruumide_arv"),
                        entrance_floor=self.as_int(basics, "sissepaasuKorrus"),
                    )
                )
        return sorted(units, key=lambda unit: (unit.number is None, _natural(unit.number or "")))

    def certificates(self, e: dict[str, Any]) -> list[EEEnergyCertificate]:
        certificates = []
        for item in _list(_dict(e.get("ehitiseEnergiamargised")).get("energiamargis")):
            item = _dict(item)
            certificates.append(
                EEEnergyCertificate(
                    energy_class=_text(item.get("energiaKlass")),
                    document_number=_text(item.get("dok_nr")),
                    document_kind=_classified(None, item.get("dokLiik")),
                    state=_classified(item.get("seisund"), None),
                    issued_on=self.as_date(item, "energiaValjastKp"),
                    valid_until=self.as_date(item, "energiaKehtibKuniKp"),
                    value=self.as_int(item, "etaKekVal"),
                    value_type=_text(item.get("etaKekType")),
                )
            )
        return certificates

    def technical(self, e: dict[str, Any]) -> list[EETechnical]:
        indicators = []
        for item in _list(_dict(e.get("ehitiseTehnilisedNaitajad")).get("tehnilineNaitaja")):
            item = _dict(item)
            group = _classified(item.get("klKood"), item.get("klNimetus"))
            value = _classified(item.get("tenaId"), item.get("nimetus"))
            if group is not None and value is not None:
                indicators.append(EETechnical(group=group, value=value))
        return indicators

    def cadastral(self, e: dict[str, Any]) -> list[EECadastralUnit]:
        codes = []
        for item in _list(_dict(e.get("ehitiseKatastriyksused")).get("ehitiseKatastriyksus")):
            code = _text(_dict(item).get("katastritunnus"))
            if code and code not in codes:
                codes.append(code)
        return [EECadastralUnit(code=code) for code in codes]

    # --- Strict parsing: an unexpected form becomes None and the field name is remembered ------

    def as_int(self, source: dict[str, Any], key: str) -> int | None:
        value = source.get(key)
        if value is None or value == "":
            return None
        text = str(value).strip()
        if isinstance(value, bool) or not _WHOLE.fullmatch(text):
            self.dropped.add(key)
            return None
        return int(text)

    def as_decimal(self, source: dict[str, Any], key: str) -> Decimal | None:
        value = source.get(key)
        if value is None or value == "":
            return None
        text = str(value).strip()
        if isinstance(value, bool) or not _DECIMAL.fullmatch(text):
            self.dropped.add(key)
            return None
        return Decimal(text)

    def as_date(self, source: dict[str, Any], key: str) -> date | None:
        value = source.get(key)
        if value is None or value == "":
            return None
        match = _DATE.match(str(value))
        if match:
            try:
                return date.fromisoformat(match.group(1))
            except ValueError:
                pass
        self.dropped.add(key)
        return None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str | None:
    if not isinstance(value, str | int) or isinstance(value, bool):
        return None
    text = " ".join(str(value).split())
    return text[:_TEXT_MAX] or None


def _classified(code: Any, label: Any) -> Classified | None:
    code_text, label_text = _text(code), _text(label)
    if code_text is None and label_text is None:
        return None
    return Classified(code=code_text, label_et=label_text)


def _natural(number: str) -> list[Any]:
    """ "2" < "10" < "14" < "14A"."""
    return [
        (0, int(part), "") if part.isdecimal() else (1, 0, part)
        for part in re.split(r"([0-9]+)", number)
        if part
    ]


def register(registry: PluginRegistry) -> None:
    registry.register_building_registry(EEBuildingRegistry())
