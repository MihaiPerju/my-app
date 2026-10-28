import { WorkflowUIProvider } from "@mistral/workflow-ui/react";
import type { ComponentProps, ReactNode } from "react";

// The chat feature uses the vendored SDK's `useAgentChat` for `/api/v1/chat/*`. The generated
// client is used only for the sidebar's `chatListSessions`. `baseUrl` is relative because the app
// is served same-origin behind the gateway. The browser holds no control-plane credential.
export const CHAT_APPLICATION = "mistralai-capabilities";
const CHAT_BASE_URL = "/api/v1/chat";

// `useAgentChat` requires an `agent`, but the server binds the agent from its own settings and
// removes the client value. This placeholder satisfies the SDK signature. The real value is
// `VIBE_AGENTS_AGENT_NAME`, server-side.
export const CHAT_AGENT = "server-assigned";

// `WorkflowUIProvider` requires an `adapter`, but this app uses only `useAgentChat`, which never
// reaches the adapter. A throwing stub avoids adding the workflows transport to the bundle. The
// type comes from the provider's own props.
type WorkflowAdapterProp = ComponentProps<typeof WorkflowUIProvider>["adapter"];

const UNUSED_ADAPTER_MESSAGE =
  "The workflow adapter is unused: chat runs entirely through useAgentChat.";

const unusedAdapter: WorkflowAdapterProp = {
  start: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
  subscribe: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
  submitInput: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
  signal: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
  cancel: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
  query: () => {
    throw new Error(UNUSED_ADAPTER_MESSAGE);
  },
};

/** Provides the Vibe Agents transport to the chat subtree. `useAgentChat` reads it from context. */
export function ChatProvider({ children }: { children: ReactNode }) {
  return (
    <WorkflowUIProvider
      adapter={unusedAdapter}
      agents={{ baseUrl: CHAT_BASE_URL, application: CHAT_APPLICATION }}
    >
      {children}
    </WorkflowUIProvider>
  );
}
