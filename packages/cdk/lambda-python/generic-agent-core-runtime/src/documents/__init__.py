"""The office-documents built-in tool server.

Listed in mcp.json like an MCP server ({"builtin": "office-documents"}) so
agents can select it, but implemented in this process (see toolset.py).
"""

from .google_files import convert_to_pdf_via_drive
from .toolset import DOCUMENT_TOOLS_PROMPT, GOOGLE_FILE_TOOLS_PROMPT, build_document_tools, build_google_file_tools

OFFICE_DOCUMENTS = "office-documents"

__all__ = ["DOCUMENT_TOOLS_PROMPT", "GOOGLE_FILE_TOOLS_PROMPT", "OFFICE_DOCUMENTS", "build_document_tools", "build_google_file_tools", "convert_to_pdf_via_drive"]
