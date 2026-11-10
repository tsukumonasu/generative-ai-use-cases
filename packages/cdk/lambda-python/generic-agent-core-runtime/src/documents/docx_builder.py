"""Word documents from a declarative spec.

A4 portrait (or landscape), one font, headings in the palette's primary
color, tables with a colored header row and page numbers in the footer.
"""

import re
from typing import Literal

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Mm, Pt
from PIL import Image
from pydantic import BaseModel, Field

from .common import FONT, DocumentError, Palette, mix, resolve_source, text_width_em

# --- Spec --------------------------------------------------------------------


class ListItem(BaseModel):
    text: str
    level: int = Field(1, ge=1, le=3, description="Indent level, 1-3")


class DocTable(BaseModel):
    columns: list[str] = Field(description="Header cells")
    rows: list[list[str | int | float | None]] = Field(description="Body rows, each as long as columns")
    column_widths: list[float] | None = Field(None, description="Relative column widths, e.g. [3, 1, 1]. Omit to size by content.")


class Block(BaseModel):
    type: Literal["heading", "paragraph", "bullets", "numbered", "table", "callout", "quote", "image", "page_break"]
    text: str | None = Field(None, description="heading/paragraph/callout/quote: the text. **bold** and [link](https://...) are supported; a blank line starts a new paragraph.")
    level: int | None = Field(None, ge=1, le=3, description="heading: 1-3")
    items: list[str | ListItem] | None = Field(None, description="bullets/numbered: the items")
    table: DocTable | None = Field(None, description="table: the table")
    caption: str | None = Field(None, description="table/image: caption")
    style: Literal["info", "warning", "note"] | None = Field(None, description="callout: info (default), warning or note")
    attribution: str | None = Field(None, description="quote: who said it")
    image: str | None = Field(None, description="image: a PNG/JPEG under /tmp/ws or the S3 URL of an image this assistant created")
    width_percent: int | None = Field(None, ge=10, le=100, description="image: width as a percentage of the text width (default: natural size, at most 100)")


# --- Helpers -----------------------------------------------------------------

_INLINE_RE = re.compile(r"(\*\*[^*]+\*\*|\[[^\]]+\]\(https?://[^)\s]+\))")
# Only http(s) links become hyperlinks; any other text, including a
# "[label](file://...)" that the split leaves in the plain text, stays text.
_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def _set_run_font(run_or_style_rPr, size: float | None = None, color: str | None = None, bold: bool | None = None) -> None:
    """Explicit Latin + East Asian font (no theme fonts) on a w:rPr"""
    rPr = run_or_style_rPr
    fonts = rPr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        _insert_rPr_child(rPr, fonts)
    for attr in list(fonts.attrib):
        if attr.endswith("Theme"):
            del fonts.attrib[attr]
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        fonts.set(qn(attr), FONT)
    if bold is not None:
        for tag in ("w:b", "w:bCs"):
            el = rPr.find(qn(tag))
            if el is None:
                el = OxmlElement(tag)
                _insert_rPr_child(rPr, el)
            el.set(qn("w:val"), "1" if bold else "0")
    if color is not None:
        el = rPr.find(qn("w:color"))
        if el is None:
            el = OxmlElement("w:color")
            _insert_rPr_child(rPr, el)
        for attr in list(el.attrib):
            del el.attrib[attr]
        el.set(qn("w:val"), color)
    if size is not None:
        for tag in ("w:sz", "w:szCs"):
            el = rPr.find(qn(tag))
            if el is None:
                el = OxmlElement(tag)
                _insert_rPr_child(rPr, el)
            el.set(qn("w:val"), str(int(round(size * 2))))


# Schema order of the property elements this module writes. Word rejects
# files whose property children are out of order.
_RPR_ORDER = [qn(t) for t in ("w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:strike", "w:color", "w:spacing", "w:kern", "w:sz", "w:szCs", "w:highlight", "w:u", "w:shd", "w:vertAlign", "w:lang")]
_PPR_ORDER = [
    qn(t)
    for t in (
        "w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs",
        "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd",
        "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment",
        "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange",
    )
]  # fmt: skip
_TBLPR_ORDER = [qn(t) for t in ("w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize", "w:tblStyleColBandSize", "w:tblW", "w:jc", "w:tblCellSpacing", "w:tblInd", "w:tblBorders", "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook")]
_TCPR_ORDER = [qn(t) for t in ("w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders", "w:shd", "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark")]


