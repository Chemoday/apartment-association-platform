"""Settings of the maintenance calendar that the chairman changes (epic E10; docs/API.md 9)."""

from src.core.building_settings import IntSetting

OVERDUE_REMINDER_DAYS = IntSetting(
    "maintenance.overdue_reminder_days", default=7, minimum=1, maximum=30
)

SETTINGS = (OVERDUE_REMINDER_DAYS,)
