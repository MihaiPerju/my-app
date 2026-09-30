---
name: capability-speech
description: The app's Voxtral speech slice — file transcription and TTS synthesis as durable `WorkflowRouter` workflows, saved-voice list/clone and a browser realtime-session mint as plain routes, and chat's dictation and read-aloud (a chat extension). Use when changing a request/result field or its TS mirror, adding or removing a speech operation, touching the one-source / one-voice validators, changing dictation or read-aloud, minting realtime sessions, or when the route-surface or contract-parity test fails.
---

# Speech

Four Voxtral operations: transcribe/synthesize as durable workflows (`SpeechTranscribeWorkflow`/`SpeechSynthesizeWorkflow`, one-line delegates to activities), plus list/clone voices and mint a browser realtime session as **plain routes**. Owns the operations' contract and Voxtral passthroughs only; the `WorkflowRouter` factory, routing tree, identity, and execution persistence belong to `fastapi`, `fastapi-workflows-auth`, `fastapi-auth`, `workflows` (follow `capability-workflows` for the workflow/activity contract).

## Where things live

| Path | What |
| --- | --- |
| `mistralai_capabilities.speech.schemas` | Loop-boundary contract: `Transcribe`/`Synthesize`/`CreateVoice`/`RealtimeSession` request+result models, `Voice`, `TranscriptionSegment`, `SpeechFormat` (SDK enum alias); frozen field names; per-op `model` defaults; exactly-one-source + non-empty `sample_audio` `model_validator`s (else 422). |
| `mistralai_capabilities.speech.activities` | Only site `client.audio.*`/`client.realtime.*` run: `speech.transcribe`/`.synthesize`/`.voices_list` (read policy), `.voices_create` (mutation policy), plus plain `mint_realtime_session` the API calls directly. |
| `apps/worker/src/worker/workflows/speech.py` | The two workflow classes; discovery registers by `name`. |
| `apps/api/src/api/routers/api/v1/speech/{transcribe,synthesize}.py` | One `WorkflowRouter` mount each (`wait_for_result=True`); filename = base segment. |
| `…/v1/speech/voices.py` | `APIRouter` at `/speech/voices`: `GET` list + `POST` clone; failures → `503 … from exc`. |
| `…/v1/speech/realtime.py` | `APIRouter`; `POST /session` → `/speech/realtime/session`, mints an `rt_*` browser token. |
| `…/v1/speech/__init__.py` | `/speech` package (inherits `v1` `require_user`); must exist or discovery skips every route below. |
| `apps/web/src/features/chat/extensions/speech.ts` | Speech's chat extension (default-exported `ChatExtension` (`transcribeAudio?`, `synthesizeSpeech?`)): `transcribeAudio` for the composer's mic and `synthesizeSpeech` for read-aloud (voice `en_paul_neutral`, mp3 data URL). Chat merges it via `import.meta.glob`; without it chat shows neither control. Its HTTP contract is tested in `features/speech/chat-extension.test.ts`. |
| `…/features/speech/contract-parity.test-d.ts` | Type test: 9 request/result mirror pairs ⇄ generated OpenAPI types. |
| `@mistralai-capabilities/feature-speech` (+ `/web`) | Web toolkit for building a speech UI (the app ships none): `types.ts` mirrors (incl. realtime socket frames, not in OpenAPI), `SpeechApi`, `lib.ts` builders + `MIME_BY_FORMAT` + `readFileAsBase64` + voice helpers, `/web` react-query hooks. |
| tests | `apps/api/tests/test_{speech,voices}_routes.py` pin the route surface + empty-body 422s + realtime no-leak; `apps/worker/tests/test_feature_speech_workflows.py` pins names `{speech_transcribe, speech_synthesize}`. |

## Add an operation

- **Workflow op:** new class + activity + mount file under `v1/speech/`; `name=` is the operation-id stem and ownership discriminator (never shared). Adds 16 ops to the surface test; update `test_feature_speech_workflows.py` names.
- **Plain route:** one more `APIRouter` file, also named in the route-surface set.
- **Field change:** edit `schemas.py` → `bunx nx run fastapi-tanstack-start:gen-types` → update `feature-speech` `types.ts` mirror, else `contract-parity.test-d.ts` fails.
- Serves **32 paths / 35 operations**; `test_speech_routes.py::test_speech_contributes_its_route_surfaces` pins the exact set path-by-path.

## Gotchas

- Both mounts `wait_for_result=True` → create returns **200 with the result body** (detached would reach TS as `unknown`).
- Audio always crosses as base64; **PCM decodes but won't play** in `<audio>`: a UI should offer PCM as a download only.
- Realtime never proxies audio or `MISTRAL_API_KEY`: browser streams straight to `api.mistral.ai`; missing key → 503, upstream failure leaks only the exception type name.
