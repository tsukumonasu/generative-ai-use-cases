"""Moving files between the workspace and the user's Google Drive.

Called with the invoking user's own Google access token (the same token the
Google Workspace MCP servers get). File bytes never pass through the model:
the Drive MCP server's create_file would need them as a base64 argument.
Never log or return the token.

PDFs are made here too: the runtime image has no LibreOffice (it would push
the image toward AgentCore's 2 GB limit), so an Office file is uploaded to
the user's Drive as a Google file, exported as PDF and deleted again.
"""

import logging
import os
import re

import httpx

from .common import MIME_TYPES, DocumentError, output_path

logger = logging.getLogger(__name__)

DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"

# Office format -> the Google format it is converted to on upload
GOOGLE_TYPES = {
    ".pptx": "application/vnd.google-apps.presentation",
    ".docx": "application/vnd.google-apps.document",
    ".xlsx": "application/vnd.google-apps.spreadsheet",
    ".csv": "application/vnd.google-apps.spreadsheet",
}
GOOGLE_TYPE_NAMES = {
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.google-apps.document": "Google Docs",
    "application/vnd.google-apps.spreadsheet": "Google Sheets",
}
# Google format -> formats it can be exported to
EXPORTS = {
    "application/vnd.google-apps.presentation": {"pdf", "pptx"},
    "application/vnd.google-apps.document": {"pdf", "docx"},
    "application/vnd.google-apps.spreadsheet": {"pdf", "xlsx", "csv"},
    "application/vnd.google-apps.drawing": {"pdf", "png"},
}

_TIMEOUT = httpx.Timeout(30, read=180)


def _check(response: httpx.Response, action: str) -> None:
    if response.status_code < 400:
        return
    try:
        error = response.json().get("error", {})
        message = error.get("message", "")
        reasons = {e.get("reason") for e in error.get("errors", [])} | {d.get("reason") for d in error.get("details", []) if isinstance(d, dict)}
    except Exception:
        message, reasons = response.text[:300], set()
    logger.warning(f"Google Drive {action} failed: {response.status_code} {message[:300]}")
    if response.status_code == 401:
        raise DocumentError("The user's Google sign-in has expired. Ask them to send the message again; if it keeps failing, re-link Google from the settings page.")
    if response.status_code == 403 and ({"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"} & reasons or "scope" in message.lower()):
        raise DocumentError("The Google link does not allow this yet. Ask the user to re-link Google from the settings page (the link needs to be renewed after permissions were added).")
    if response.status_code == 404:
        raise DocumentError("The file or folder was not found, or the user cannot access it.")
    raise DocumentError(f"Google Drive {action} failed ({response.status_code}): {message}")


def upload_to_drive(token: str, path: str, convert: bool = True, name: str | None = None, folder_id: str | None = None) -> dict:
    """Upload a workspace file to the user's Drive, converting Office files to
    the Google format by default. Returns id, name, mimeType and webViewLink."""
    filename = os.path.basename(path)
    stem, ext = os.path.splitext(filename)
    ext = ext.lower()
    media_type = MIME_TYPES.get(ext)
    if not media_type:
        raise DocumentError(f"{filename}: only pptx, docx, xlsx, csv, pdf, png and jpeg files can be saved to Google Drive.")
    metadata: dict = {}
    target = GOOGLE_TYPES.get(ext) if convert else None
    if target:
        metadata["mimeType"] = target
        metadata["name"] = name or stem
    else:
        metadata["name"] = name or filename
    if folder_id:
        metadata["parents"] = [_file_id(folder_id)]
    size = os.path.getsize(path)
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=_TIMEOUT) as client:
        # Resumable upload: works for any size (multipart stops at 5 MB)
        response = client.post(
            DRIVE_UPLOAD,
            params={"uploadType": "resumable", "supportsAllDrives": "true", "fields": "id,name,mimeType,webViewLink"},
            headers={**headers, "X-Upload-Content-Type": media_type, "X-Upload-Content-Length": str(size)},
            json=metadata,
        )
        _check(response, "upload")
        session = response.headers.get("Location")
        if not session:
            raise DocumentError("Google Drive did not start the upload.")
        with open(path, "rb") as f:
            response = client.put(session, headers={**headers, "Content-Type": media_type}, content=f.read())
        _check(response, "upload")
    result = response.json()
    result["format"] = GOOGLE_TYPE_NAMES.get(result.get("mimeType", ""), result.get("mimeType"))
    return result


