"""Deterministic synthetic fixture for the Agentic Search retrieval path.

Builds one fixed scenario, a long document whose answer sits outside the first retrieved
chunk, and seeds it into a :class:`LocalSearchStore`. Embeddings are a deterministic hash,
so it runs offline. The metrics over this fixture live in :mod:`...retrieval_quality`.
"""

import hashlib
from dataclasses import dataclass

from mistralai.search.toolkit.document import (
    Document,
    DocumentFileMetadata,
    PagedDocumentChunk,
    PagedDocumentChunkMetadata,
    compute_id,
    compute_page_locator,
)

from mistralai_capabilities.search.local_store import LocalSearchStore
from mistralai_capabilities.search.schemas import CollectionConfig

_EMBED_DIM = 32


def hash_embedding(text: str, dim: int = _EMBED_DIM) -> list[float]:
    vector = [0.0] * dim
    for token in text.lower().split():
        # A feature hash: the digest picks a bucket for a token in a deterministic stand-in
        # embedding. Not a security digest, and flagged as such so Bandit does not read it as
        # one and so it keeps working under a FIPS build, where unflagged MD5 raises.
        index = int(hashlib.md5(token.encode(), usedforsecurity=False).hexdigest(), 16) % dim
        vector[index] += 1.0
    return vector


@dataclass
class SyntheticCase:
    collection: str
    business_id: str
    search_query: str
    grep_pattern: str
    gold_substring: str


def build_synthetic_case(collection: str = "agentic_search_eval") -> tuple[Document, SyntheticCase]:
    business_id = "long-regulatory-doc"
    source_id = business_id
    parent_ref = compute_id(source_id)
    passages = [
        (1, "annual capital overview summary introduction and scope of this filing"),
        (2, "background narrative about the institution history and unrelated commentary"),
        (3, "methodology discussion covering assumptions and general disclosures"),
        (12, "pillar two summary table the net capital requirement was forty two billion dollars"),
        (47, "appendix references footnotes and supplementary schedules of the report"),
    ]
    chunks: list[PagedDocumentChunk] = []
    offset = 0
    parts: list[str] = []
    for page, text in passages:
        start = offset
        end = offset + len(text)
        chunks.append(
            PagedDocumentChunk(
                source_id=source_id,
                locator=compute_page_locator(page, start, end),
                start_offset=start,
                end_offset=end,
                parent_ref=parent_ref,
                content=text,
                metadata=PagedDocumentChunkMetadata(page_number=page),
                embedding=hash_embedding(text),
            )
        )
        parts.append(text)
        offset = end + 1
    document = Document(
        source_id=source_id,
        content="\n".join(parts),
        chunks=chunks,
        metadata=DocumentFileMetadata(
            filename="regulatory.pdf",
            filepath="regulatory.pdf",
            title="Regulatory Filing",
            page_count="47",
        ),
    )
    case = SyntheticCase(
        collection=collection,
        business_id=business_id,
        search_query="annual capital overview summary",
        grep_pattern="net capital requirement",
        gold_substring="forty two billion",
    )
    return document, case


async def seed_case(store: LocalSearchStore, document: Document, case: SyntheticCase) -> None:
    await store.ensure_collection(CollectionConfig(collection_name=case.collection, embed_dim=_EMBED_DIM))
    await store.index_document(document)
