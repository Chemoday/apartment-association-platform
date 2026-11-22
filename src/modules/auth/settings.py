"""Settings of module auth that the chairman changes (docs/API.md sections 7 and 9).

Read with `BuildingSettings(session).get(building_id, SPEC)`; core collects `SETTINGS`.
"""

from src.core.building_settings import UrlSetting

# The association's own privacy notice for the join page (E13 R4c); "" = the platform's template.
PRIVACY_NOTICE_URL = UrlSetting("auth.privacy_notice_url")

SETTINGS = (PRIVACY_NOTICE_URL,)
