"""Shared helpers of the document tools.

Files are written under the workspace directory, uploaded to the file bucket
and handed to the user as S3 URLs, like upload_file_to_s3_and_retrieve_s3_url
does. A file of an earlier request (the workspace is emptied after every
request) is referred to by its S3 URL and downloaded back.
"""

import io
import logging
import mimetypes
import os
import re
import unicodedata
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor

import boto3
import pypdfium2

from ..config import WORKSPACE_DIR, get_aws_credentials

logger = logging.getLogger(__name__)

# One font for every document: BIZ UDPGothic ships with Windows 10 and later
# and is a Google Font, so it survives conversion to Slides, Sheets and Docs
# (which is also how PDFs are made, see google_files.py).
FONT = "BIZ UDPGothic"

# Prefix of the keys this runtime writes to the file bucket. Only objects
# under it can be downloaded back (see resolve_source).
S3_PREFIX = "agentcore/"

MIME_TYPES = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

COLOR_SCHEMES: dict[str, tuple[str, str]] = {
    # name: (primary, accent)
    "navy": ("1F3A5F", "E8833A"),
    "teal": ("0F5E66", "E9A23B"),
    "forest": ("2E5E3E", "C9A227"),
    "burgundy": ("7A1F3D", "D9A441"),
    "charcoal": ("2F3640", "00A3A3"),
    "orange": ("C4501A", "2F4858"),
}

TEXT_COLOR = "262B33"
MUTED_COLOR = "6B7280"
LINE_COLOR = "D5DAE1"

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")


class DocumentError(ValueError):
    """A problem the model can fix by changing its input"""


class Palette:
    """Colors of a document, as 6-digit hex strings without '#'"""

    def __init__(self, scheme: str | None = None, primary: str | None = None, accent: str | None = None):
        base_primary, base_accent = COLOR_SCHEMES.get(scheme or "navy", COLOR_SCHEMES["navy"])
        self.primary = normalize_hex(primary) or base_primary
        self.accent = normalize_hex(accent) or base_accent
        self.text = TEXT_COLOR
        self.muted = MUTED_COLOR
        self.line = LINE_COLOR
        self.tint = mix(self.primary, "FFFFFF", 0.9)
        self.tint_strong = mix(self.primary, "FFFFFF", 0.75)

    def series(self, count: int) -> list[str]:
        """Colors for chart series, primary first"""
        base = [
            self.primary,
            self.accent,
            "8C96A3",
            mix(self.primary, "FFFFFF", 0.45),
            mix(self.accent, "FFFFFF", 0.45),
            mix(self.primary, "000000", 0.35),
            "B9C0CA",
            mix(self.accent, "000000", 0.3),
        ]
        return [base[i % len(base)] for i in range(count)]


def normalize_hex(value: str | None) -> str | None:
    if not value:
        return None
    match = _HEX_RE.match(value.strip())
    if not match:
        raise DocumentError(f"Invalid color {value!r}: use a 6-digit hex code such as '1F3A5F'.")
    return match.group(1).upper()


def mix(color: str, other: str, ratio: float) -> str:
    """color blended toward other by ratio (0 = color, 1 = other)"""
    a = [int(color[i : i + 2], 16) for i in (0, 2, 4)]
    b = [int(other[i : i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(x + (y - x) * ratio):02X}" for x, y in zip(a, b, strict=True))


def text_width_em(text: str) -> float:
    """Approximate width of text in ems (full-width characters are 1 em)"""
    width = 0.0
    for ch in text:
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            width += 1.0
        elif ch.isupper() or ch.isdigit():
            width += 0.62
        else:
            width += 0.52
    return width


def split_bold(text: str) -> list[tuple[str, bool]]:
    """Split text into (segment, is_bold) on **bold** markers"""
    parts = re.split(r"(\*\*[^*]+\*\*)", text)
    result = []
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            result.append((part[2:-2], True))
        else:
            result.append((part, False))
    return result


def strip_markup(text: str) -> str:
    return text.replace("**", "")


def output_path(filename: str, extension: str) -> str:
    """A free path under the workspace for filename with the given extension"""
    name = os.path.basename(filename or "").strip()
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", name)
    stem, ext = os.path.splitext(name)
    if ext.lower() != extension:
        stem = name
    stem = stem.strip(" .") or "document"
    # 255-byte file name limit, with room for a " (n)" suffix
    while len((stem + extension).encode()) > 200:
        stem = stem[:-1]
    directory = os.path.join(WORKSPACE_DIR, "documents")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, stem + extension)
    n = 2
    while os.path.exists(path):
        path = os.path.join(directory, f"{stem} ({n}){extension}")
        n += 1
    return path


def _content_disposition(filename: str, inline: bool) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "").replace("\\", "").strip()
    ext = os.path.splitext(filename)[1]
    if not ascii_name or ascii_name == ext:
        ascii_name = f"document{ext}"
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(filename)}"


def new_key_base(trace_id: str | None) -> str:
    """S3 key without extension for one created file. Its PDF and preview
    pages share it (<base>.pdf, <base>.page-01.png, ...), which is how the
    chat finds the preview of a file link (GeneratedFilePreview.tsx)."""
    return f"{S3_PREFIX}{trace_id or 'local'}/{uuid.uuid4().hex}"


