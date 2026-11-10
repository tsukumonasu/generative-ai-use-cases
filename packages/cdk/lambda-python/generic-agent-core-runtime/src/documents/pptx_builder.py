"""PowerPoint decks from a declarative spec.

The model describes slides as data (layout + content) and this module does
all of the drawing, so a deck never needs model-written code and always
follows one design: 16:9, one font, a two-color palette, a title bar on
content slides and native (editable) tables and charts.
"""

import math
import re
from typing import Literal

from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION, XL_MARKER_STYLE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt
from pydantic import BaseModel, Field

from .common import FONT, DocumentError, Palette, mix, resolve_source, split_bold, strip_markup, text_width_em

# --- Spec --------------------------------------------------------------------


class Bullet(BaseModel):
    text: str = Field(description="Bullet text. **bold** is supported.")
    level: int = Field(1, ge=1, le=3, description="Indent level, 1-3")


class Column(BaseModel):
    heading: str | None = Field(None, description="Heading of the column")
    text: str | None = Field(None, description="Paragraph text")
    bullets: list[str | Bullet] | None = Field(None, description="Bullet points")


class SlideTable(BaseModel):
    columns: list[str] = Field(description="Header cells")
    rows: list[list[str | int | float | None]] = Field(description="Body rows, each as long as columns")
    column_widths: list[float] | None = Field(None, description="Relative column widths, e.g. [2, 1, 1]. Omit to size by content.")


class ChartSeries(BaseModel):
    name: str
    values: list[float | None] = Field(description="One value per category")


class SlideChart(BaseModel):
    type: Literal["column", "stacked_column", "bar", "stacked_bar", "line", "area", "pie", "doughnut"] = "column"
    categories: list[str]
    series: list[ChartSeries] = Field(description="Pie and doughnut charts use the first series only")
    number_format: str | None = Field(None, description="Excel number format of values and labels, e.g. '#,##0', '0.0%', '¥#,##0'")
    data_labels: bool | None = Field(None, description="Show values on the chart (default: on for pie/doughnut and small single-series charts)")
    title: str | None = Field(None, description="Chart title (usually unnecessary: the slide title explains the chart)")


class Stat(BaseModel):
    value: str = Field(description="The number, short: '120億円', '+18%', '3.2x'")
    label: str = Field(description="What the number is")
    note: str | None = Field(None, description="Small supporting note")


class Step(BaseModel):
    title: str = Field(description="Short step name")
    text: str | None = Field(None, description="Description under the step")


class Slide(BaseModel):
    layout: Literal["title", "section", "agenda", "bullets", "two_column", "table", "chart", "stats", "steps", "quote", "image", "closing"]
    title: str | None = Field(None, description="Slide title")
    subtitle: str | None = Field(None, description="title/section/closing: subtitle")
    lead: str | None = Field(None, description="Content slides: the key message of the slide, one sentence shown under the title")
    text: str | None = Field(None, description="Paragraph text. title/closing: small meta line (date, presenter). Other layouts: body text or note.")
    bullets: list[str | Bullet] | None = Field(None, description="bullets: the bullet points. chart/image/stats: optional points shown beside or below.")
    items: list[str] | None = Field(None, description="agenda: the agenda items")
    left: Column | None = Field(None, description="two_column: left column")
    right: Column | None = Field(None, description="two_column: right column")
    table: SlideTable | None = Field(None, description="table: the table")
    chart: SlideChart | None = Field(None, description="chart: the chart")
    stats: list[Stat] | None = Field(None, description="stats: 1-6 key numbers")
    steps: list[Step] | None = Field(None, description="steps: 2-6 process or timeline steps, left to right")
    quote: str | None = Field(None, description="quote: the quotation")
    attribution: str | None = Field(None, description="quote: who said it")
    image: str | None = Field(None, description="image: a PNG/JPEG under /tmp/ws or the S3 URL of an image this assistant created")
    caption: str | None = Field(None, description="image: caption under the image")
    notes: str | None = Field(None, description="Speaker notes")


# --- Geometry (inches) -------------------------------------------------------

SLIDE_W = 13.333
SLIDE_H = 7.5
MARGIN_X = 0.6
CONTENT_W = SLIDE_W - 2 * MARGIN_X
BODY_BOTTOM = 6.85


def _rgb(color: str) -> RGBColor:
    return RGBColor.from_string(color)


# --- Text --------------------------------------------------------------------


_AFTER_TYPEFACES = {qn(tag) for tag in ("a:sym", "a:hlinkClick", "a:hlinkMouseOver", "a:rtl", "a:extLst")}


