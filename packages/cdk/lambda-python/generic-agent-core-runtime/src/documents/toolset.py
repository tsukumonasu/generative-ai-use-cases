"""Strands tools for the office-documents built-in server.

The tools take content as data and render it themselves, so creating a file
never runs model-written code (the agent also reads email and documents,
whose text could try to steer it). Tools are created per request: they close
over the request's trace ID and, for the Google ones, the user's token.
"""

import copy
import logging
import os
from collections.abc import Callable
from typing import Any, Literal

from strands import tool

from .common import Palette, new_key_base, output_path, pdf_page_count, publish_preview_pages, render_pdf_pages, resolve_source, upload_file
from .docx_builder import Block, build_document
from .google_files import convert_to_pdf_via_drive, download_from_drive, upload_to_drive
from .pptx_builder import Slide, build_presentation
from .xlsx_builder import Sheet, build_workbook

logger = logging.getLogger(__name__)

ColorScheme = Literal["navy", "teal", "forest", "burgundy", "charcoal", "orange"]

DOCUMENT_TOOLS_PROMPT = """## Creating files (PowerPoint, Excel, Word, PDF)
- Create a file only when the user explicitly asks for one: they name a format (Word, Excel, PowerPoint, PDF, slides, a deck, a spreadsheet, Google Docs/Sheets/Slides) or ask to export, download or save something as a file. Otherwise write the answer in the chat as well-structured Markdown (headings, lists, tables); the user can export it afterwards. When asked to export "the previous answer" or "this", turn the content of your previous answer into the requested file without researching again.
- create_powerpoint, create_excel_workbook and create_word_document turn structured content into finished, consistently designed files; you never write code for them. Each result has a `url` (and a `pdf_url` with pdf=true) that is already uploaded: give each to the user as a Markdown link whose text is the file name, e.g. [週次報告.pptx](url), and keep the URL exactly as returned. Do not call upload_file_to_s3_and_retrieve_s3_url for these files.
- The chat shows a preview of the pages under your answer by itself, so do not paste images of the file or describe its layout; summarize what it contains in a few lines.
- First gather the facts the file needs, then plan its structure. Never invent numbers, names or facts to fill a slide or a table; leave out what you do not know or mark it as to be confirmed.
- Decks: one message per slide. The title names the topic and `lead` states the takeaway as one sentence. Keep bullets short (about 6 per slide at most, one line each) and prefer chart, table, stats, steps and two_column layouts to walls of text. Start with a title slide, add an agenda when there are 6 or more slides and end with a summary or closing slide. Put details the presenter should say in `notes`.
- Workbooks: one table per sheet with a format for every column. Use formulas (with the {row}/{first}/{last} placeholders) wherever a value is derived from others, so the user can change the inputs. Formulas are not checked here, so double-check the references.
- Documents: lead with the conclusion or summary, structure with headings, use tables for comparisons and callouts for what must not be missed.
- Write the content in the user's language.
- When a result lists warnings, fix the input and create the file again before answering.
- PDF: pass pdf=true when the user wants a PDF. PDFs and previews are made through the user's Google Drive, so they need a linked Google account; if a result says so, tell the user.
"""

GOOGLE_FILE_TOOLS_PROMPT = """- save_to_google_drive saves a created file to the user's Google Drive, converting pptx/xlsx/docx to Google Slides/Sheets/Docs by default. This is the way to create a new, well-designed Google Slides deck, spreadsheet or document: create the Office file first, then save it. Give the user the returned link.
- convert_to_pdf turns a file created earlier in the conversation (pass its URL) into a PDF. export_google_file downloads a Google Docs/Sheets/Slides file (or an Office file in Drive) as PDF or as an Office file.
- preview_document shows you the pages of a file as images. Use it only when you need to check the layout yourself, e.g. after fixing warnings; the user already gets a preview.
"""


def _inline_schema(schema: dict) -> dict:
    """Resolve $defs/$ref (Pydantic) into one self-contained JSON schema"""
    defs = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                target = copy.deepcopy(defs[node["$ref"].split("/")[-1]])
                extra = {k: v for k, v in node.items() if k != "$ref"}
                return resolve({**target, **extra})
            # "title" annotations are noise; a property named "title" is a dict
            node = {k: resolve(v) for k, v in node.items() if not (k == "title" and isinstance(v, str))}
            # Optional fields: anyOf [X, null] -> X (omitting the field is the way to leave it out)
            required = set(node.get("required", []))
            for name, prop in node.get("properties", {}).items():
                variants = prop.get("anyOf") if isinstance(prop, dict) else None
                if name not in required and variants and len(variants) == 2 and {"type": "null"} in variants:
                    other = next(v for v in variants if v != {"type": "null"})
                    del prop["anyOf"]
                    prop.pop("default", None)
                    prop.update(other)
            return node
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


def _self_contained(decorated):
    spec = decorated.tool_spec
    spec["inputSchema"] = {"json": _inline_schema(copy.deepcopy(spec["inputSchema"]["json"]))}
    return decorated