def _insert_ordered(parent, element, order: list[str]) -> None:
    """Insert element before the first child that must follow it"""
    position = order.index(element.tag) if element.tag in order else len(order)
    for child in parent:
        if child.tag in order and order.index(child.tag) > position:
            child.addprevious(element)
            return
    parent.append(element)


def _insert_rPr_child(rPr, element) -> None:
    _insert_ordered(rPr, element, _RPR_ORDER)


def _style_rPr(style):
    return style.element.get_or_add_rPr()


def _add_runs(paragraph, text: str, size: float | None = None, color: str | None = None, bold: bool = False, link_color: str | None = None) -> None:
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if i:
            paragraph.add_run().add_break()
        for token in _INLINE_RE.split(line):
            if not token:
                continue
            if token.startswith("**") and token.endswith("**") and len(token) > 4:
                run = paragraph.add_run(token[2:-2])
                _set_run_font(run._r.get_or_add_rPr(), size, color, True)
            elif link := _LINK_RE.fullmatch(token):
                _add_hyperlink(paragraph, link.group(1), link.group(2), size, link_color or color)
            else:
                run = paragraph.add_run(token)
                _set_run_font(run._r.get_or_add_rPr(), size, color, bold or None)


def _add_hyperlink(paragraph, text: str, url: str, size: float | None, color: str | None) -> None:
    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    run.append(rPr)
    _set_run_font(rPr, size, color or "1F5FBF", None)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    _insert_rPr_child(rPr, underline)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def _shade(element_pr, fill: str) -> None:
    """w:shd on a w:pPr or w:tcPr"""
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    _insert_ordered(element_pr, shd, _TCPR_ORDER if element_pr.tag == qn("w:tcPr") else _PPR_ORDER)


def _paragraph_border(paragraph, side: str, color: str, size: int, space: int = 4) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    borders = pPr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        _insert_ordered(pPr, borders, _PPR_ORDER)
    edge = OxmlElement(f"w:{side}")
    edge.set(qn("w:val"), "single")
    edge.set(qn("w:sz"), str(size))
    edge.set(qn("w:space"), str(space))
    edge.set(qn("w:color"), color)
    # Order inside w:pBdr: top, left, bottom, right
    _insert_ordered(borders, edge, [qn(f"w:{t}") for t in ("top", "left", "bottom", "right", "between", "bar")])


def _add_field(paragraph, instruction: str, size: float, color: str) -> None:
    def run_with(child):
        run = paragraph.add_run()
        _set_run_font(run._r.get_or_add_rPr(), size, color, None)
        run._r.append(child)

    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    run_with(begin)
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {instruction} "
    run_with(instr)
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    run_with(separate)
    run = paragraph.add_run("1")
    _set_run_font(run._r.get_or_add_rPr(), size, color, None)
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run_with(end)


def _is_number(text: str) -> bool:
    return bool(re.fullmatch(r"[\s¥$€£+\-−△▲▼]*[\d,]+(\.\d+)?\s*(%|％|円|千円|万円|億円|件|人|個|台|時間|h|pt)?", text.strip()))


# --- Numbering ---------------------------------------------------------------

_W_NS = nsdecls("w")


def _abstract_num_xml(abstract_id: int, kind: str, color: str) -> str:
    indent = 420  # twips (7.4 mm)
    if kind == "bullet":
        levels = [("bullet", "●", 0.7), ("bullet", "–", 1.0), ("bullet", "・", 1.0)]
    else:
        levels = [("decimal", "%1.", 1.0), ("decimal", "(%2)", 1.0), ("decimalEnclosedCircle", "%3", 1.0)]
    xml = f'<w:abstractNum {_W_NS} w:abstractNumId="{abstract_id}"><w:multiLevelType w:val="multilevel"/>'
    for i, (fmt, text, scale) in enumerate(levels):
        size = f'<w:sz w:val="{int(21 * scale)}"/>' if kind == "bullet" else ""
        run_color = f'<w:color w:val="{color}"/>' if kind == "bullet" and i == 0 else ""
        xml += f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{indent * (i + 1)}" w:hanging="{indent}"/></w:pPr><w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}"/>{run_color}{size}</w:rPr></w:lvl>'
    return xml + "</w:abstractNum>"


