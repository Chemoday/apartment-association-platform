"""Reading the list of a bulk invitation (epic E13 R4a; docs/API.md 7, "Bulk invitations of
owners"). Pure functions: the list lives only in memory and is never stored or logged.

One row per line, `apartment number; e-mail; language; kind`, separated by `;` when the line has
one, else by a tab, else by `,`; the language and the kind may be left out (a missing kind is an
apartment, epic E14). Empty lines, `#` comments, a byte order mark and a first line that
names the columns are skipped.
"""

from dataclasses import dataclass

from src.modules.auth.schemas import BulkRowOutcome, _email_address
from src.modules.property.schemas import ObjectKind, parse_object_ref

MAX_BULK_BYTES = 1024 * 1024
SEPARATORS = (";", "\t", ",")
BOM = "\ufeff"


class BulkListTooLong(ValueError):
    """More than 1 MB, or more rows than the building allows (422 BULK_LIST_TOO_LONG)."""


@dataclass(frozen=True)
class ParsedRow:
    """One row as read; `outcome` is set only when the row itself is wrong (the checks that
    need the database come later)."""

    line: int
    apartment_number: str | None
    email: str | None
    locale: str | None
    outcome: BulkRowOutcome | None
    # The kind the number names (an apartment without the fourth cell); None when it is unknown.
    apartment_kind: ObjectKind | None


def _cells(line: str) -> list[str]:
    separator = next((sep for sep in SEPARATORS if sep in line), None)
    cells = [cell.strip() for cell in line.split(separator)] if separator else [line.strip()]
    while len(cells) > 2 and not cells[-1]:
        cells.pop()  # a spreadsheet export adds empty cells at the end
    return cells


def _is_header(cells: list[str]) -> bool:
    return len(cells) >= 2 and "@" not in cells[1] and "mail" in cells[1].lower()


def _kind(cells: list[str]) -> ObjectKind | None:
    """The kind of the row (its fourth cell; an apartment without one), None when not known."""
    if len(cells) > 4:
        return None
    try:
        return parse_object_ref(cells[3] if len(cells) == 4 else None, "").kind
    except ValueError:
        return None


def _row(line: int, cells: list[str], offered: frozenset[str]) -> ParsedRow:
    # Every outcome reports the kind the row names, so the chairman sees "garage 12" also on a
    # row with a wrong e-mail.
    kind = _kind(cells)
    if len(cells) not in (2, 3, 4) or not cells[0] or not cells[1]:
        return ParsedRow(
            line,
            cells[0] or None,
            cells[1] or None if len(cells) > 1 else None,
            None,
            BulkRowOutcome.INVALID_ROW,
            kind,
        )
    number, raw_email = cells[0], cells[1]
    locale = cells[2].lower() if len(cells) >= 3 and cells[2] else None
    try:
        email = _email_address(raw_email)
    except ValueError:
        return ParsedRow(line, number, raw_email, locale, BulkRowOutcome.INVALID_EMAIL, kind)
    if locale is not None and locale not in offered:
        return ParsedRow(line, number, email, locale, BulkRowOutcome.INVALID_LOCALE, kind)
    if kind is None:
        return ParsedRow(line, number, email, locale, BulkRowOutcome.INVALID_KIND, None)
    return ParsedRow(line, number, email, locale, None, kind)


def parse_bulk_list(
    text: str, *, max_rows: int, offered_locales: frozenset[str]
) -> list[ParsedRow]:
    """Every row of the list, in its order; BulkListTooLong when it is too big."""
    if len(text.encode("utf-8")) > MAX_BULK_BYTES:
        raise BulkListTooLong()
    rows: list[ParsedRow] = []
    first = True
    for number, raw in enumerate(text.removeprefix(BOM).splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        cells = _cells(stripped)
        if first:
            first = False
            if _is_header(cells):
                continue
        rows.append(_row(number, cells, offered_locales))
        if len(rows) > max_rows:
            raise BulkListTooLong()
    return rows