def _publish(path: str, trace_id: str | None, pdf: bool, warnings: list[str], to_pdf: Callable[[str], str] | None) -> dict:
    """Upload a created file. With a converter, its PDF and preview pages are
    uploaded next to it (same key base), so the chat can show the preview."""
    key_base = new_key_base(trace_id)
    result: dict[str, Any] = {"file": path, "url": upload_file(path, trace_id, key_base)}
    if to_pdf is None:
        if pdf:
            result["pdf_error"] = "No PDF was made: PDFs are created through the user's Google Drive, and Google is not linked for this request. The original file is fine."
    else:
        try:
            pdf_path = to_pdf(path)
            pdf_url = upload_file(pdf_path, trace_id, key_base)
            result["preview_pages"] = publish_preview_pages(pdf_path, trace_id, key_base)
            if pdf:
                result["pdf_file"] = pdf_path
                result["pdf_url"] = pdf_url
        except Exception as e:
            logger.error(f"PDF conversion failed: {e}")
            if pdf:
                result["pdf_error"] = f"The PDF could not be created ({e}). The original file is fine."
    if warnings:
        result["warnings"] = warnings
    return result


def _publish_pdf(pdf_path: str, trace_id: str | None) -> dict:
    """Upload a PDF with its preview pages"""
    key_base = new_key_base(trace_id)
    url = upload_file(pdf_path, trace_id, key_base)
    try:
        publish_preview_pages(pdf_path, trace_id, key_base)
    except Exception as e:
        logger.error(f"Preview failed: {e}")
    return {"file": pdf_path, "url": url}


def build_document_tools(trace_id: str | None, to_pdf: Callable[[str], str] | None = None) -> list:
    """Tools that create Office files. to_pdf turns one into a PDF (None when
    the request cannot convert, i.e. has no Google token)."""

    @tool
    def create_powerpoint(
        filename: str,
        slides: list[Slide],
        color_scheme: ColorScheme = "navy",
        primary_color: str | None = None,
        accent_color: str | None = None,
        footer: str | None = None,
        pdf: bool = False,
    ) -> dict:
        """Create a PowerPoint deck (.pptx, 16:9) from slide content and upload it.

        Layouts and the fields each one uses (content slides also take title, lead and notes):
        - title: title, subtitle, text (date, presenter). The first slide.
        - section: title, subtitle. A numbered divider between parts.
        - agenda: items.
        - bullets: bullets and/or text.
        - two_column: left and right (each a heading plus bullets/text). Comparisons, before/after, issues/actions.
        - table: table, text (a note under it). At most about 12 rows.
        - chart: chart, optional bullets/text shown to its right.
        - stats: stats (1-6 key numbers), optional bullets/text below.
        - steps: steps (2-6, left to right). Processes, schedules, roadmaps.
        - quote: quote, attribution.
        - image: image, caption, optional bullets to its right.
        - closing: title, subtitle, text. The last slide.
        Text, charts and tables are native and editable in PowerPoint and Google Slides.

        Args:
            filename: File name, e.g. "2026年度Q3事業報告.pptx"
            slides: The slides, in order
            color_scheme: Color palette of the deck
            primary_color: Hex color replacing the palette's main color, e.g. a brand color "C8102E"
            accent_color: Hex color replacing the palette's accent color
            footer: Small text at the bottom left of content slides, e.g. "社外秘"
            pdf: The user wants a PDF too: also return a link to the PDF of the deck
        """
        palette = Palette(color_scheme, primary_color, accent_color)
        path = output_path(filename, ".pptx")
        warnings = build_presentation(path, [Slide.model_validate(s) for s in slides], palette, footer=footer)
        return _publish(path, trace_id, pdf, warnings, to_pdf)

    @tool
    def create_excel_workbook(
        filename: str,
        sheets: list[Sheet],
        color_scheme: ColorScheme = "navy",
        primary_color: str | None = None,
        pdf: bool = False,
    ) -> dict:
        """Create an Excel workbook (.xlsx) and upload it.

        Each sheet holds one table: an optional title and description, a header row, typed columns, data rows
        (values or formulas), an optional totals row, notes and native charts. Headers are frozen, filters added,
        and the page setup fits the table to the page width for printing. Excel and Google Sheets calculate the
        formulas when the file is opened.

        Args:
            filename: File name, e.g. "11月の予定一覧.xlsx"
            sheets: The sheets, in order
            color_scheme: Color palette
            primary_color: Hex color replacing the palette's main color
            pdf: The user wants a PDF too: also return a link to the PDF of the workbook
        """
        palette = Palette(color_scheme, primary_color)
        path = output_path(filename, ".xlsx")
        warnings = build_workbook(path, [Sheet.model_validate(s) for s in sheets], palette)
        return _publish(path, trace_id, pdf, warnings, to_pdf)

    @tool
    def create_word_document(
        filename: str,
        blocks: list[Block],
        title: str | None = None,
        subtitle: str | None = None,
        meta: str | None = None,
        header: str | None = None,
        landscape: bool = False,
        color_scheme: ColorScheme = "navy",
        primary_color: str | None = None,
        pdf: bool = False,
    ) -> dict:
        """Create a Word document (.docx, A4) and upload it. Reports, minutes, proposals, manuals, letters.

        The document starts with a title block (title, subtitle, meta) followed by the blocks: headings (1-3),
        paragraphs, bullets and numbered lists (3 levels, every list restarts at 1), tables with a header row,
        callouts (info/warning/note boxes), quotes, images and page breaks. Page numbers are added to the footer.

        Args:
            filename: File name, e.g. "定例会議_議事録_2026-11-08.docx"
            blocks: The body, in order
            title: Document title
            subtitle: Line under the title
            meta: Right-aligned line under the title, e.g. "2026年11月8日 営業企画部"
            header: Small text at the top right of every page, e.g. "社外秘"
            landscape: A4 landscape instead of portrait
            color_scheme: Color palette
            primary_color: Hex color replacing the palette's main color
            pdf: The user wants a PDF too: also return a link to the PDF of the document
        """
        palette = Palette(color_scheme, primary_color)
        path = output_path(filename, ".docx")
        warnings = build_document(path, [Block.model_validate(b) for b in blocks], palette, title, subtitle, meta, header, landscape)
        return _publish(path, trace_id, pdf, warnings, to_pdf)

    return [_self_contained(t) for t in (create_powerpoint, create_excel_workbook, create_word_document)]


