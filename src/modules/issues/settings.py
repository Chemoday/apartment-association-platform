"""Settings of the issue tracker that the chairman changes (epic E9; docs/API.md section 9).

Read with `BuildingSettings(session).get(building_id, SPEC)`; core collects `SETTINGS`.
"""

from src.core.building_settings import BoolSetting, IntSetting

REPORTS_PER_APARTMENT_PER_DAY = IntSetting(
    "issues.reports_per_apartment_per_day", default=3, minimum=1, maximum=20
)
URGENT_ENABLED = BoolSetting("issues.urgent_enabled", default=False)
URGENT_PER_APARTMENT_PER_DAY = IntSetting(
    "issues.urgent_per_apartment_per_day", default=1, minimum=1, maximum=5
)

# How long the photos of an issue are kept after it ended (epic E11, task F2).
PHOTO_RETENTION_MONTHS = IntSetting(
    "issues.photo_retention_months", default=12, minimum=1, maximum=60
)

SETTINGS = (
    REPORTS_PER_APARTMENT_PER_DAY,
    URGENT_ENABLED,
    URGENT_PER_APARTMENT_PER_DAY,
    PHOTO_RETENTION_MONTHS,
)
