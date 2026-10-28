import { createFileRoute } from "@tanstack/react-router";

// `/chat` with no side app open: the chat layout renders the conversation alone.
export const Route = createFileRoute("/_app/chat/")({
  component: () => null,
});
