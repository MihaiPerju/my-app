---
name: capability-document-annotation-ui
description: Schema-driven document extraction — OCR, LLM extraction against a registered pydantic document type, and a human-review pause — run as workflow activities over object-storage document transport. Use when adding or changing a document type in `document_types.py`, when touching the OCR/extract activities or their model and sampling settings, when working the upload→`document_key` transport or its ownership gate, when changing the `review_result` update or `review_state` query contract, or when wiring the review UI and its PDF/image viewer.
---

# Document Annotation UI

Schema-driven extraction as a workflow: OCR a stored document, fill a registered pydantic document type with an LLM, then park for human review before persisting. Owns the document-type registry + validation, the two Mistral SDK activities, the uploader-bound object-storage transport, `DocumentExtractionWorkflow` + its review update/query, the `/document_annotation_ui` HTTP surface, and the review web slice. Defers routing/identity/execution persistence to `fastapi` (+ `fastapi-workflows-auth`/`fastapi-auth`/`auth`), the object store to `bucket`, worker discovery to `workflows`, the web host to `tanstack-start`.

## Where things live

Installed toolkit — import `mistralai_capabilities.document_annotation_ui.<mod>`:

| Module | What |
| --- | --- |
| `document_types` + `.validation` | `DOCUMENT_TYPES` registry (`example` starter) + resolve/validate/normalize against captured JSON Schema. |
| `workflow` | `DocumentExtractionWorkflow`: `run`, `review_result` update, `cancel_requested` signal, `review_state` query. |
| `activities` | `document_ocr` / `document_extract` — the only Mistral SDK call sites (`chat.parse_async`). |
| `schemas` | Loop-boundary contract, `MAX_DOCUMENT_BYTES`, `safe_media_type`. |
| `storage` | Transport on `bucket`'s `Bucket`: key minting, ownership matching, page-image keys. |
| `workflows_catalog`/`prompts`/`env_contract` | UI catalog + `CATALOG_NAMES`, `DEFAULT_EXTRACTION_PROMPT`, boot settings-presence check. |
| `api` | FastAPI-only helpers (`ExecutionRoute`, `RequireOwned`, `load_review_state`, `owned_document_key`); the one module importing FastAPI. |

Vendored (app paths):

| Path | What |
| --- | --- |
| `apps/api/src/api/routers/api/v1/document_annotation_ui/` | `document.py` (WorkflowRouter mount), `review.py`/`reviews.py`, `upload.py`, `schemas.py`, `workflows.py`. |
| `apps/worker/src/worker/workflows/document_annotation_ui.py` | Re-exports the workflow so the worker registers `document_annotation_ui_document_extraction`. |
| `packages/py/env/src/env/document_annotation_ui.py` | S3 + OCR/extract model & sampling settings, greedy-sampling cross-field validator. |
| `apps/web/src/features/document-annotation-ui/` | Review slice: upload/start, reviews list, tabbed review, `components/document-viewer/` (PDF/image/text/CSV), `api.ts`/`use-*.ts`/`contract-parity.test-d.ts`. |
| `apps/web/src/routes/_app/document-annotation-ui.tsx` | Route → `DocumentReviewPage`; `staticData.nav` is its "Apps" rail row. |
| `apps/web/public/pdf.worker.min.mjs`, `public/pdfjs/{openjpeg,qcms_bg}.wasm` | Version-pinned pdf.js worker + wasm (must match installed `pdfjs-dist`). |
| `@mistralai-capabilities/feature-document-annotation-ui` (+ `/web`) | Web lib: mirror types, API interface, `lib.ts`, react-query hooks. |

## Add a document type

A pydantic class in `document_types.py` + one `DOCUMENT_TYPES` entry — no schema JSON, no caller-supplied schema. The model goes directly to `chat.parse_async` as response format AND validates reviewed edits, so it is the single authority for both; set `extra="ignore"` to drop hallucinated keys. Publish incompatible changes under a NEW `schema_name` — never edit a live entry (`_run` snapshots `model_json_schema()` before OCR and raises `DocumentTypeChangedError` on drift). A `schemas.py` change means regenerating the client + updating the TS mirror, or `contract-parity.test-d.ts` fails.

## Gotchas

- `storage.py` uses `bucket` but the py package must NOT declare it in `pyproject.toml` (breaks `uv lock`); the edge is carried by `capability.json`.
- Ownership is enforced only at the HTTP edge (`on_create=_owns_document`, `owned_document_key`), not in the workflow; keys match the WHOLE `…/{sha256(user_id)}/{uuid4}/{leaf}` shape, never a prefix.
- Review is a dedup'd `review_result` update (first-writer-wins); the workflow validates approved edits → 422 on invalid, 409 on any other non-acceptance.
