"""``derive_title``: the display title a source gets when its extractor reports none."""

import pytest
from mistralai.search.toolkit.document import Document, DocumentFileMetadata
from mistralai_capabilities.search.store import derive_title, source_meta


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("# GDPR Article 33 — Notification\n\nBody text.", "GDPR Article 33 — Notification"),
        ("Preamble line\n\n# First heading\n## Sub\n# Second heading", "First heading"),
        ('---\ntitle: "Front-matter title"\nauthor: x\n---\n# H1 title\n', "Front-matter title"),
        ("---\nauthor: x\n---\n\n# H1 after front matter\n", "H1 after front matter"),
        ("\ufeff# Title behind a BOM\n", "Title behind a BOM"),
        ("# Closed ATX heading ##\n", "Closed ATX heading"),
        ("## Only a level-two heading\nbody", None),
        ("#hashtag is not a heading\n", None),
        ("plain text with no heading", None),
        ("", None),
    ],
)
def test_derive_title(content: str, expected: str | None) -> None:
    assert derive_title(content) == expected


def test_derive_title_ignores_headings_past_the_document_head() -> None:
    assert derive_title("x" * 5000 + "\n# Late section heading\n") is None


def test_derive_title_is_capped_at_the_column_width() -> None:
    title = derive_title("# " + "t" * 2000)
    assert title is not None
    assert len(title) == 1024


def _document(content: str, *, title: str | None = None) -> Document:
    return Document(
        source_id="notes/a.md",
        content=content,
        chunks=[],
        metadata=DocumentFileMetadata(filename="a.md", filepath="notes/a.md", title=title),
    )


def test_source_meta_prefers_the_extractor_title() -> None:
    assert source_meta(_document("# From H1", title="From extractor")).title == "From extractor"


def test_source_meta_derives_a_title_when_the_extractor_has_none() -> None:
    assert source_meta(_document("# From H1\nbody")).title == "From H1"
