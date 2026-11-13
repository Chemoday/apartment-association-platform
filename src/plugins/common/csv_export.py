"""CSV export of a period's readings (enabled as plugin "common.csv_export")."""

from collections.abc import Iterable, Iterator

from src.core.csv_safety import csv_lines, neutralize_formula
from src.plugins.registry import PluginRegistry, ReadingExportRow

__all__ = ["COLUMNS", "CsvReadingExporter", "neutralize_formula", "register"]

COLUMNS = (
    "period_code",
    "entrance",
    "apartment_number",
    "meter_id",
    "resource_type",
    "serial_number",
    "location_label",
    "unit",
    "previous_value",
    "value",
    "consumption_delta",
    "source",
    "is_anomaly_confirmed",
    "recorded_at",
)
MASTER_METER_LABEL = "MASTER"


class CsvReadingExporter:
    name = "csv"
    media_type = "text/csv; charset=utf-8"
    file_extension = "csv"

    def render(self, rows: Iterable[ReadingExportRow]) -> Iterator[str]:
        return csv_lines(COLUMNS, (_cells(row) for row in rows))


def _cells(row: ReadingExportRow) -> list[object]:
    return [
        row.period_code,
        "" if row.entrance is None else row.entrance,
        neutralize_formula(row.apartment_number or MASTER_METER_LABEL),
        row.meter_id,
        row.resource_type,
        neutralize_formula(row.serial_number),
        neutralize_formula(row.location_label),
        row.unit,
        row.previous_value,
        row.value,
        row.consumption_delta,
        row.source,
        "true" if row.is_anomaly_confirmed else "false",
        row.recorded_at.isoformat(),
    ]


def register(registry: PluginRegistry) -> None:
    registry.register_exporter(CsvReadingExporter())
