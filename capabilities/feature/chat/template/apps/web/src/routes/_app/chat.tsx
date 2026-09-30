import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";

import { ChatApiProvider } from "../../features/chat/chat-api";
import { ChatLayout } from "../../features/chat/components/chat-layout";
import { chatApiExtensions } from "../../features/chat/extensions";
import { ChatSessions } from "../../features/chat/components/chat-sessions";
import { useRefreshSessions } from "../../features/chat/use-sessions";

/** A v4-style UUID `?session=` — a malformed one stays a broken link, not a silent new chat. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The search boundary for `/chat` and every side app under it (`/chat/<app>`). The field is optional
 * and decoded here; a malformed value throws so the router rejects it rather than dropping it, and
 * unknown keys are stripped. An absent field stays absent on the parsed result — never set to
 * `undefined`. The session lives in the search, not the path, so switching side apps never remounts
 * the conversation.
 */
const chatSearchSchema = z.object({
  session: z.string().regex(UUID_PATTERN).optional(),
});

type ChatSearch = z.infer<typeof chatSearchSchema>;

export const Route = createFileRoute("/_app/chat")({
  // Chat is the app's landing page (`/` and the brand mark lead here), reached otherwise from the
  // "New chat" primary action rather than an ordinary nav row, and it contributes the rail of past
  // conversations. It is a layout: side apps are its child routes, the index child is none open.
  // Its landing claim outranks a feature page's plain `true`: with chat installed, chat is the door.
  staticData: {
    landing: 10,
    nav: { label: "New chat", icon: PlusIcon, primary: true },
    sidebar: ChatSessions,
  },
  validateSearch: (search): ChatSearch => chatSearchSchema.parse(search),
  component: ChatRoute,
});

/**
 * The chat layout route. The session id lives in the URL. `useChat` runs controlled off `?session=` and
 * hands its minted id back here on the first turn, which this writes into the URL with `replace`,
 * because a thread naming itself is not a back-button step.
 *
 * That first turn is also the only moment the rail can learn the conversation exists, so it is
 * refreshed here too. The id arriving is the session-created event.
 */
function ChatRoute() {
  const { session } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const refreshSessions = useRefreshSessions();

  const handleSessionIdChange = useCallback(
    (sessionId: string | null) => {
      if (sessionId) refreshSessions();
      // Stays where it is, history state included: a side app open (or opening) when the first
      // turn names the thread stays open, still credited to the tool call that opened it. The
      // latest location, not the committed one, so a navigation still in flight is not undone.
      void navigate({
        to: router.latestLocation.pathname,
        state: true,
        search: (previous) => {
          const next = { ...previous };
          if (sessionId) next.session = sessionId;
          else delete next.session;
          return next;
        },
        replace: true,
      });
    },
    [navigate, refreshSessions, router],
  );

  // Dictation and read-aloud come from whichever chat extensions are installed (speech ships one).
  return (
    <ChatApiProvider extensions={chatApiExtensions}>
      <ChatLayout
        route={Route}
        sessionId={session ?? null}
        onSessionIdChange={handleSessionIdChange}
      />
    </ChatApiProvider>
  );
}
