"""Tests of where the document tools read files from and how they name what
they create.

Run from the runtime directory: uv run python -m unittest discover -s tests
"""

import os
import re
import tempfile
import unittest
from unittest import mock

from src.documents import common
from src.documents.common import MAX_PREVIEW_PAGES, DocumentError, new_key_base, resolve_source

BUCKET = "genu-agentcore-files"
HOST = f"https://{BUCKET}.s3.us-east-1.amazonaws.com"


class ResolveSourceTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"FILE_BUCKET": BUCKET})
        patcher.start()
        self.addCleanup(patcher.stop)
        # Nothing here may reach S3: a rejected source fails before any call
        boto = mock.patch.object(common.boto3, "client", side_effect=AssertionError("S3 must not be called"))
        boto.start()
        self.addCleanup(boto.stop)

    def test_only_this_runtimes_files_can_be_read_back(self):
        for source in [
            "https://other-bucket.s3.us-east-1.amazonaws.com/agentcore/t/0123.docx",
            f"https://{BUCKET}.evil.example.com/agentcore/t/0123.docx",
            f"https://evil.example.com/{BUCKET}/agentcore/t/0123.docx",
            "s3://other-bucket/agentcore/t/0123.docx",
            # Another prefix of the same bucket (users' uploads, other features)
            f"{HOST}/uploads/secret.pdf",
            f"s3://{BUCKET}/uploads/secret.pdf",
            # Leaving the prefix
            f"{HOST}/agentcore/../uploads/secret.pdf",
            f"{HOST}/agentcore/%2E%2E/uploads/secret.pdf",
            f"s3://{BUCKET}/agentcore/t/../../uploads/secret.pdf",
        ]:
            with self.assertRaises(DocumentError, msg=source):
                resolve_source(source)

    def test_nothing_can_be_read_while_the_bucket_is_not_configured(self):
        with mock.patch.dict(os.environ, {"FILE_BUCKET": ""}):
            with self.assertRaises(DocumentError):
                resolve_source(f"{HOST}/agentcore/t/0123.docx")

    def test_local_files_must_be_inside_the_workspace(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as outside:
            secret = os.path.join(outside, "secret.txt")
            with open(secret, "w") as f:
                f.write("x")
            inside = os.path.join(workspace, "report.docx")
            with open(inside, "w") as f:
                f.write("x")
            os.symlink(secret, os.path.join(workspace, "link.txt"))

            with mock.patch.object(common, "WORKSPACE_DIR", workspace):
                self.assertEqual(resolve_source(inside), os.path.realpath(inside))
                for source in [secret, "/etc/passwd", os.path.join(workspace, "..", os.path.basename(outside), "secret.txt"), os.path.join(workspace, "link.txt"), ""]:
                    with self.assertRaises(DocumentError, msg=source):
                        resolve_source(source)


class KeyBaseTest(unittest.TestCase):
    """The web (utils/generatedFiles.ts) finds a created file, its PDF and its
    preview pages from this shape: agentcore/<trace>/<32 hex>.<ext>,
    <base>.pdf, <base>.page-NN.png"""

    def test_key_base_is_the_prefix_a_trace_and_32_hex_digits(self):
        self.assertRegex(new_key_base("trace-1"), r"^agentcore/trace-1/[0-9a-f]{32}$")
        self.assertRegex(new_key_base(None), r"^agentcore/local/[0-9a-f]{32}$")

    def test_preview_pages_are_numbered_with_two_digits(self):
        uploaded = []
        with (
            tempfile.TemporaryDirectory() as workspace,
            mock.patch.object(common, "WORKSPACE_DIR", workspace),
            mock.patch.object(common, "pdf_page_count", return_value=MAX_PREVIEW_PAGES + 5),
            mock.patch.object(common, "render_pdf_pages", side_effect=lambda path, pages, *a, **k: [b"png"] * len(pages)),
            mock.patch.object(common, "upload_file", side_effect=lambda path, trace, base, suffix, *a, **k: uploaded.append(suffix)),
        ):
            count = common.publish_preview_pages("/tmp/x.pdf", "trace-1", "agentcore/trace-1/" + "0" * 32)

        self.assertEqual(MAX_PREVIEW_PAGES, 20)  # same limit as the web
        self.assertEqual(count, MAX_PREVIEW_PAGES)
        self.assertEqual(sorted(uploaded), [f".page-{n:02d}.png" for n in range(1, MAX_PREVIEW_PAGES + 1)])
        self.assertTrue(all(re.fullmatch(r"\.page-\d{2}\.png", s) for s in uploaded))


if __name__ == "__main__":
    unittest.main()
