"""System texts of the posts the maintenance calendar publishes (messages.csv: key,en,ru,et).

A post is stored text, so it is written once in the instance language (DEFAULT_LOCALE). The
board's own words (task title, instructions, the notice) are values, never templates.
"""

from datetime import date
from functools import cache
from pathlib import Path

from src.core.messages import MessageCatalog
from src.modules.property.schemas import Locale

CATALOG_FILE = Path(__file__).with_name("messages.csv")


@cache
def maintenance_catalog() -> MessageCatalog:
    return MessageCatalog.from_csv(CATALOG_FILE, [locale.value for locale in Locale])


def local_date(day: date) -> str:
    return day.strftime("%d.%m.%Y")


def render(key: str, locale: str, **values: object) -> str:
    return maintenance_catalog().render(key, locale, **values)
