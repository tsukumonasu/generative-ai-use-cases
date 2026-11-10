"""Excel workbooks from a declarative spec.

Each sheet is one table: an optional title, a colored header row, typed
columns (number formats), formulas, an optional totals row and native
charts. Page setup fits the table to the page width for printing. Formula
results are not stored (XlsxWriter does not calculate); Excel and Google
Sheets calculate them when the file is opened.
"""

import datetime
import re
from typing import Literal

import xlsxwriter
from pydantic import BaseModel, Field
from xlsxwriter.utility import xl_rowcol_to_cell

from .common import FONT, DocumentError, Palette, text_width_em

# The cell values come from the model, which may be summarising other people's
# mail and documents. A formula can send the sheet's contents out when the file
# is opened (IMAGE / IMPORTDATA / WEBSERVICE / HYPERLINK, DDE "=cmd|..."), so
# only calculations are written as formulas; anything else stays text.
SAFE_FUNCTIONS = frozenset(
    """ABS AND AVERAGE AVERAGEIF AVERAGEIFS CEILING CHOOSE COLUMN CONCAT CONCATENATE COUNT COUNTA COUNTBLANK COUNTIF
    COUNTIFS DATE DATEDIF DAY DAYS EDATE EOMONTH FLOOR HLOOKUP HOUR IF IFERROR IFNA IFS INDEX INT ISBLANK ISERROR
    ISNUMBER ISTEXT LARGE LEFT LEN LOWER MATCH MAX MAXIFS MEDIAN MID MIN MINIFS MINUTE MOD MONTH NETWORKDAYS NOT NOW OR
    PERCENTILE POWER PRODUCT RANK RIGHT ROUND ROUNDDOWN ROUNDUP ROW SMALL SQRT STDEV SUBSTITUTE SUBTOTAL SUM SUMIF
    SUMIFS SUMPRODUCT SWITCH TEXT TEXTJOIN TODAY TRIM UPPER VALUE VAR VLOOKUP WEEKDAY WEEKNUM WORKDAY XLOOKUP
    YEAR""".split()
)
_FUNCTION_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_.]*)\s*\(")


def is_safe_formula(formula: str) -> bool:
    """Whether a cell formula only calculates: no DDE, no reference to another
    workbook, no URL, and no function outside SAFE_FUNCTIONS."""
    if any(mark in formula for mark in ("|", "[", "]", "://", "\\\\")):
        return False
    return all(name.upper() in SAFE_FUNCTIONS for name in _FUNCTION_RE.findall(formula))


# --- Spec --------------------------------------------------------------------

ColumnFormat = Literal["text", "integer", "decimal", "currency", "percent", "date", "datetime", "time"]

NUMBER_FORMATS: dict[str, str | None] = {
    "text": None,
    "integer": "#,##0",
    "decimal": "#,##0.00",
    "currency": "¥#,##0;[Red]-¥#,##0",
    "percent": "0.0%",
    "date": "yyyy/mm/dd",
    "datetime": "yyyy/mm/dd hh:mm",
    "time": "hh:mm",
}
SUMMABLE = {"integer", "decimal", "currency"}


class SheetColumn(BaseModel):
    header: str
    format: ColumnFormat = Field("text", description="How values are shown. percent expects ratios (0.25 = 25%). date/datetime/time accept ISO strings such as '2026-11-08' or '2026-11-08T09:30'.")
    number_format: str | None = Field(None, description="Custom Excel number format, overrides format (e.g. '0.0\"倍\"')")
    width: float | None = Field(None, description="Column width in characters (default: fit the content)")


class SheetChart(BaseModel):
    type: Literal["column", "stacked_column", "bar", "stacked_bar", "line", "area", "pie", "doughnut"] = "column"
    title: str | None = None
    category_column: str | int = Field(0, description="Header (or 0-based index) of the column holding the categories")
    value_columns: list[str | int] = Field(description="Headers (or 0-based indexes) of the columns to plot; pie/doughnut use the first")
    position: Literal["right", "below"] = Field("right", description="Where the chart goes relative to the table")


class Sheet(BaseModel):
    name: str = Field(description="Sheet name (31 characters at most)")
    title: str | None = Field(None, description="Title shown above the table")
    description: str | None = Field(None, description="One line under the title (source, as-of date, unit)")
    columns: list[SheetColumn]
    rows: list[list[bool | int | float | str | None]] = Field(description="Data rows, each as long as columns. A string starting with '=' is a formula; only calculation functions (SUM, IF, VLOOKUP, ROUND, TEXT, DATE, ...) are allowed, and a formula with a link, an external reference or any other function is written as text. In formulas, {row} is this row's number and {first}/{last} the first/last data row, e.g. '=C{row}*D{row}', '=D{row}/SUM(D${first}:D${last})'.")
    totals: bool = Field(False, description="Add a totals row summing the integer/decimal/currency columns")
    totals_label: str = Field("合計", description="Label of the totals row")
    freeze_header: bool = True
    autofilter: bool = True
    charts: list[SheetChart] | None = None
    notes: list[str] | None = Field(None, description="Lines written under the table (assumptions, sources)")


# --- Builder -----------------------------------------------------------------

_CHART_TYPES = {
    "column": ("column", None),
    "stacked_column": ("column", "stacked"),
    "bar": ("bar", None),
    "stacked_bar": ("bar", "stacked"),
    "line": ("line", None),
    "area": ("area", None),
    "pie": ("pie", None),
    "doughnut": ("doughnut", None),
}


def _sheet_name(name: str, used: set[str]) -> str:
    clean = "".join("_" if ch in "[]:*?/\\" else ch for ch in name).strip("'").strip() or "Sheet"
    clean = clean[:31]
    candidate, n = clean, 2
    while candidate.lower() in used:
        suffix = f" ({n})"
        candidate = clean[: 31 - len(suffix)] + suffix
        n += 1
    used.add(candidate.lower())
    return candidate


def _parse_datetime(value: str, kind: str) -> datetime.datetime | None:
    text = value.strip().replace("/", "-")
    try:
        if kind == "time":
            parsed = datetime.time.fromisoformat(text)
            return datetime.datetime.combine(datetime.date(1899, 12, 31), parsed)
        if kind == "date" and len(text) <= 10:
            return datetime.datetime.combine(datetime.date.fromisoformat(text), datetime.time())
        parsed = datetime.datetime.fromisoformat(text)
        return parsed.replace(tzinfo=None)
    except ValueError:
        return None


class _Formats:
    """Cached XlsxWriter formats keyed by their properties"""

    def __init__(self, workbook):
        self.workbook = workbook
        self.cache: dict[tuple, object] = {}

    def get(self, **props):
        key = tuple(sorted(props.items()))
        if key not in self.cache:
            self.cache[key] = self.workbook.add_format({"font_name": FONT, "font_size": 10.5, "valign": "vcenter", **props})
        return self.cache[key]


def _column_index(ref: str | int, headers: list[str], sheet: str) -> int:
    if isinstance(ref, int):
        if not 0 <= ref < len(headers):
            raise DocumentError(f"Sheet '{sheet}': chart column index {ref} is out of range.")
        return ref
    if ref in headers:
        return headers.index(ref)
    raise DocumentError(f"Sheet '{sheet}': no column named {ref!r} for the chart (columns: {headers}).")


def build_workbook(path: str, sheets: list[Sheet], palette: Palette) -> list[str]:
    """Write the workbook to path; returns warnings for the model"""
    if not sheets:
        raise DocumentError("A workbook needs at least one sheet.")
    workbook = xlsxwriter.Workbook(path, {"strings_to_formulas": False, "strings_to_numbers": False, "strings_to_urls": False})
    formats = _Formats(workbook)
    used_names: set[str] = set()
    warnings: list[str] = []

    for sheet in sheets:
        if not sheet.columns:
            raise DocumentError(f"Sheet '{sheet.name}' needs columns.")
        name = _sheet_name(sheet.name, used_names)
        if name != sheet.name:
            warnings.append(f"Sheet '{sheet.name}' was renamed to '{name}' (Excel's sheet name rules).")
        ws = workbook.add_worksheet(name)
        ws.hide_gridlines(2)
        cols = len(sheet.columns)
        headers = [c.header for c in sheet.columns]
        for r, row in enumerate(sheet.rows):
            if len(row) != cols:
                raise DocumentError(f"Sheet '{sheet.name}': row {r + 1} has {len(row)} cells but there are {cols} columns.")

        row_index = 0
        if sheet.title:
            ws.write_string(0, 0, sheet.title, formats.get(bold=True, font_size=16, font_color="#" + palette.primary))
            ws.set_row(0, 26)
            row_index = 1
            if sheet.description:
                ws.write_string(1, 0, sheet.description, formats.get(font_color="#" + palette.muted, font_size=9.5))
                row_index = 2
            row_index += 1
        header_row = row_index
        first_data = header_row + 1
        last_data = header_row + len(sheet.rows)

        header_format = formats.get(bold=True, font_color="#FFFFFF", bg_color="#" + palette.primary, border=1, border_color="#" + palette.primary, text_wrap=True, align="center")
        for c, header in enumerate(headers):
            ws.write_string(header_row, c, header, header_format)
        ws.set_row(header_row, 22)

        widths = [text_width_em(h) * 2 + 2 for h in headers]
        for r, row in enumerate(sheet.rows):
            excel_row = first_data + r
            zebra = r % 2 == 1
            for c, value in enumerate(row):
                column = sheet.columns[c]
                num_format = column.number_format or NUMBER_FORMATS[column.format]
                props = {"border": 1, "border_color": "#" + palette.line}
                if zebra:
                    props["bg_color"] = "#" + palette.tint
                if num_format:
                    props["num_format"] = num_format
                if column.format == "text":
                    props["text_wrap"] = True
                cell_format = formats.get(**props)
                if value is None or value == "":
                    ws.write_blank(excel_row, c, None, cell_format)
                elif isinstance(value, str) and value.startswith("=") and is_safe_formula(value):
                    formula = value.replace("{row}", str(excel_row + 1)).replace("{first}", str(first_data + 1)).replace("{last}", str(last_data + 1))
                    ws.write_formula(excel_row, c, formula, cell_format)
                    widths[c] = max(widths[c], 12)
                elif isinstance(value, bool):
                    ws.write_boolean(excel_row, c, value, cell_format)
                elif isinstance(value, (int, float)):
                    ws.write_number(excel_row, c, value, cell_format)
                    widths[c] = max(widths[c], len(f"{value:,.2f}") + 2)
                elif column.format in ("date", "datetime", "time") and (parsed := _parse_datetime(value, column.format)):
                    ws.write_datetime(excel_row, c, parsed, cell_format)
                    widths[c] = max(widths[c], 18 if column.format == "datetime" else 12)
                else:
                    ws.write_string(excel_row, c, value, cell_format)
                    widths[c] = max(widths[c], text_width_em(value) * 2 + 2)

        totals_row = None
        if sheet.totals and sheet.rows:
            totals_row = last_data + 1
            total_props = {"bold": True, "top": 2, "top_color": "#" + palette.primary, "bottom": 1, "bottom_color": "#" + palette.line, "bg_color": "#" + palette.tint_strong}
            for c, column in enumerate(sheet.columns):
                num_format = column.number_format or NUMBER_FORMATS[column.format]
                cell_format = formats.get(**total_props, **({"num_format": num_format} if num_format else {}))
                if c == 0:
                    ws.write_string(totals_row, c, sheet.totals_label, cell_format)
                elif column.format in SUMMABLE:
                    ws.write_formula(totals_row, c, f"=SUBTOTAL(109,{xl_rowcol_to_cell(first_data, c)}:{xl_rowcol_to_cell(last_data, c)})", cell_format)
                else:
                    ws.write_blank(totals_row, c, None, cell_format)

        for c, column in enumerate(sheet.columns):
            ws.set_column(c, c, column.width or min(max(widths[c], 8), 60))
        if sheet.freeze_header:
            ws.freeze_panes(first_data, 0)
        if sheet.autofilter and sheet.rows:
            ws.autofilter(header_row, 0, last_data, cols - 1)

        end_row = totals_row if totals_row is not None else last_data
        if sheet.notes:
            note_format = formats.get(font_color="#" + palette.muted, font_size=9.5)
            for i, note in enumerate(sheet.notes):
                ws.write_string(end_row + 2 + i, 0, note, note_format)

        # Page setup: A4, fit to one page wide, header row repeated
        ws.set_paper(9)
        total_width = sum(column.width or min(max(widths[c], 8), 60) for c, column in enumerate(sheet.columns))
        if total_width > 90 or sheet.charts:
            ws.set_landscape()
        ws.fit_to_pages(1, 0)
        ws.repeat_rows(header_row)
        ws.set_margins(left=0.5, right=0.5, top=0.6, bottom=0.6)
        ws.center_horizontally()
        ws.set_footer("&C&P / &N")

        for i, spec in enumerate(sheet.charts or []):
            if not sheet.rows:
                raise DocumentError(f"Sheet '{sheet.name}': a chart needs data rows.")
            chart_type, subtype = _CHART_TYPES[spec.type]
            chart = workbook.add_chart({"type": chart_type, **({"subtype": subtype} if subtype else {})})
            category = _column_index(spec.category_column, headers, sheet.name)
            values = [_column_index(ref, headers, sheet.name) for ref in spec.value_columns]
            if not values:
                raise DocumentError(f"Sheet '{sheet.name}': a chart needs value_columns.")
            round_chart = spec.type in ("pie", "doughnut")
            if round_chart:
                values = values[:1]
            colors = palette.series(len(sheet.rows) if round_chart else len(values))
            font = {"name": FONT, "size": 10, "color": "#" + palette.text}
            for k, column in enumerate(values):
                series = {
                    "name": [name, header_row, column],
                    "categories": [name, first_data, category, last_data, category],
                    "values": [name, first_data, column, last_data, column],
                }
                if round_chart:
                    series["points"] = [{"fill": {"color": "#" + color}, "border": {"color": "#FFFFFF"}} for color in colors]
                    series["data_labels"] = {"percentage": True, "font": font}
                elif spec.type == "line":
                    series["line"] = {"color": "#" + colors[k], "width": 2.25}
                    series["marker"] = {"type": "circle", "size": 6, "fill": {"color": "#" + colors[k]}, "border": {"color": "#" + colors[k]}}
                else:
                    series["fill"] = {"color": "#" + colors[k]}
                    series["border"] = {"none": True}
                chart.add_series(series)
            if spec.title:
                chart.set_title({"name": spec.title, "name_font": {"name": FONT, "size": 13, "bold": True, "color": "#" + palette.text}})
            else:
                chart.set_title({"none": True})
            chart.set_legend({"position": "bottom", "font": font} if (len(values) > 1 or round_chart) else {"none": True})
            if not round_chart:
                # Bar charts list categories bottom-up; reverse them (and keep
                # the value axis at the bottom) so they read top-down
                value_format = sheet.columns[values[0]].number_format or NUMBER_FORMATS[sheet.columns[values[0]].format]
                chart.set_y_axis({"num_font": font, "major_gridlines": {"visible": True, "line": {"color": "#" + palette.line}}, "line": {"none": True}, **({"num_format": value_format} if value_format else {})})
                chart.set_x_axis({"num_font": font, "line": {"color": "#" + palette.line}, **({"reverse": True, "crossing": "max"} if chart_type == "bar" else {})})
            chart.set_chartarea({"border": {"none": True}})
            chart.set_size({"width": 640, "height": 360})
            if spec.position == "right":
                ws.insert_chart(header_row + i * 19, cols + 1, chart, {"x_offset": 8, "y_offset": 4})
            else:
                ws.insert_chart(end_row + 2 + len(sheet.notes or []) + 1 + i * 19, 0, chart, {"x_offset": 4, "y_offset": 4})

    workbook.close()
    return warnings