def build_google_file_tools(trace_id: str | None, google_access_token: str) -> list:
    """Tools that use the user's Drive: saving and exporting files, PDFs and previews"""

    @tool
    def save_to_google_drive(source: str, convert: bool = True, name: str | None = None, folder: str | None = None) -> dict:
        """Save a file created in this conversation to the user's Google Drive. By default pptx, xlsx and docx
        files become Google Slides, Sheets and Docs (formatting, formulas and charts are kept); PDFs and images
        are stored as they are. The new file is private to the user until they share it.

        Args:
            source: The URL of a file created in this conversation, or a path under /tmp/ws
            convert: Convert Office files to the Google format (false keeps the .pptx/.xlsx/.docx file)
            name: Name in Drive (default: the file name)
            folder: Optional Drive folder ID or link to save into (default: My Drive)
        """
        path = resolve_source(source)
        result = upload_to_drive(google_access_token, path, convert, name, folder)
        return {"name": result.get("name"), "format": result.get("format"), "link": result.get("webViewLink"), "id": result.get("id")}

    @tool
    def export_google_file(file: str, format: Literal["pdf", "pptx", "docx", "xlsx", "csv"] = "pdf") -> dict:
        """Download a file from the user's Google Drive for them: Google Slides/Docs/Sheets are exported (to PDF or
        to PowerPoint/Word/Excel/CSV), Office files are downloaded or converted to PDF. Returns a download URL.

        Args:
            file: Drive file ID or link (docs.google.com/... or drive.google.com/...)
            format: Format of the download
        """
        path = download_from_drive(google_access_token, file, format)
        if path.lower().endswith(".pdf"):
            return _publish_pdf(path, trace_id)
        return {"file": path, "url": upload_file(path, trace_id)}

    @tool
    def convert_to_pdf(source: str) -> dict:
        """Convert a PowerPoint, Excel, Word or CSV file to PDF and upload the PDF. The conversion goes through
        the user's Google Drive (a temporary Google file that is deleted right away).

        Args:
            source: The URL of a file created earlier in this conversation, or a path under /tmp/ws
        """
        return _publish_pdf(convert_to_pdf_via_drive(google_access_token, resolve_source(source)), trace_id)

    @tool
    def preview_document(source: str, pages: list[int] | None = None) -> dict:
        """Look at pages of a PowerPoint, Excel, Word or PDF file as images, to check the layout (text that
        overflows or is cut off, overlaps, crowded or empty areas) before handing it over. Rendered the way
        Google Slides/Docs/Sheets show the file.

        Args:
            source: The URL of a file created in this conversation, or a path under /tmp/ws
            pages: 1-based page (slide) numbers to look at; default the first 6. At most 8.
        """
        path = resolve_source(source)
        pdf_path = path if path.lower().endswith(".pdf") else convert_to_pdf_via_drive(google_access_token, path)
        count = pdf_page_count(pdf_path) or 1
        wanted = [p for p in (pages or range(1, min(count, 6) + 1)) if 1 <= p <= count][:8] or [1]
        images = render_pdf_pages(pdf_path, wanted)
        content: list[dict] = [{"text": f"Pages {wanted} of {count} of {os.path.basename(path)}:"}]
        content += [{"image": {"format": "png", "source": {"bytes": image}}} for image in images]
        return {"status": "success", "content": content}

    return [_self_contained(t) for t in (save_to_google_drive, export_google_file, convert_to_pdf, preview_document)]
