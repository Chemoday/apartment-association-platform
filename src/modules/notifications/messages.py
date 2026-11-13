"""Texts of messages sent outside the app (pure functions; docs/ARCHITECTURE.md 3.2).

Two kinds (owner decision, E1 section 5):
- custom: an emergency is the post's title and body exactly as the board wrote them;
- system: every other text comes from messages.csv (`key,en,ru,et`), in the delivery's locale,
  with English when a cell is empty. The chairman cannot change them.

The catalog format and its loader live in src/core/messages.py (shared with module auth).
"""

__all__ = [
    "MessageCatalog",
    "MessageCatalogError",
    "compose",
    "default_catalog",
    "email_text",
    "placeholders",
]

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from functools import cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from src.core.messages import MessageCatalog, MessageCatalogError, placeholders
from src.modules.notifications.schemas import NotificationEventType
from src.modules.property.schemas import Locale
from src.plugins.registry import SIGNATURE_SEPARATOR

CATALOG_FILE = Path(__file__).with_name("messages.csv")
LOCALES = tuple(locale.value for locale in Locale)


@cache
def default_catalog() -> MessageCatalog:
    return MessageCatalog.from_csv(CATALOG_FILE, LOCALES)


@dataclass(frozen=True)
class RenderedMessage:
    subject: str
    text: str
    footer: str

    @property
    def body(self) -> str:
        """The text and the footer, as e-mail and Telegram show them."""
        return f"{self.text}{SIGNATURE_SEPARATOR}{self.footer}"


def _target(catalog: MessageCatalog, locale: str, params: Mapping[str, Any]) -> str:
    scope = params.get("target_scope") or "ALL_BUILDING"
    return catalog.render(f"target.{scope}", locale, entrance=params.get("target_entrance"))


def _local_date(value: str, timezone: str) -> str:
    return datetime.fromisoformat(value).astimezone(ZoneInfo(timezone)).strftime("%d.%m.%Y")


def _short_date(value: str) -> str:
    """A calendar date (YYYY-MM-DD) as the texts write it."""
    return date.fromisoformat(value).strftime("%d.%m.%Y")


def _issue_location(catalog: MessageCatalog, locale: str, entrance: object) -> str:
    if entrance is None:
        return catalog.render("issue.location.OUTSIDE", locale)
    return catalog.render("target.ENTRANCE", locale, entrance=entrance)