class _Numbering:
    """Custom bullet and numbered-list definitions; every list gets its own
    numbering instance, so each numbered list starts at 1"""

    def __init__(self, doc, palette: Palette):
        self.root = doc.part.numbering_part.element
        existing = [int(el.get(qn("w:abstractNumId"))) for el in self.root.findall(qn("w:abstractNum"))]
        base = max(existing, default=0) + 1
        self.abstract_ids = {"bullet": base, "number": base + 1}
        first_num = self.root.find(qn("w:num"))
        for kind, abstract_id in self.abstract_ids.items():
            element = parse_xml(_abstract_num_xml(abstract_id, kind, palette.accent))
            if first_num is not None:
                first_num.addprevious(element)
            else:
                self.root.append(element)

    def new_list(self, kind: str) -> int:
        num_ids = [int(el.get(qn("w:numId"))) for el in self.root.findall(qn("w:num"))]
        num_id = max(num_ids, default=0) + 1
        # Instances of one definition continue each other's numbering unless
        # every level is told to start over
        overrides = "".join(f'<w:lvlOverride w:ilvl="{level}"><w:startOverride w:val="1"/></w:lvlOverride>' for level in range(3))
        self.root.append(parse_xml(f'<w:num {_W_NS} w:numId="{num_id}"><w:abstractNumId w:val="{self.abstract_ids[kind]}"/>{overrides}</w:num>'))
        return num_id


def _set_numbering(paragraph, num_id: int, level: int) -> None:
    numPr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), str(level - 1))
    num = OxmlElement("w:numId")
    num.set(qn("w:val"), str(num_id))
    numPr.append(ilvl)
    numPr.append(num)
    _insert_ordered(paragraph._p.get_or_add_pPr(), numPr, _PPR_ORDER)


# --- Builder -----------------------------------------------------------------


