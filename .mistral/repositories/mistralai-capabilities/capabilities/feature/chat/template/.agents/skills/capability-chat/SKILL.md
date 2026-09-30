---
name: capability-chat
description: The `/chat` conversational surface and the `mistralai_capabilities.chat.vibe` forwarder that turns the Mistral agents API (`/v2/agents`) into browser-facing chat sessions, plus the `@mistralai-capabilities/feature-chat` package and web slice. Use when changing the session mount or feedback route, editing the vibe forwarder (router, schemas, sessions, client, identity), the `VIBE_AGENTS_*` settings or the `register-agent` step, or working the chat web slice — transport seam, sessions rail, or markdown.
---

# Chat

The `/chat` conversational surface plus the **vibe** forwarder behind it: chat's HTTP routes are hand-written (not derived from a workflow class) because a session runs on the Mistral **agents API** at `/v2/agents`, not this app's worker. It reaches that API the way every capability reaches Mistral — on the caller's credential where the deployment installs one, on `MISTRAL_API_KEY` where it does not. Owns the published `mistralai_capabilities.chat.vibe` toolkit, app-local `env/vibe_agents.py`, the `chat/` routes, the `@mistralai-capabilities/feature-chat` package, the web slice, and the `register-agent` init step. Defers to: `mistralai_capabilities.fastapi.sse` + `mistralai_capabilities.fastapi_auth.identity` (from `fastapi`/`auth`); the `agents` session workflow; vendored `@mistral/workflow-ui` (the `useAgentChat` transport) + `@mistral/markdown`. Owns **no** session state (D29).

## Where things live

| Path | What |
| --- | --- |
| `mistralai_capabilities.chat.vibe.{router,schemas,sessions,client,identity}` | Forwarder toolkit: `VibeAgentsRouter` (seven session routes); wire models + `SessionCommand` allowlist + `app_context` title/owner helpers; `VibeSessions` Protocol + `ControlPlaneSessions` (the `Sessions` dep is the test seam); httpx `client` (service/caller endpoints, `register_agent`, transient-5xx retry, `ensure_reachable`, `decode`); `ChatCaller` identity. |
| `apps/api/src/api/routers/api/v1/chat/{route,feedback,__init__}.py` | `VibeAgentsRouter(agent=…, name="chat")` index mount (no `prefix`); `chat_submit_feedback` module (204, OTLP `gen_ai.evaluation.result`, stores nowhere); package inherits `v1` `require_user`. |
| `packages/py/env/src/env/vibe_agents.py` | Three `VIBE_AGENTS_*` settings only: `agent_name` (404 discriminator; blank = `DEPLOYMENT_NAME`), `application_name`, `timeout_seconds`. Credentials come from `env.mistral` + `utils.mistral`, not here. |
| `packages/py/cli/src/cli/commands/agents.py` · `tasks/chat/project.json` | `register-agent` one-shot (`bunx nx run chat:register-agent`) binds `VIBE_AGENTS_AGENT_NAME` to `_SESSION_WORKFLOW_NAME="agents"`; skips when `MISTRAL_API_KEY` is unset. |
| `apps/web/src/features/chat/` · `routes/_app/chat.tsx` (layout route; `staticData`: landing, "New chat", sessions rail) · `routes/_app/chat/index.tsx` (no side app) | Slice: `chat-provider` (`WorkflowUIProvider`); seams `chat-transport`/`chat-motion`/`chat-markdown-parser` composed by `chat-runtime`; `use-chat`, `api`, `side-apps` (`staticData.chatApp`, discovery), `chat-context` (`useChatContext()`), `components/` (layout/page/thread/composer/markdown/sessions/split-panel/plus-menu). |
| `@mistralai-capabilities/feature-chat[/web]` | Published: `types` wire shapes, `ChatApi` contract, `blobToBase64`/`fileNameFor` (`lib`); `/web` = five injectable hooks (sessions, feedback, voice-input, read-aloud, copy). |

## Add a side app

A side app is a panel that opens beside the conversation (the 42% of a resizable split) at
`/chat/<app>`, keeping `?session`. It is one route file; chat names no side app and needs no edit.

```tsx
// apps/web/src/routes/_app/chat/notes.tsx — a child of the chat layout route
import { NotePencilIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";

import { useChatContext } from "../../../features/chat/chat-context";

export const Route = createFileRoute("/_app/chat/notes")({
  staticData: {
    chatApp: {
      label: "Notes", // the Apps menu entry and the panel header
      icon: NotePencilIcon,
      tools: ["take_note"], // optional: the agent's calls to these open the panel
      fullscreen: "/notes", // optional: "Open fullscreen" goes to this page
    },
  },
  component: NotesPanel,
});

function NotesPanel() {
  const { messages, toolEvents, sessionId, isResponding, openedBy } = useChatContext();
  return <p>{openedBy ? `Opened by ${openedBy.name}` : `${messages.length} messages so far`}</p>;
}
```

