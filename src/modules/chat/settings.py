"""Settings of the building chat that the chairman changes (docs/API.md sections 9 and 14).

Read with `BuildingSettings(session).get(building_id, SPEC)`; core collects `SETTINGS`.
"""

from src.core.building_settings import BoolSetting

# Off by default: an unmoderated chat never appears in a building by itself (owner, 2026-11-15).
CHAT_ENABLED = BoolSetting("chat.enabled", default=False)

SETTINGS = (CHAT_ENABLED,)
