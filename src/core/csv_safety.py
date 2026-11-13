"""The guard against spreadsheet formulas in CSV exports (CSV injection), shared by every export:
the readings plugin (src/plugins/common/csv_export.py) and the maintenance report."""

import csv
import io
import unicodedata
from collections.abc import Iterable, Iterator, Sequence

# A cell starting with one of these is executed as a formula by Excel/LibreOffice (CSV injection).
_FORMULA_TRIGGERS = ("=", "+", "-", "@")
_LEADING_CONTROL = ("\t", "\r", "\n")
# The BOM makes Excel open UTF-8 (Cyrillic, Estonian letters) correctly.
BOM = "﻿"


def neutralize_formula(text: str) -> str:
    """Prefix a quote when a spreadsheet could read the cell as a formula.

    NFKC folds look-alikes such as the full-width "＝" into "=", and leading whitespace or line
    breaks are skipped, because spreadsheets skip them too before evaluating.
    """
    probe = unicodedata.normalize("NFKC", text).lstrip(" \t\r\n")
    if text.startswith(_LEADING_CONTROL) or probe.startswith(_FORMULA_TRIGGERS):
        return f"'{text}"
    return text


def csv_lines(header: Sequence[str], rows: Iterable[Sequence[object]]) -> Iterator[str]:
    """CSV text in chunks (BOM, CRLF, comma), a row at a time, for a streaming response."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")

    def flush() -> str:
        chunk = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate()
        return chunk

    buffer.write(BOM)
    writer.writerow(header)
    yield flush()
    for row in rows:
        writer.writerow(row)
        yield flush()