def _apply_font(rPr, size: float | None = None, color: str | None = None, bold: bool | None = None) -> None:
    """Size/color/bold plus the Latin and East Asian typefaces on an a:rPr or a:defRPr"""
    if size is not None:
        rPr.set("sz", str(int(round(size * 100))))
    if bold is not None:
        rPr.set("b", "1" if bold else "0")
    if color is not None:
        for old in rPr.findall(qn("a:solidFill")):
            rPr.remove(old)
        fill = etree.Element(qn("a:solidFill"))
        etree.SubElement(fill, qn("a:srgbClr")).set("val", color)
        # Schema order: a:ln, then the fill, ..., then the typefaces
        rPr.insert(1 if len(rPr) and rPr[0].tag == qn("a:ln") else 0, fill)
    for tag in ("a:latin", "a:ea", "a:cs"):
        for old in rPr.findall(qn(tag)):
            rPr.remove(old)
    anchor = next((child for child in rPr if child.tag in _AFTER_TYPEFACES), None)
    for tag in ("a:latin", "a:ea", "a:cs"):
        element = etree.Element(qn(tag))
        element.set("typeface", FONT)
        if anchor is None:
            rPr.append(element)
        else:
            anchor.addprevious(element)


def _add_text(paragraph, text: str, size: float, color: str, bold: bool = False) -> None:
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if i:
            paragraph.add_line_break()
        for segment, is_bold in split_bold(line):
            run = paragraph.add_run()
            run.text = segment
            _apply_font(run._r.get_or_add_rPr(), size, color, bold or is_bold)


def _set_bullet(paragraph, level: int, color: str) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    margin = {1: 0.3, 2: 0.65, 3: 1.0}[level]
    pPr.set("marL", str(Inches(margin)))
    pPr.set("indent", str(-Inches(0.26)))
    clr = etree.SubElement(pPr, qn("a:buClr"))
    etree.SubElement(clr, qn("a:srgbClr")).set("val", color)
    etree.SubElement(pPr, qn("a:buFont")).set("typeface", "Arial")
    etree.SubElement(pPr, qn("a:buChar")).set("char", {1: "•", 2: "–", 3: "·"}[level])


def _textbox(slide, x: float, y: float, w: float, h: float, anchor=MSO_ANCHOR.TOP, margin_x: float = 0.05, margin_y: float = 0.03):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.margin_left = frame.margin_right = Inches(margin_x)
    frame.margin_top = frame.margin_bottom = Inches(margin_y)
    frame.vertical_anchor = anchor
    return frame


def _lines(text: str, size: float, width: float) -> int:
    """Lines text wraps to at size (pt) in width (inches)"""
    per_line = max(width * 72 / size, 1)
    return sum(max(1, math.ceil(text_width_em(strip_markup(line)) / per_line)) for line in text.split("\n"))


def _line_height(size: float) -> float:
    return size * 1.2 * 1.1 / 72


class _Para:
    """A paragraph to lay out: bullet level 0 means plain text"""

    def __init__(self, text: str, level: int = 0, scale: float = 1.0, bold: bool = False, color: str | None = None):
        self.text = text
        self.level = level
        self.scale = scale
        self.bold = bold
        self.color = color


def _paras_height(paras: list[_Para], size: float, width: float) -> float:
    height = 0.0
    for i, para in enumerate(paras):
        indent = {0: 0, 1: 0.3, 2: 0.65, 3: 1.0}[para.level]
        para_size = size * para.scale
        height += _lines(para.text, para_size, width - indent - 0.1) * _line_height(para_size)
        if i < len(paras) - 1:
            height += para_size * 0.5 / 72
    return height + 0.06


def _fit(paras: list[_Para], width: float, height: float, max_size: float, min_size: float) -> tuple[float, bool]:
    """Largest font size (pt) at which paras fit, and whether even min_size overflows"""
    size = max_size
    while size > min_size and _paras_height(paras, size, width) > height:
        size -= 1
    return size, _paras_height(paras, size, width) > height


def _write(frame, paras: list[_Para], size: float, palette: Palette, align=PP_ALIGN.LEFT) -> None:
    for i, para in enumerate(paras):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        paragraph.alignment = align
        paragraph.line_spacing = 1.1
        para_size = size * para.scale
        if i < len(paras) - 1:
            paragraph.space_after = Pt(para_size * 0.5)
        if para.level:
            _set_bullet(paragraph, para.level, palette.accent if para.level == 1 else palette.muted)
        _add_text(paragraph, para.text, para_size, para.color or palette.text, para.bold)


def _bullet_paras(text: str | None, bullets: list | None) -> list[_Para]:
    paras = []
    if text:
        paras.extend(_Para(block.strip()) for block in text.split("\n\n") if block.strip())
    for item in bullets or []:
        if isinstance(item, Bullet):
            paras.append(_Para(item.text, item.level, {1: 1.0, 2: 0.88, 3: 0.8}[item.level]))
        else:
            paras.append(_Para(str(item), 1))
    return paras