- **Discovery.** The side apps are the chat layout's direct child routes declaring
  `staticData.chatApp`. They build the composer's Apps menu (absent when there is none), the panel
  header, "Close" (back to `/chat`, session kept) and, with `fullscreen`, "Open fullscreen" — which
  points at a page you add yourself (e.g. `routes/_app/notes.tsx`, outside the chat layout).
- **Conversation.** `useChatContext()` gives `messages`, `toolEvents` (every tool call of the
  session, in call order), `sessionId`, `isResponding` and `openedBy`. The conversation stays
  mounted while side apps open, switch and close.
- **Opened by the agent.** With `tools`, the panel opens itself the way an MCP app does: a tool
  event of a listed name arriving during a turn sent from this page navigates to it (replacing the
  entry when it is already open) and becomes `openedBy`. A namespaced call (`client.take_note`)
  matches the bare name. Events replayed from a session's history, a reload, or another session
  never open anything, and a panel opened by hand (or revisited after a reload) has no `openedBy`.
  Add the tool itself on the worker (`apps/worker/src/worker/agents/tools/`, see `capability-agents`).
- **Ownership.** The route file belongs to the capability that ships the panel, which then depends
  on `chat`. Test it like chat's own `components/chat-layout.test.tsx`: a hand-built route tree with a
  chat layout and your side app, driven through `test/agent-chat-mock`.

## Extend

- **Side app** — a panel beside the conversation; see **Add a side app** above.
- **Chat extension** — add `features/chat/extensions/<cap>.ts` default-exporting a `ChatExtension` (`transcribeAudio?`, `synthesizeSpeech?`). The chat route merges every such module
  (`features/chat/extensions.ts`, Vite `import.meta.glob`) into `ChatApiProvider`; the composer's mic
  and an answer's read-aloud action show only when their member is present. Tests never glob: they
  wrap in `ChatApiProvider extensions={...}`. `speech`'s extension (`features/chat/extensions/speech.ts`) is the worked example.
- **Mount / feedback route** — edit `chat/route.py` (file-is-URL, no `prefix`) or `feedback.py`. `VibeAgentsRouter` emits a **fixed seven** routes (forwards on the `agent` it fronts, doesn't reflect a class); feedback is a separate module because the agents API has no rating surface.
- **New command** — add a model to `vibe.schemas` `SessionCommand` (`extra="ignore"`: the model IS the allowlist, unlisted fields drop before upstream). `update_agent_configuration` is deliberately absent.
- **Credentials / registration** — no base URL or tenant block: set `MISTRAL_API_KEY` (or a caller credential upstream); `init/agents.py` binds the agent name and guards a 409 with `StaleAgentBindingError`.
- **Web hook** — put logic in `@mistralai-capabilities/feature-chat/web` (one injected API fn each); app `features/chat/use-*.ts` are thin shims binding `chatApi` (sessions, feedback) or `useChatExtensions()` (dictation, read-aloud, which may be absent). `ChatApi` members are function-typed **properties**, not methods; `contract-parity.test-d.ts` pins them to the OpenAPI types.
- **Transport / render seam** — nest a narrow context under `chat-runtime`'s `ChatRuntimeProvider`, never a combined accessor hook. The turn transport is the vendored `useAgentChat`; only two of chat's own calls reach the generated client (`api.ts`): `chatListSessions`, `chatSubmitFeedback`. The chat API itself is a seam too (`chat-api`'s `ChatApiProvider`), filled by chat extensions.

## Gotchas

- **Which agent answers `/chat`.** `VIBE_AGENTS_AGENT_NAME` left blank resolves to `DEPLOYMENT_NAME`: this deployment's own agent, bound by `cli agents` (compose `init-agents`, Helm init, or `bunx nx run chat:register-agent`) to the `agents` session workflow the worker serves, so every tool/connector/hook contributed under `worker/agents/` is reachable from chat. `nuage-session` is the platform builtin: it needs no worker but runs none of this app's tools, and `cli agents` warns and skips registration for it. The `POST /api/v1/chat/sessions` response carries `agent_session.agent_name`: check it to see which one answered. Repointing the name hides sessions opened under the old one (404 discriminator). An unregistered name fails the first turn upstream, so run registration after the worker is up.

- Ownership answers **404, never 403**: every id-route runs `_owned_session` (session+owner+agent triple) → `"Unknown session"`; the stream checks **before** the response starts. `agent=env.vibe_agents_agent_name` is the 404 discriminator (D3); the owner is the app user tagged into `app_context.owner_user_id` (one shared key otherwise lists everyone's chats); an unconfigured deployment raises **503**, not 500.
- Chat never imports another feature: side apps and extensions are discovered, so chat builds alone. Don't declare the `fastapi` edge in `capability.json` (it's carried chat→`fastapi`); the toolkit keeps FastAPI an optional `api` extra so a worker can't load a web framework.
- Markdown renderer is hand-written (`@mistralai/ui`'s shiki `onig.wasm` breaks the SSR build): `@mistral/markdown` parser + mdast→JSX, raw HTML kept inert (escaped, never `dangerouslySetInnerHTML`), every url through `sanitizeMarkdownUrl`.