def compose(
    event_type: NotificationEventType,
    locale: str,
    params: Mapping[str, Any],
    *,
    site_url: str,
    timezone: str,
    title: str = "",
    body: str = "",
    catalog: MessageCatalog | None = None,
) -> RenderedMessage:
    """Subject and plain-text body of one external message.

    `title` and `body` are the emergency's own text (EMERGENCY_* only); everything else comes
    from the catalog. Every message ends with the footer that links to the site.
    """
    catalog = catalog or default_catalog()
    E = NotificationEventType
    subject_key = f"subject.{event_type.value}"
    if event_type == E.EMERGENCY_PUBLISHED:
        subject = catalog.render(subject_key, locale, title=title)
        affected = catalog.render("line.affected", locale, target=_target(catalog, locale, params))
        text = f"{body}\n\n{affected}"
    elif event_type == E.EMERGENCY_RESOLVED:
        subject = catalog.render(subject_key, locale, title=title)
        affected = catalog.render("line.affected", locale, target=_target(catalog, locale, params))
        text = f"{catalog.render('text.EMERGENCY_RESOLVED', locale, title=title)}\n\n{affected}"
    elif event_type == E.READING_DEADLINE:
        period_code = params["period_code"]
        subject = catalog.render(subject_key, locale, period_code=period_code)
        text = catalog.render(
            "text.READING_DEADLINE",
            locale,
            period_code=period_code,
            due_date=_local_date(params["due_date"], timezone),
        )
    elif event_type == E.PERIOD_REVIEW:
        period_code = params["period_code"]
        subject = catalog.render(subject_key, locale, period_code=period_code)
        text = catalog.render("text.PERIOD_REVIEW", locale, period_code=period_code)
    elif event_type == E.APARTMENT_MESSAGE:
        # Who wrote decides the wording; the message itself never leaves the app.
        key = "FROM_BOARD" if params.get("from_board") else "FROM_RESIDENT"
        subject = catalog.render(f"subject.APARTMENT_MESSAGE.{key}", locale)
        text = catalog.render(f"text.APARTMENT_MESSAGE.{key}", locale)
    elif event_type == E.APARTMENT_MESSAGE_TO_BOARD:
        number = params["apartment_number"]
        subject = catalog.render(subject_key, locale, apartment_number=number)
        text = catalog.render("text.APARTMENT_MESSAGE_TO_BOARD", locale, apartment_number=number)
    elif event_type == E.POLL_OPENED:  # no title and no questions, only the local deadline
        subject = catalog.render(subject_key, locale)
        text = catalog.render(
            "text.POLL_OPENED", locale, closes_at=_local_date(params["closes_at"], timezone)
        )
    elif event_type == E.MAINTENANCE_DUE:  # the board's own task title, to the board only
        values = {"title": params["title"], "due_date": _short_date(params["due_date"])}
        subject = catalog.render(subject_key, locale, **values)
        if params.get("overdue"):
            text = catalog.render(
                "text.MAINTENANCE_DUE.OVERDUE",
                locale,
                number=params.get("reminder_number", 0),
                **values,
            )
        else:
            text = catalog.render("text.MAINTENANCE_DUE", locale, **values)
    elif event_type == E.STORAGE_ALMOST_FULL:
        subject = catalog.render(subject_key, locale, used_percent=params["used_percent"])
        text = catalog.render(
            "text.STORAGE_ALMOST_FULL", locale, used_percent=params["used_percent"]
        )
    elif event_type == E.NOTICE_PUBLISHED:  # only that there is a notice, never its text
        subject = catalog.render(subject_key, locale)
        text = catalog.render("text.NOTICE_PUBLISHED", locale)
    else:  # ISSUE_*: the category, the location and the status, never what a resident wrote
        where = {
            "category": catalog.render(f"issue.category.{params['category']}", locale),
            "location": _issue_location(catalog, locale, params.get("entrance")),
        }
        subject = catalog.render(subject_key, locale, **where)
        if event_type != E.ISSUE_STATUS_CHANGED:
            text = catalog.render(f"text.{event_type.value}", locale, **where)
        elif params.get("merged"):
            text = catalog.render("text.ISSUE_STATUS_CHANGED.MERGED", locale, **where)
        else:
            status = catalog.render(f"issue.status.{params['status']}", locale)
            text = catalog.render("text.ISSUE_STATUS_CHANGED", locale, status=status, **where)
    footer = catalog.render("footer", locale, site_url=site_url)
    # A subject is one line: a title may contain line breaks (also U+2028), which a mail header
    # cannot carry, and the mandatory alert must not fail because of them.
    subject = " ".join(subject.split())
    return RenderedMessage(subject=subject, text=text, footer=footer)


def email_text(
    event_type: NotificationEventType,
    locale: str,
    text: str,
    *,
    unsubscribe_link: str | None,
    catalog: MessageCatalog | None = None,
) -> str:
    """The text of an e-mail (N8): a non-mandatory one ends with its unsubscribe link, an
    emergency with the note that alerts cannot be switched off."""
    catalog = catalog or default_catalog()
    if unsubscribe_link is None:
        key = "line.mandatory.ISSUE_URGENT"
        if event_type != NotificationEventType.ISSUE_URGENT:
            key = "line.mandatory"
        return f"{text}\n\n{catalog.render(key, locale)}"
    return f"{text}\n\n{catalog.render('line.unsubscribe', locale, link=unsubscribe_link)}"