# --- Shapes ------------------------------------------------------------------


def _shape(slide, kind, x: float, y: float, w: float, h: float, fill: str | None, line: str | None = None):
    shape = slide.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    if fill:
        shape.fill.solid()
        shape.fill.fore_color.rgb = _rgb(fill)
    else:
        shape.fill.background()
    if line:
        shape.line.color.rgb = _rgb(line)
        shape.line.width = Pt(0.75)
    else:
        shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def _shape_text(shape, paras: list[_Para], size: float, palette: Palette, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin_x: float = 0.1) -> None:
    frame = shape.text_frame
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.margin_left = frame.margin_right = Inches(margin_x)
    frame.margin_top = frame.margin_bottom = Inches(0.04)
    frame.vertical_anchor = anchor
    _write(frame, paras, size, palette, align)


# --- Deck --------------------------------------------------------------------


class _Builder:
    def __init__(self, palette: Palette, footer: str | None):
        self.palette = palette
        self.footer = footer
        self.prs = Presentation()
        self.prs.slide_width = Inches(SLIDE_W)
        self.prs.slide_height = Inches(SLIDE_H)
        self.warnings: list[str] = []
        self.section_count = 0
        self._set_theme_fonts()

    def _set_theme_fonts(self) -> None:
        """Theme fonts too, so charts, tables and text typed later in
        PowerPoint use the same font"""
        theme_part = self.prs.slide_master.part.part_related_by(RT.THEME)
        root = etree.fromstring(theme_part.blob)
        ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
        for font in root.findall(".//a:fontScheme/a:majorFont", ns) + root.findall(".//a:fontScheme/a:minorFont", ns):
            for child in list(font):
                if child.tag == qn("a:font"):
                    font.remove(child)
                else:
                    child.set("typeface", FONT)
        theme_part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    def warn(self, index: int, message: str) -> None:
        self.warnings.append(f"Slide {index}: {message}")

    def new_slide(self, background: str | None = None):
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        if background:
            slide.background.fill.solid()
            slide.background.fill.fore_color.rgb = _rgb(background)
        return slide

    # Content slide chrome -----------------------------------------------

    def header(self, slide, index: int, spec: Slide) -> float:
        """Title bar of a content slide; returns the top of the body area"""
        p = self.palette
        title = spec.title or ""
        if title:
            size, overflow = _fit([_Para(title, bold=True)], CONTENT_W, 0.78, 28, 20)
            if overflow:
                self.warn(index, "the title is too long for one or two lines; shorten it.")
            frame = _textbox(slide, MARGIN_X, 0.36, CONTENT_W, 0.8, anchor=MSO_ANCHOR.BOTTOM)
            _write(frame, [_Para(title, bold=True, color=p.primary)], size, p)
        _shape(slide, MSO_SHAPE.RECTANGLE, MARGIN_X, 1.2, CONTENT_W, 0.02, p.line)
        _shape(slide, MSO_SHAPE.RECTANGLE, MARGIN_X, 1.18, 1.1, 0.06, p.accent)
        top = 1.45
        if spec.lead:
            size, overflow = _fit([_Para(spec.lead, bold=True)], CONTENT_W, 0.62, 19, 14)
            if overflow:
                self.warn(index, "the lead message is too long; keep it to one sentence.")
            frame = _textbox(slide, MARGIN_X, 1.33, CONTENT_W, 0.64, anchor=MSO_ANCHOR.MIDDLE)
            _write(frame, [_Para(spec.lead, bold=True)], size, p)
            top = 2.08
        self.footer_bar(slide, index)
        return top

    def footer_bar(self, slide, index: int) -> None:
        p = self.palette
        frame = _textbox(slide, SLIDE_W - MARGIN_X - 1.0, 7.0, 1.0, 0.3, anchor=MSO_ANCHOR.MIDDLE)
        _write(frame, [_Para(str(index), color=p.muted)], 10, p, PP_ALIGN.RIGHT)
        if self.footer:
            frame = _textbox(slide, MARGIN_X, 7.0, 8.0, 0.3, anchor=MSO_ANCHOR.MIDDLE)
            _write(frame, [_Para(self.footer, color=p.muted)], 10, p)

    def text_block(self, slide, index: int, paras: list[_Para], x: float, y: float, w: float, h: float, max_size: float = 24, min_size: float = 14) -> None:
        if not paras:
            return
        size, overflow = _fit(paras, w - 0.1, h - 0.06, max_size, min_size)
        if overflow:
            self.warn(index, "the text does not fit; cut it down or split the slide.")
        if len(paras) > 8:
            self.warn(index, f"{len(paras)} paragraphs/bullets is a lot for one slide; consider 6 or fewer.")
        _write(_textbox(slide, x, y, w, h), paras, size, self.palette)

    # Layouts --------------------------------------------------------------

    def title_slide(self, index: int, spec: Slide, closing: bool = False) -> None:
        p = self.palette
        slide = self.new_slide(p.primary)
        title = spec.title or ""
        size, overflow = _fit([_Para(title, bold=True)], 11.6, 1.9, 40, 26)
        if overflow:
            self.warn(index, "the title is too long; shorten it.")
        top = 2.0 if not closing else 2.3
        frame = _textbox(slide, 0.9, top, 11.6, 2.0, anchor=MSO_ANCHOR.BOTTOM)
        _write(frame, [_Para(title, bold=True, color="FFFFFF")], size, p)
        _shape(slide, MSO_SHAPE.RECTANGLE, 0.95, top + 2.15, 1.5, 0.07, p.accent)
        if spec.subtitle:
            frame = _textbox(slide, 0.9, top + 2.35, 11.6, 1.1)
            sub_size, _ = _fit([_Para(spec.subtitle)], 11.5, 1.05, 22, 14)
            _write(frame, [_Para(spec.subtitle, color=p.tint_strong)], sub_size, p)
        if spec.text:
            frame = _textbox(slide, 0.9, 6.35, 11.6, 0.6, anchor=MSO_ANCHOR.BOTTOM)
            _write(frame, [_Para(spec.text, color=p.tint_strong)], 14, p)

    def section_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        self.section_count += 1
        slide = self.new_slide()
        block = _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, 4.3, SLIDE_H, p.primary)
        _shape_text(block, [_Para(f"{self.section_count:02d}", bold=True, color="FFFFFF")], 72, p)
        _shape(slide, MSO_SHAPE.RECTANGLE, 4.3, 0, 0.09, SLIDE_H, p.accent)
        title = spec.title or ""
        size, overflow = _fit([_Para(title, bold=True)], 7.6, 1.8, 36, 24)
        if overflow:
            self.warn(index, "the section title is too long.")
        frame = _textbox(slide, 5.0, 1.8, 7.7, 1.9, anchor=MSO_ANCHOR.BOTTOM)
        _write(frame, [_Para(title, bold=True, color=p.primary)], size, p)
        if spec.subtitle:
            frame = _textbox(slide, 5.0, 3.85, 7.7, 1.6)
            _write(frame, [_Para(spec.subtitle, color=p.muted)], 18, p)

    def agenda_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        items = spec.items or []
        if not items:
            raise DocumentError(f"Slide {index} (agenda) needs items.")
        if len(items) > 8:
            self.warn(index, "more than 8 agenda items; group them.")
        row_h = min(0.8, (BODY_BOTTOM - top) / len(items))
        circle = min(0.5, row_h - 0.16)
        size, overflow = _fit([_Para(item) for item in items[:1]], CONTENT_W - 1.2, row_h - 0.1, 22, 13)
        for item in items:
            s, o = _fit([_Para(item)], CONTENT_W - 1.2, row_h - 0.1, 22, 13)
            size, overflow = min(size, s), overflow or o
        if overflow:
            self.warn(index, "some agenda items are too long.")
        for i, item in enumerate(items):
            y = top + i * row_h
            dot = _shape(slide, MSO_SHAPE.OVAL, MARGIN_X + 0.1, y + (row_h - circle) / 2, circle, circle, p.primary)
            _shape_text(dot, [_Para(str(i + 1), bold=True, color="FFFFFF")], max(circle * 32, 11), p, margin_x=0)
            frame = _textbox(slide, MARGIN_X + 0.85, y, CONTENT_W - 0.95, row_h, anchor=MSO_ANCHOR.MIDDLE)
            _write(frame, [_Para(item)], size, p)
            if i < len(items) - 1:
                _shape(slide, MSO_SHAPE.RECTANGLE, MARGIN_X + 0.85, y + row_h - 0.01, CONTENT_W - 0.95, 0.01, p.line)

    def bullets_slide(self, index: int, spec: Slide) -> None:
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        paras = _bullet_paras(spec.text, spec.bullets)
        if not paras:
            raise DocumentError(f"Slide {index} (bullets) needs bullets or text.")
        self.text_block(slide, index, paras, MARGIN_X, top + 0.1, CONTENT_W, BODY_BOTTOM - top - 0.1)

    def two_column_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        if not spec.left or not spec.right:
            raise DocumentError(f"Slide {index} (two_column) needs left and right.")
        gap = 0.35
        width = (CONTENT_W - gap) / 2
        height = BODY_BOTTOM - top - 0.05
        columns = []
        for column in (spec.left, spec.right):
            paras = _bullet_paras(column.text, column.bullets)
            body_top = 0.62 if column.heading else 0.15
            columns.append((column, paras, body_top))
        size = 20
        for _, paras, body_top in columns:
            if paras:
                s, overflow = _fit(paras, width - 0.4, height - body_top - 0.2, 20, 12)
                size = min(size, s)
                if overflow:
                    self.warn(index, "a column's text does not fit; cut it down.")
        # Cards as tall as the longer column (not the whole body), so short
        # columns do not leave a large empty box
        needed = max((_paras_height(paras, size, width - 0.4) + body_top + 0.35 if paras else body_top + 0.2) for _, paras, body_top in columns)
        height = min(height, max(needed, 2.2))
        for i, (column, paras, body_top) in enumerate(columns):
            x = MARGIN_X + i * (width + gap)
            _shape(slide, MSO_SHAPE.RECTANGLE, x, top, width, height, p.tint)
            if column.heading:
                bar = _shape(slide, MSO_SHAPE.RECTANGLE, x, top, width, 0.55, p.primary)
                h_size, _ = _fit([_Para(column.heading, bold=True)], width - 0.3, 0.5, 18, 12)
                _shape_text(bar, [_Para(column.heading, bold=True, color="FFFFFF")], h_size, p, PP_ALIGN.LEFT, margin_x=0.2)
            if paras:
                _write(_textbox(slide, x + 0.2, top + body_top + 0.05, width - 0.4, height - body_top - 0.15), paras, size, p)

    def table_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        table_spec = spec.table
        if not table_spec or not table_spec.columns:
            raise DocumentError(f"Slide {index} (table) needs table.columns and table.rows.")
        cols = len(table_spec.columns)
        rows = [[("" if v is None else str(v)) for v in row] for row in table_spec.rows]
        for r, row in enumerate(rows):
            if len(row) != cols:
                raise DocumentError(f"Slide {index}: table row {r + 1} has {len(row)} cells but there are {cols} columns.")
        count = len(rows) + 1
        size = 16 if count <= 7 else 14 if count <= 10 else 12 if count <= 14 else 11 if count <= 18 else 10
        if count > 18:
            self.warn(index, f"{len(rows)} rows is too many for one slide; split the table or summarize it.")
        note_h = 0.45 if spec.text else 0.0
        available = BODY_BOTTOM - top - 0.05 - note_h

        if table_spec.column_widths and len(table_spec.column_widths) == cols:
            weights = [max(w, 0.1) for w in table_spec.column_widths]
        else:
            weights = []
            for c in range(cols):
                cells = [table_spec.columns[c]] + [row[c] for row in rows]
                weights.append(min(max(max(text_width_em(t) for t in cells), 3), 24))
        total = sum(weights)
        widths = [CONTENT_W * w / total for w in weights]

        def row_height(cells: list[str], s: float) -> float:
            return max(_lines(t or " ", s, widths[c] - 0.18) for c, t in enumerate(cells)) * _line_height(s) + 0.14

        heights = [row_height(table_spec.columns, size)] + [row_height(row, size) for row in rows]
        while sum(heights) > available and size > 9:
            size -= 1
            heights = [row_height(table_spec.columns, size)] + [row_height(row, size) for row in rows]
        if sum(heights) > available:
            self.warn(index, "the table does not fit on the slide; split it or shorten the cell text.")

        shape = slide.shapes.add_table(count, cols, Inches(MARGIN_X), Inches(top), Inches(CONTENT_W), Inches(sum(heights)))
        table = shape.table
        table.first_row = True
        table.horz_banding = False
        for c, width in enumerate(widths):
            table.columns[c].width = Inches(width)
        numeric = [all(_is_number(row[c]) for row in rows if row[c]) and any(row[c] for row in rows) for c in range(cols)]
        for r in range(count):
            table.rows[r].height = Inches(heights[r])
            for c in range(cols):
                cell = table.cell(r, c)
                cell.margin_left = cell.margin_right = Inches(0.09)
                cell.margin_top = cell.margin_bottom = Inches(0.05)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.fill.solid()
                frame = cell.text_frame
                frame.word_wrap = True
                paragraph = frame.paragraphs[0]
                if r == 0:
                    cell.fill.fore_color.rgb = _rgb(p.primary)
                    paragraph.alignment = PP_ALIGN.CENTER if numeric[c] else PP_ALIGN.LEFT
                    _add_text(paragraph, table_spec.columns[c], size, "FFFFFF", True)
                else:
                    cell.fill.fore_color.rgb = _rgb(p.tint if r % 2 == 0 else "FFFFFF")
                    paragraph.alignment = PP_ALIGN.RIGHT if numeric[c] else PP_ALIGN.LEFT
                    _add_text(paragraph, rows[r - 1][c], size, p.text)
        if spec.text:
            frame = _textbox(slide, MARGIN_X, min(top + sum(heights) + 0.08, BODY_BOTTOM - note_h), CONTENT_W, note_h)
            _write(frame, [_Para(spec.text, color=p.muted)], 12, p)

    def chart_slide(self, index: int, spec: Slide) -> None:
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        if not spec.chart:
            raise DocumentError(f"Slide {index} (chart) needs chart.")
        paras = _bullet_paras(spec.text, spec.bullets)
        height = BODY_BOTTOM - top
        if paras:
            chart_w = 7.9
            self.text_block(slide, index, paras, MARGIN_X + chart_w + 0.3, top + 0.1, CONTENT_W - chart_w - 0.3, height - 0.1, 20, 12)
        else:
            chart_w = CONTENT_W
        add_chart(slide, spec.chart, self.palette, MARGIN_X, top, chart_w, height, lambda m: self.warn(index, m))

    def stats_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        stats = spec.stats or []
        if not 1 <= len(stats) <= 6:
            raise DocumentError(f"Slide {index} (stats) needs 1-6 stats.")
        paras = _bullet_paras(spec.text, spec.bullets)
        per_row = len(stats) if len(stats) <= 4 else math.ceil(len(stats) / 2)
        row_count = math.ceil(len(stats) / per_row)
        gap = 0.3
        card_w = (CONTENT_W - gap * (per_row - 1)) / per_row
        cards_h = (BODY_BOTTOM - top) * (0.55 if paras else 1.0)
        card_h = min((cards_h - gap * (row_count - 1)) / row_count, 2.6)
        for i, stat in enumerate(stats):
            x = MARGIN_X + (i % per_row) * (card_w + gap)
            y = top + (i // per_row) * (card_h + gap)
            _shape(slide, MSO_SHAPE.RECTANGLE, x, y, card_w, card_h, p.tint)
            _shape(slide, MSO_SHAPE.RECTANGLE, x, y, card_w, 0.07, p.accent)
            value_size = 44
            while value_size > 22 and text_width_em(stat.value) * value_size / 72 > card_w - 0.4:
                value_size -= 2
            frame = _textbox(slide, x + 0.2, y + 0.15, card_w - 0.4, card_h * 0.48, anchor=MSO_ANCHOR.BOTTOM)
            _write(frame, [_Para(stat.value, bold=True, color=p.primary)], value_size, p)
            label = [_Para(stat.label, bold=True)] + ([_Para(stat.note, scale=0.8, color=p.muted)] if stat.note else [])
            label_h = card_h * 0.52 - 0.25
            size, overflow = _fit(label, card_w - 0.4, label_h, 16, 10)
            if overflow:
                self.warn(index, f"the label of '{stat.value}' is too long.")
            _write(_textbox(slide, x + 0.2, y + 0.15 + card_h * 0.48 + 0.05, card_w - 0.4, label_h), label, size, p)
        if paras:
            y = top + row_count * card_h + (row_count - 1) * gap + 0.3
            self.text_block(slide, index, paras, MARGIN_X, y, CONTENT_W, BODY_BOTTOM - y, 20, 12)

    def steps_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        steps = spec.steps or []
        if not 2 <= len(steps) <= 6:
            raise DocumentError(f"Slide {index} (steps) needs 2-6 steps.")
        n = len(steps)
        gap = 0.06
        width = (CONTENT_W - gap * (n - 1)) / n
        title_size = 20
        for step in steps:
            s, overflow = _fit([_Para(step.title, bold=True)], width - 0.6, 0.85, 20, 11)
            title_size = min(title_size, s)
            if overflow:
                self.warn(index, f"the step title '{step.title}' is too long.")
        texts = [[_Para(step.text)] if step.text else [] for step in steps]
        text_h = BODY_BOTTOM - top - 1.2
        text_size = 18
        for paras in texts:
            if paras:
                s, overflow = _fit(paras, width - 0.2, text_h, 18, 10)
                text_size = min(text_size, s)
                if overflow:
                    self.warn(index, "a step description is too long.")
        for i, step in enumerate(steps):
            x = MARGIN_X + i * (width + gap)
            kind = MSO_SHAPE.PENTAGON if i == 0 else MSO_SHAPE.CHEVRON
            fill = p.primary if i % 2 == 0 else _shade(p.primary)
            arrow = _shape(slide, kind, x, top, width, 0.95, fill)
            _shape_text(arrow, [_Para(step.title, bold=True, color="FFFFFF")], title_size, p, margin_x=0.32 if i else 0.15)
            label = _textbox(slide, x, top + 0.98, width, 0.3)
            _write(label, [_Para(f"STEP {i + 1}", bold=True, color=p.accent)], 11, p, PP_ALIGN.CENTER)
            if texts[i]:
                _write(_textbox(slide, x + 0.1, top + 1.3, width - 0.2, text_h), texts[i], text_size, p)

    def quote_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec) if spec.title else 1.0
        if not spec.title:
            self.footer_bar(slide, index)
        if not spec.quote:
            raise DocumentError(f"Slide {index} (quote) needs quote.")
        mark = _textbox(slide, MARGIN_X + 0.2, top - 0.1, 1.2, 1.3)
        _write(mark, [_Para("“", bold=True, color=p.accent)], 96, p)
        height = BODY_BOTTOM - top - 1.2
        size, overflow = _fit([_Para(spec.quote, bold=True)], 10.4, height, 30, 16)
        if overflow:
            self.warn(index, "the quote is too long.")
        _write(_textbox(slide, 1.6, top + 0.6, 10.4, height, anchor=MSO_ANCHOR.MIDDLE), [_Para(spec.quote, bold=True, color=p.primary)], size, p)
        if spec.attribution:
            frame = _textbox(slide, 1.6, BODY_BOTTOM - 0.55, 10.4, 0.5)
            _write(frame, [_Para(f"— {spec.attribution}", color=p.muted)], 16, p, PP_ALIGN.RIGHT)

    def image_slide(self, index: int, spec: Slide) -> None:
        p = self.palette
        slide = self.new_slide()
        top = self.header(slide, index, spec)
        if not spec.image:
            raise DocumentError(f"Slide {index} (image) needs image.")
        path = resolve_source(spec.image)
        try:
            with Image.open(path) as img:
                img_w, img_h = img.size
        except Exception as e:
            raise DocumentError(f"Slide {index}: {spec.image} is not a readable PNG/JPEG image.") from e
        paras = _bullet_paras(spec.text, spec.bullets)
        box_w = 7.6 if paras else CONTENT_W
        caption_h = 0.4 if spec.caption else 0.0
        box_h = BODY_BOTTOM - top - caption_h - 0.05
        scale = min(box_w / img_w, box_h / img_h)
        w, h = img_w * scale, img_h * scale
        x = MARGIN_X + (box_w - w) / 2
        slide.shapes.add_picture(path, Inches(x), Inches(top), Inches(w), Inches(h))
        if spec.caption:
            frame = _textbox(slide, MARGIN_X, top + h + 0.05, box_w, caption_h)
            _write(frame, [_Para(spec.caption, color=p.muted)], 12, p, PP_ALIGN.CENTER)
        if paras:
            self.text_block(slide, index, paras, MARGIN_X + box_w + 0.3, top + 0.1, CONTENT_W - box_w - 0.3, BODY_BOTTOM - top - 0.1, 20, 12)


