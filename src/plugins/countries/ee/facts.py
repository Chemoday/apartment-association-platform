"""The Estonian building facts block `ee/1` (docs/external_providers/ee/building_facts.md).

Pure models, no I/O: src/plugins/registry.py exposes them, so the API contract is the same
whether or not the plugin is enabled. No field for a person exists here, by design.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, WithJsonSchema

# A register figure (area, volume, height): a decimal string as the register gives it.
RegisterDecimal = Annotated[
    Decimal,
    PlainSerializer(lambda value: str(value), return_type=str),
    WithJsonSchema(
        {"type": "string", "pattern": r"^[0-9]+(\.[0-9]+)?$", "examples": ["10792.2"]},
        mode="serialization",
    ),
]

SCHEMA = "ee/1"


class _Block(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", json_schema_serialization_defaults_required=True
    )


class Classified(_Block):
    """A classified value of the register: its code and the register's Estonian text."""

    code: str | None
    label_et: str | None


class EESource(_Block):
    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        populate_by_name=True,
        json_schema_serialization_defaults_required=True,
    )

    # "register" would shadow an attribute of the model class; the JSON name stays "register".
    register_name: Literal["EHR"] = Field(default="EHR", alias="register")
    building_code: str
    fetched_at: datetime
    attribution: str = "Ehitisregister"


class EEBuilding(_Block):
    first_use_year: int | None = None
    purpose: Classified | None = None
    state: Classified | None = None
    ownership: Classified | None = None
    construction_started_on: date | None = None
    floors_max: int | None = None
    floors_min: int | None = None
    lifts: int | None = None
    rooms: int | None = None
    non_residential_units: int | None = None
    closed_net_area_m2: RegisterDecimal | None = None
    heated_area_m2: RegisterDecimal | None = None
    common_area_m2: RegisterDecimal | None = None
    auxiliary_area_m2: RegisterDecimal | None = None
    footprint_m2: RegisterDecimal | None = None
    volume_m3: RegisterDecimal | None = None
    height_m: RegisterDecimal | None = None


class UnitKind(StrEnum):
    APARTMENT = "APARTMENT"
    NON_RESIDENTIAL = "NON_RESIDENTIAL"
    COMMON = "COMMON"
    OTHER = "OTHER"


class EEUnit(_Block):
    number: str | None = None
    kind: UnitKind = UnitKind.OTHER
    area_m2: RegisterDecimal | None = None
    heated_area_m2: RegisterDecimal | None = None
    rooms: int | None = None
    toilets: int | None = None
    entrance_floor: int | None = None


class EEEnergyCertificate(_Block):
    energy_class: str | None = None
    document_number: str | None = None
    document_kind: Classified | None = None
    state: Classified | None = None
    issued_on: date | None = None
    valid_until: date | None = None
    value: int | None = None
    value_type: str | None = None


class EETechnical(_Block):
    group: Classified
    value: Classified


class EECadastralUnit(_Block):
    code: str


class EEBuildingFacts(_Block):
    """`registry_facts` of a building in Estonia. Serialise with `by_alias=True` (`schema`)."""

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        populate_by_name=True,
        json_schema_serialization_defaults_required=True,
    )

    country_code: Literal["EE"] = "EE"
    # "schema" would shadow a BaseModel attribute; the JSON name is still "schema".
    schema_version: Literal["ee/1"] = Field(default=SCHEMA, alias="schema")
    source: EESource
    building: EEBuilding
    units: list[EEUnit] = []
    energy_certificates: list[EEEnergyCertificate] = []
    technical: list[EETechnical] = []
    cadastral_units: list[EECadastralUnit] = []