class _Builder:
    def __init__(self, palette: Palette, landscape: bool):
        self.palette = palette
        self.doc = Document()
        self.warnings: list[str] = []
        section = self.doc.sections[0]
        if landscape:
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = Mm(297), Mm(210)
        else:
            section.page_width, section.page_height = Mm(210), Mm(297)
        section.top_margin = section.bottom_margin = Mm(22)
        section.left_margin = section.right_margin = Mm(22)
        section.header_distance = section.footer_distance = Mm(10)
        self.text_width_mm = (297 if landscape else 210) - 44
        self._setup_styles()
        self.numbering = _Numbering(self.doc, palette)

    def _setup_styles(self) -> None:
        p = self.palette
        styles = self.doc.styles
        # Document defaults: font, Japanese as the East Asian language
        defaults = styles.element.find(qn("w:docDefaults"))
        rPr = defaults.find(qn("w:rPrDefault")).find(qn("w:rPr"))
        _set_run_font(rPr)
        lang = rPr.find(qn("w:lang"))
        if lang is None:
            lang = OxmlElement("w:lang")
            _insert_rPr_child(rPr, lang)
        lang.set(qn("w:eastAsia"), "ja-JP")

        normal = styles["Normal"]
        _set_run_font(_style_rPr(normal), 10.5, p.text)
        normal.paragraph_format.space_after = Pt(6)
        normal.paragraph_format.line_spacing = 1.35

        for level, (size, before, after) in {1: (16, 18, 8), 2: (13, 14, 6), 3: (11.5, 10, 4)}.items():
            style = styles[f"Heading {level}"]
            _set_run_font(_style_rPr(style), size, p.primary if level < 3 else p.text, True)
            for tag in ("w:i", "w:iCs"):
                el = _style_rPr(style).find(qn(tag))
                if el is not None:
                    el.getparent().remove(el)
            fmt = style.paragraph_format
            fmt.space_before, fmt.space_after = Pt(before), Pt(after)
            fmt.keep_with_next = True
            fmt.line_spacing = 1.2

        caption = styles["Caption"]
        _set_run_font(_style_rPr(caption), 9, p.muted, False)
        caption.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption.paragraph_format.space_after = Pt(10)

    # Title block, header and footer --------------------------------------

    def title_block(self, title: str | None, subtitle: str | None, meta: str | None) -> None:
        p = self.palette
        if title:
            para = self.doc.add_paragraph()
            para.paragraph_format.space_after = Pt(4)
            para.paragraph_format.line_spacing = 1.15
            _add_runs(para, title, 22, p.primary, True)
        if subtitle:
            para = self.doc.add_paragraph()
            para.paragraph_format.space_after = Pt(2)
            _add_runs(para, subtitle, 12.5, p.muted)
        if meta:
            para = self.doc.add_paragraph()
            para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            _add_runs(para, meta, 10, p.muted)
        if title or subtitle or meta:
            rule = self.doc.add_paragraph()
            rule.paragraph_format.space_after = Pt(12)
            _paragraph_border(rule, "bottom", p.accent, 12, 1)

    def header_footer(self, header_text: str | None) -> None:
        p = self.palette
        section = self.doc.sections[0]
        if header_text:
            para = section.header.paragraphs[0]
            para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            _add_runs(para, header_text, 9, p.muted)
        para = section.footer.paragraphs[0]
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _add_field(para, "PAGE", 9, p.muted)
        run = para.add_run(" / ")
        _set_run_font(run._r.get_or_add_rPr(), 9, p.muted, None)
        _add_field(para, "NUMPAGES", 9, p.muted)

    # Blocks ----------------------------------------------------------------

    def heading(self, index: int, block: Block) -> None:
        if not block.text:
            raise DocumentError(f"Block {index} (heading) needs text.")
        level = block.level or 1
        para = self.doc.add_paragraph(style=f"Heading {level}")
        _add_runs(para, block.text, link_color=self.palette.primary)
        if level == 1:
            _paragraph_border(para, "bottom", self.palette.line, 6, 3)

    def paragraph(self, index: int, block: Block) -> None:
        if not block.text:
            raise DocumentError(f"Block {index} (paragraph) needs text.")
        for chunk in re.split(r"\n\s*\n", block.text.strip()):
            para = self.doc.add_paragraph()
            _add_runs(para, chunk.strip())

    def list_block(self, index: int, block: Block) -> None:
        if not block.items:
            raise DocumentError(f"Block {index} ({block.type}) needs items.")
        num_id = self.numbering.new_list("bullet" if block.type == "bullets" else "number")
        for i, item in enumerate(block.items):
            text, level = (item.text, item.level) if isinstance(item, ListItem) else (str(item), 1)
            para = self.doc.add_paragraph()
            _set_numbering(para, num_id, level)
            para.paragraph_format.space_after = Pt(3 if i < len(block.items) - 1 else 8)
            _add_runs(para, text)

    def table(self, index: int, block: Block) -> None:
        p = self.palette
        spec = block.table
        if not spec or not spec.columns:
            raise DocumentError(f"Block {index} (table) needs table.columns and table.rows.")
        cols = len(spec.columns)
        rows = [[("" if v is None else str(v)) for v in row] for row in spec.rows]
        for r, row in enumerate(rows):
            if len(row) != cols:
                raise DocumentError(f"Block {index}: table row {r + 1} has {len(row)} cells but there are {cols} columns.")
        if spec.column_widths and len(spec.column_widths) == cols:
            weights = [max(w, 0.1) for w in spec.column_widths]
        else:
            weights = [min(max(max(text_width_em(t) for t in [spec.columns[c]] + [row[c] for row in rows]), 3), 30) for c in range(cols)]
        widths = [Mm(self.text_width_mm * w / sum(weights)) for w in weights]
        numeric = [all(_is_number(row[c]) for row in rows if row[c]) and any(row[c] for row in rows) for c in range(cols)]
        size = 10 if cols <= 5 else 9 if cols <= 7 else 8

        table = self.doc.add_table(rows=len(rows) + 1, cols=cols)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        tblPr = table._tbl.tblPr
        # Full text width: the table width and the grid, not only the cells
        tblW = tblPr.find(qn("w:tblW"))
        if tblW is None:
            tblW = OxmlElement("w:tblW")
            _insert_ordered(tblPr, tblW, _TBLPR_ORDER)
        tblW.set(qn("w:type"), "dxa")
        tblW.set(qn("w:w"), str(sum(w.twips for w in widths)))
        for grid_col, width in zip(table._tbl.tblGrid.findall(qn("w:gridCol")), widths, strict=True):
            grid_col.set(qn("w:w"), str(width.twips))
        borders = parse_xml(f"<w:tblBorders {_W_NS}>" + "".join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="{p.line}"/>' for side in ("top", "left", "bottom", "right", "insideH", "insideV")) + "</w:tblBorders>")
        _insert_ordered(tblPr, borders, _TBLPR_ORDER)
        for r in range(len(rows) + 1):
            row = table.rows[r]
            if r == 0:
                trPr = row._tr.get_or_add_trPr()
                header = OxmlElement("w:tblHeader")
                header.set(qn("w:val"), "1")
                trPr.append(header)  # the only row property written
            for c in range(cols):
                cell = row.cells[c]
                cell.width = widths[c]
                para = cell.paragraphs[0]
                para.paragraph_format.space_after = Pt(0)
                para.paragraph_format.line_spacing = 1.15
                tcPr = cell._tc.get_or_add_tcPr()
                if r == 0:
                    _shade(tcPr, p.primary)
                    para.alignment = WD_ALIGN_PARAGRAPH.CENTER if numeric[c] else WD_ALIGN_PARAGRAPH.LEFT
                    _add_runs(para, spec.columns[c], size, "FFFFFF", True)
                else:
                    if r % 2 == 0:
                        _shade(tcPr, p.tint)
                    para.alignment = WD_ALIGN_PARAGRAPH.RIGHT if numeric[c] else WD_ALIGN_PARAGRAPH.LEFT
                    _add_runs(para, rows[r - 1][c], size)
        if block.caption:
            self.doc.add_paragraph(block.caption, style="Caption")
        else:
            spacer = self.doc.add_paragraph()
            spacer.paragraph_format.space_after = Pt(4)

    def callout(self, index: int, block: Block) -> None:
        if not block.text:
            raise DocumentError(f"Block {index} (callout) needs text.")
        p = self.palette
        color = {"info": p.primary, "warning": p.accent, "note": p.muted}[block.style or "info"]
        para = self.doc.add_paragraph()
        fmt = para.paragraph_format
        fmt.left_indent = Mm(2)
        fmt.space_before, fmt.space_after = Pt(4), Pt(10)
        _paragraph_border(para, "left", color, 24, 8)
        _shade(para._p.get_or_add_pPr(), mix(color, "FFFFFF", 0.9))
        _add_runs(para, block.text)

    def quote(self, index: int, block: Block) -> None:
        if not block.text:
            raise DocumentError(f"Block {index} (quote) needs text.")
        p = self.palette
        para = self.doc.add_paragraph()
        para.paragraph_format.left_indent = Mm(6)
        para.paragraph_format.space_after = Pt(2 if block.attribution else 10)
        _paragraph_border(para, "left", p.line, 18, 8)
        _add_runs(para, block.text, None, p.muted)
        if block.attribution:
            para = self.doc.add_paragraph()
            para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            _add_runs(para, f"— {block.attribution}", 9.5, p.muted)

    def image(self, index: int, block: Block) -> None:
        if not block.image:
            raise DocumentError(f"Block {index} (image) needs image.")
        path = resolve_source(block.image)
        try:
            with Image.open(path) as img:
                px_w, _ = img.size
                dpi = img.info.get("dpi", (96, 96))[0] or 96
        except Exception as e:
            raise DocumentError(f"Block {index}: {block.image} is not a readable PNG/JPEG image.") from e
        natural_mm = px_w / dpi * 25.4
        width = self.text_width_mm * block.width_percent / 100 if block.width_percent else min(natural_mm, self.text_width_mm)
        self.doc.add_picture(path, width=Mm(width))
        self.doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if block.caption:
            self.doc.add_paragraph(block.caption, style="Caption")

    def page_break(self, index: int, block: Block) -> None:
        self.doc.add_page_break()


def build_document(
    path: str,
    blocks: list[Block],
    palette: Palette,
    title: str | None = None,
    subtitle: str | None = None,
    meta: str | None = None,
    header: str | None = None,
    landscape: bool = False,
) -> list[str]:
    """Write the document to path; returns warnings for the model"""
    if not blocks and not title:
        raise DocumentError("A document needs a title or at least one block.")
    builder = _Builder(palette, landscape)
    # The template's empty first paragraph would leave a blank line on top
    body = builder.doc.element.body
    for para in list(body.findall(qn("w:p"))):
        body.remove(para)
    builder.title_block(title, subtitle, meta)
    builder.header_footer(header)
    renderers = {
        "heading": builder.heading,
        "paragraph": builder.paragraph,
        "bullets": builder.list_block,
        "numbered": builder.list_block,
        "table": builder.table,
        "callout": builder.callout,
        "quote": builder.quote,
        "image": builder.image,
        "page_break": builder.page_break,
    }
    for index, block in enumerate(blocks, start=1):
        renderers[block.type](index, block)
    if title:
        builder.doc.core_properties.title = title
    builder.doc.save(path)
    return builder.warnings


__all__ = ["Block", "build_document"]