def upload_file(path: str, trace_id: str | None, key_base: str | None = None, suffix: str | None = None, inline: bool | None = None) -> str:
    """Upload a workspace file to the file bucket and return its S3 URL.

    The key is ASCII-only (a Japanese file name would be mangled on its way
    through Markdown and the signed-URL API); the real name travels in
    Content-Disposition, so the download keeps it.
    """
    bucket = os.environ.get("FILE_BUCKET")
    if not bucket:
        logger.warning("FILE_BUCKET is not set; skipping the upload (local testing)")
        return f"file://{path}"
    region = get_aws_credentials().get("AWS_REGION", "us-east-1")
    filename = os.path.basename(path)
    ext = os.path.splitext(filename)[1].lower()
    key = (key_base or new_key_base(trace_id)) + (suffix or ext)
    content_type = MIME_TYPES.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    s3 = boto3.client("s3", region_name=region)
    s3.upload_file(
        path,
        bucket,
        key,
        ExtraArgs={"ContentType": content_type, "ContentDisposition": _content_disposition(filename, inline=ext in (".pdf", ".png") if inline is None else inline)},
    )
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"


# Pages of a file shown in the chat's preview
MAX_PREVIEW_PAGES = 20


def publish_preview_pages(pdf_path: str, trace_id: str | None, key_base: str) -> int:
    """Render the first pages of a PDF and upload them as <key_base>.page-NN.png;
    returns the number of pages uploaded"""
    count = min(pdf_page_count(pdf_path), MAX_PREVIEW_PAGES)
    if not count:
        return 0
    images = render_pdf_pages(pdf_path, list(range(1, count + 1)), long_side_px=1400)
    stem = os.path.splitext(os.path.basename(pdf_path))[0]
    directory = os.path.join(WORKSPACE_DIR, "preview", uuid.uuid4().hex)
    os.makedirs(directory, exist_ok=True)
    paths = []
    for number, image in enumerate(images, start=1):
        path = os.path.join(directory, f"{stem} p{number}.png")
        with open(path, "wb") as f:
            f.write(image)
        paths.append(path)
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda item: upload_file(item[1], trace_id, key_base, f".page-{item[0]:02d}.png"), enumerate(paths, start=1)))
    return count


def _filename_from_disposition(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"filename\*=UTF-8''([^;]+)", value)
    if match:
        return urllib.parse.unquote(match.group(1))
    match = re.search(r'filename="([^"]+)"', value)
    return match.group(1) if match else None


def resolve_source(source: str) -> str:
    """Local path of a file given as a workspace path or as an S3 URL this
    runtime returned earlier (downloaded into the workspace)"""
    source = (source or "").strip()
    if not source:
        raise DocumentError("No file given.")

    if source.startswith("https://") or source.startswith("s3://"):
        bucket = os.environ.get("FILE_BUCKET")
        parsed = urllib.parse.urlparse(source)
        if parsed.scheme == "s3":
            url_bucket, key = parsed.netloc, parsed.path.lstrip("/")
        else:
            host = parsed.netloc
            url_bucket = host.split(".s3", 1)[0] if ".s3" in host and host.endswith(".amazonaws.com") else None
            key = parsed.path.lstrip("/")
        key = urllib.parse.unquote(key)
        if not bucket or url_bucket != bucket or not key.startswith(S3_PREFIX) or ".." in key:
            raise DocumentError("Only files created by this assistant (their S3 URLs) or files under /tmp/ws can be used.")
        region = get_aws_credentials().get("AWS_REGION", "us-east-1")
        s3 = boto3.client("s3", region_name=region)
        head = s3.head_object(Bucket=bucket, Key=key)
        filename = _filename_from_disposition(head.get("ContentDisposition")) or os.path.basename(key)
        stem, ext = os.path.splitext(filename)
        path = output_path(stem, ext.lower() or os.path.splitext(key)[1])
        s3.download_file(bucket, key, path)
        return path

    path = os.path.realpath(source)
    workspace = os.path.realpath(WORKSPACE_DIR)
    if not path.startswith(workspace + os.sep):
        raise DocumentError(f"{source} is not under {WORKSPACE_DIR}. Pass a file created in this conversation (its S3 URL) or a file under {WORKSPACE_DIR}.")
    if not os.path.isfile(path):
        raise DocumentError(f"{source} does not exist. Files under {WORKSPACE_DIR} only last for one request; pass the S3 URL of the file instead.")
    return path


# --- PDF pages --------------------------------------------------------------


def pdf_page_count(pdf_path: str) -> int:
    pdf = pypdfium2.PdfDocument(pdf_path)
    try:
        return len(pdf)
    finally:
        pdf.close()


def render_pdf_pages(pdf_path: str, pages: list[int], long_side_px: int = 1000) -> list[bytes]:
    """PNG images of the given 1-based pages of a PDF"""
    pdf = pypdfium2.PdfDocument(pdf_path)
    images = []
    try:
        for number in pages:
            page = pdf[number - 1]
            try:
                width, height = page.get_size()  # points
                bitmap = page.render(scale=long_side_px / max(width, height))
                buffer = io.BytesIO()
                bitmap.to_pil().save(buffer, format="PNG", optimize=True)
                images.append(buffer.getvalue())
            finally:
                page.close()
    finally:
        pdf.close()
    return images