def _shade(color: str) -> str:
    return mix(color, "FFFFFF", 0.22)


def _is_number(text: str) -> bool:
    return bool(re.fullmatch(r"[\s¥$€£+\-−△▲▼]*[\d,]+(\.\d+)?\s*(%|％|円|千円|万円|億円|件|人|個|台|時間|h|pt)?", text.strip()))


# --- Charts ------------------------------------------------------------------

_CHART_TYPES = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "stacked_column": XL_CHART_TYPE.COLUMN_STACKED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "stacked_bar": XL_CHART_TYPE.BAR_STACKED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "area": XL_CHART_TYPE.AREA,
    "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}


def add_chart(slide, spec: SlideChart, palette: Palette, x: float, y: float, w: float, h: float, warn) -> None:
    if not spec.categories or not spec.series:
        raise DocumentError("A chart needs categories and at least one series.")
    for series in spec.series:
        if len(series.values) != len(spec.categories):
            raise DocumentError(f"Chart series '{series.name}' has {len(series.values)} values for {len(spec.categories)} categories.")
    round_chart = spec.type in ("pie", "doughnut")
    series_list = spec.series[:1] if round_chart else spec.series
    if round_chart and len(spec.series) > 1:
        warn("a pie/doughnut chart shows only its first series.")
    categories = list(spec.categories)
    values = [list(s.values) for s in series_list]
    horizontal = spec.type in ("bar", "stacked_bar")
    if horizontal:
        # Bar charts draw the first category at the bottom; flip so it reads top-down
        categories.reverse()
        values = [list(reversed(v)) for v in values]
    data = CategoryChartData(number_format=spec.number_format or "General")
    data.categories = categories
    for series, series_values in zip(series_list, values, strict=True):
        data.add_series(series.name, series_values)
    frame = slide.shapes.add_chart(_CHART_TYPES[spec.type], Inches(x), Inches(y), Inches(w), Inches(h), data)
    chart = frame.chart
    _apply_font(chart.font._rPr, 12, palette.text, False)

    if spec.title:
        chart.has_title = True
        chart.chart_title.text_frame.text = spec.title
        for paragraph in chart.chart_title.text_frame.paragraphs:
            for run in paragraph.runs:
                _apply_font(run._r.get_or_add_rPr(), 16, palette.text, True)
    else:
        chart.has_title = False

    multi = len(series_list) > 1
    chart.has_legend = multi or round_chart
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
        _apply_font(chart.legend.font._rPr, 12, palette.text, False)

    plot = chart.plots[0]
    colors = palette.series(len(categories) if round_chart else len(series_list))
    show_labels = spec.data_labels
    if show_labels is None:
        show_labels = round_chart or (not multi and len(categories) <= 12 and spec.type != "area")
    if show_labels:
        plot.has_data_labels = True
        labels = plot.data_labels
        _apply_font(labels.font._rPr, 11, palette.text, False)
        if round_chart:
            labels.show_percentage = True
            labels.show_value = False
            labels.number_format = "0%"
            labels.number_format_is_linked = False
            labels.position = XL_LABEL_POSITION.OUTSIDE_END if spec.type == "pie" else XL_LABEL_POSITION.CENTER
        else:
            if spec.number_format:
                labels.number_format = spec.number_format
                labels.number_format_is_linked = False
            if spec.type in ("column", "bar"):
                labels.position = XL_LABEL_POSITION.OUTSIDE_END
            elif spec.type == "line":
                labels.position = XL_LABEL_POSITION.ABOVE
            else:
                labels.position = XL_LABEL_POSITION.CENTER

    if round_chart:
        series = plot.series[0]
        for i, point in enumerate(series.points):
            point.format.fill.solid()
            point.format.fill.fore_color.rgb = _rgb(colors[i])
            point.format.line.color.rgb = _rgb("FFFFFF")
        if spec.type == "doughnut":
            hole = plot._element.find(qn("c:holeSize"))
            if hole is not None:
                hole.set("val", "55")
        return

    if spec.type in ("column", "stacked_column", "bar", "stacked_bar"):
        plot.gap_width = 70
        if spec.type.startswith("stacked"):
            plot.overlap = 100
    for i, series in enumerate(plot.series):
        if spec.type == "line":
            series.format.line.color.rgb = _rgb(colors[i])
            series.format.line.width = Pt(2.5)
            series.smooth = False
            series.marker.style = XL_MARKER_STYLE.CIRCLE
            series.marker.size = 7
            series.marker.format.fill.solid()
            series.marker.format.fill.fore_color.rgb = _rgb(colors[i])
            series.marker.format.line.color.rgb = _rgb(colors[i])
        else:
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = _rgb(colors[i])

    value_axis = chart.value_axis
    value_axis.has_major_gridlines = True
    value_axis.major_gridlines.format.line.color.rgb = _rgb(palette.line)
    value_axis.major_gridlines.format.line.width = Pt(0.75)
    value_axis.format.line.fill.background()
    _apply_font(value_axis.tick_labels.font._rPr, 11, palette.muted, False)
    if spec.number_format:
        value_axis.tick_labels.number_format = spec.number_format
        value_axis.tick_labels.number_format_is_linked = False
    category_axis = chart.category_axis
    category_axis.format.line.color.rgb = _rgb(palette.line)
    category_axis.has_major_gridlines = False
    _apply_font(category_axis.tick_labels.font._rPr, 11, palette.text, False)


# --- Entry point -------------------------------------------------------------


def build_presentation(path: str, slides: list[Slide], palette: Palette, title: str | None = None, footer: str | None = None) -> list[str]:
    """Write the deck to path; returns warnings for the model"""
    if not slides:
        raise DocumentError("A presentation needs at least one slide.")
    builder = _Builder(palette, footer)
    renderers = {
        "title": builder.title_slide,
        "closing": lambda i, s: builder.title_slide(i, s, closing=True),
        "section": builder.section_slide,
        "agenda": builder.agenda_slide,
        "bullets": builder.bullets_slide,
        "two_column": builder.two_column_slide,
        "table": builder.table_slide,
        "chart": builder.chart_slide,
        "stats": builder.stats_slide,
        "steps": builder.steps_slide,
        "quote": builder.quote_slide,
        "image": builder.image_slide,
    }
    for index, spec in enumerate(slides, start=1):
        renderers[spec.layout](index, spec)
        if spec.notes:
            builder.prs.slides[index - 1].notes_slide.notes_text_frame.text = spec.notes
    if title or slides[0].title:
        builder.prs.core_properties.title = title or slides[0].title
    builder.prs.save(path)
    return builder.warnings


__all__ = ["Slide", "build_presentation"]
