"""The building template as a CSV file: written for a spreadsheet, read back from one.

docs/API.md section 1, "Filling the building of a new installation". Writing: UTF-8 with a byte
order mark, `;`, decimal commas, CRLF, every cell guarded against formulas, so the file opens
in a spreadsheet with Estonian settings as it is. Reading: the separator of the header line,
`;` or `,`, a byte order mark skipped, UTF-8 only.
"""

import csv
import io
from collections.abc import Iterable
from dataclasses import dataclass

from src.core.csv_safety import BOM, neutralize_formula
from src.core.filling.layout import COLUMNS, RowInput

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 10_000


class TemplateError(Exception):
    """The file as a whole cannot be read; the message is shown as `error: <message>`."""


@dataclass(frozen=True)
class TemplateRow:
    """One row to write, cells by column name (missing ones stay empty)."""

    cells: dict[str, str]


def write_template(rows: Iterable[TemplateRow]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    buffer.write(BOM)
    writer.writerow(COLUMNS)
    for row in rows:
        writer.writerow([neutralize_formula(row.cells.get(column, "")) for column in COLUMNS])
    return buffer.getvalue()


def read_template(data: bytes) -> list[RowInput]:
    """The rows of the file (empty lines skipped), each with its line number as `ref`.

    Raises TemplateError for a file that cannot be read as a template at all; a row with the
    wrong number of cells is a TemplateError too, because its cells cannot be named."""
    if len(data) > MAX_FILE_BYTES:
        raise TemplateError(f"the file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise TemplateError('the file is not UTF-8: save it as "CSV UTF-8"') from None
    first_line = text.splitlines()[0] if text else ""
    if "\t" in first_line and ";" not in first_line and "," not in first_line:
        raise TemplateError("row 1: the separator must be ; or , (this file uses tabs)")
    delimiter = ";" if ";" in first_line else ","
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        header = next(reader)
    except StopIteration:
        raise TemplateError("the file is empty") from None
    except csv.Error as error:
        raise TemplateError(f"row 1: {error}") from None
    names = [cell.strip().lstrip(BOM) for cell in header]
    # A spreadsheet keeps a cleared column after the last one as an empty column on every line:
    # its empty header cells, and the same empty cells of each row, are not part of the file.
    width = len(names)
    while names and not names[-1]:
        names.pop()
    missing = [column for column in COLUMNS if column not in names]
    unexpected = [name for name in names if name not in COLUMNS]
    repeated = sorted({name for name in names if names.count(name) > 1})
    if missing or unexpected or repeated:
        details = [
            *(["missing: " + ", ".join(missing)] if 0 < len(missing) < len(COLUMNS) else []),
            *([f"{len(unexpected)} unexpected column(s)"] if unexpected else []),
            *(["twice: " + ", ".join(repeated)] if repeated else []),
        ]
        raise TemplateError(
            "row 1: the header must be exactly: "
            + ", ".join(COLUMNS)
            + (f" ({'; '.join(details)})" if details else "")
        )
    rows: list[RowInput] = []
    # Rows are counted like the spreadsheet does: one per record, so a line break inside a
    # quoted cell (Alt+Enter) does not shift the numbers of the rows after it.
    row_number = 1
    try:
        for cells in reader:
            row_number += 1
            if len(names) < len(cells) <= width and not any(c.strip() for c in cells[len(names) :]):
                cells = cells[: len(names)]
            if not any(cell.strip() for cell in cells):
                continue
            if len(cells) != len(names):
                raise TemplateError(
                    f"row {row_number}: {len(cells)} cells instead of {len(names)}"
                    + (" (a decimal comma needs ';' as the separator)" if delimiter == "," else "")
                )
            rows.append(RowInput(ref=row_number, cells=dict(zip(names, cells, strict=True))))
            if len(rows) > MAX_ROWS:
                raise TemplateError(f"more than {MAX_ROWS} rows")
    except csv.Error as error:
        raise TemplateError(f"row {row_number + 1}: {error}") from None
    return rows
