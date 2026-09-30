# Install — `@mistralai-capabilities/feature-document-annotation-ui`

Adds schema-driven document extraction: an OCR + LLM extraction workflow with a human-review pause,
the `/api/v1/document_annotation_ui` routes, and the `/document-annotation-ui` review page.

## Prerequisites

- Sibling capabilities: `core`, `fastapi`, `tanstack-start`, `mistral-design-system`, `bucket`,
  `workflows` and `auth`.
- S3-compatible object storage: `bucket` supplies a local one. `INGESTION_STORAGE_BACKEND` must be
  `s3` and `INGESTION_S3_BUCKET` must be set.
- `MISTRAL_API_KEY`.
- `DOCUMENT_ANNOTATION_UI_OCR_MODEL` / `DOCUMENT_ANNOTATION_UI_EXTRACT_MODEL` (defaults
  `mistral-ocr-4-0` / `zai-glm-5-2`): override if your deployment lacks those models; set
  `DOCUMENT_ANNOTATION_UI_EXTRACT_REASONING_EFFORT=none` for a non-reasoning extract model.
- Allow request bodies of at least 20 MB plus multipart overhead at the gateway in front of the app.
- `apps/web/public/pdf.worker.min.mjs` and `apps/web/public/pdfjs/*.wasm` must match the
  `pdfjs-dist` version in `packages/ts/document-annotation-ui/package.json`; when bumping it,
  re-copy them from `node_modules/pdfjs-dist/` or the PDF viewer fails at runtime.

## Install

```bash
mistral apps capability add document-annotation-ui
bun run install-all   # sync the new dependencies
bunx nx run fastapi-tanstack-start:gen-types   # regenerate the web API client; commit the diff
```

Verify with `bun run check`, then run the stack (`bunx nx run compose:dev`), upload a document on
`/document-annotation-ui`, let the run reach `pending_review`, and approve it.

## Environment reference

| Variable                                          | Generated default |
| ------------------------------------------------- | ----------------- |
| `MISTRAL_API_KEY`                                 | (empty)           |
| `INGESTION_S3_REGION`                             | (empty)           |
| `INGESTION_S3_SESSION_TOKEN`                      | (empty)           |
| `DOCUMENT_ANNOTATION_UI_OCR_MODEL`                | `mistral-ocr-4-0` |
| `DOCUMENT_ANNOTATION_UI_EXTRACT_MODEL`            | `zai-glm-5-2`     |
| `DOCUMENT_ANNOTATION_UI_EXTRACT_REASONING_EFFORT` | `xhigh`           |
| `DOCUMENT_ANNOTATION_UI_EXTRACT_TEMPERATURE`      | `0.0`             |
| `DOCUMENT_ANNOTATION_UI_EXTRACT_TOP_P`            | `1.0`             |
| `DOCUMENT_ANNOTATION_UI_EXTRACT_RANDOM_SEED`      | `42`              |