def _file_id(value: str) -> str:
    value = value.strip()
    match = re.search(r"/(?:d|folders)/([A-Za-z0-9_-]{10,})", value) or re.search(r"[?&]id=([A-Za-z0-9_-]{10,})", value)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{10,}", value):
        return value
    raise DocumentError(f"{value!r} is not a Google Drive file ID or link.")


def download_from_drive(token: str, file: str, export_format: str) -> str:
    """Save a Drive file in the workspace: Google files are exported to
    export_format, other files downloaded as they are (Office files can still
    become PDFs, converted here)"""
    file_id = _file_id(file)
    export_format = export_format.lower().lstrip(".")
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
        response = client.get(f"{DRIVE_FILES}/{file_id}", params={"fields": "id,name,mimeType,size", "supportsAllDrives": "true"}, headers=headers)
        _check(response, "lookup")
        meta = response.json()
        mime_type = meta.get("mimeType", "")
        name = meta.get("name") or file_id

        if mime_type in EXPORTS:
            if export_format not in EXPORTS[mime_type]:
                raise DocumentError(f"A {GOOGLE_TYPE_NAMES.get(mime_type, mime_type)} file can be exported as {sorted(EXPORTS[mime_type])}, not {export_format}.")
            target = MIME_TYPES.get(f".{export_format}")
            response = client.get(f"{DRIVE_FILES}/{file_id}/export", params={"mimeType": target}, headers=headers)
            _check(response, "export")
            path = output_path(name, f".{export_format}")
            with open(path, "wb") as f:
                f.write(response.content)
            return path

        if mime_type.startswith("application/vnd.google-apps."):
            raise DocumentError(f"This kind of Google file ({mime_type}) cannot be exported.")
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        convert_pdf = export_format == "pdf" and ext in GOOGLE_TYPES
        if ext != f".{export_format}" and not convert_pdf:
            hint = " or converted to pdf" if ext in GOOGLE_TYPES else ""
            raise DocumentError(f"{name} is not a Google file; it can only be downloaded as it is ({ext or 'no extension'}){hint}.")
        if int(meta.get("size") or 0) > 50 * 1024 * 1024:
            raise DocumentError(f"{name} is larger than 50 MB.")
        response = client.get(f"{DRIVE_FILES}/{file_id}", params={"alt": "media", "supportsAllDrives": "true"}, headers=headers)
        _check(response, "download")
    path = output_path(stem, ext)
    with open(path, "wb") as f:
        f.write(response.content)
    return convert_to_pdf_via_drive(token, path) if convert_pdf else path


def convert_to_pdf_via_drive(token: str, path: str) -> str:
    """PDF of a pptx/docx/xlsx/csv file: uploaded to the user's Drive as a
    Google file, exported as PDF, then deleted (it exists for a few seconds)"""
    stem, ext = os.path.splitext(os.path.basename(path))
    if ext.lower() not in GOOGLE_TYPES:
        raise DocumentError("Only PowerPoint, Excel, Word and CSV files can be converted to PDF.")
    uploaded = upload_to_drive(token, path, convert=True, name=f"{stem} (PDF conversion, deleted automatically)")
    file_id = uploaded["id"]
    headers = {"Authorization": f"Bearer {token}"}
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
            response = client.get(f"{DRIVE_FILES}/{file_id}/export", params={"mimeType": "application/pdf"}, headers=headers)
            _check(response, "PDF export")
    finally:
        _delete(token, file_id)
    target = output_path(stem, ".pdf")
    with open(target, "wb") as f:
        f.write(response.content)
    return target


def _delete(token: str, file_id: str) -> None:
    """Remove a temporary file this runtime created (drive.file allows it)"""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            response = client.delete(f"{DRIVE_FILES}/{file_id}", params={"supportsAllDrives": "true"}, headers={"Authorization": f"Bearer {token}"})
        if response.status_code >= 400:
            logger.error(f"Could not delete the temporary Drive file {file_id}: {response.status_code}")
    except Exception as e:
        logger.error(f"Could not delete the temporary Drive file {file_id}: {e}")
