import type { ChatToolEvent } from "@mistralai-capabilities/feature-chat";
import {
  Outlet,
  useChildMatches,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { ChatSideAppsContext, sideAppsOf } from "../side-apps";
import type { UseChatOptions } from "../use-chat";
import { ChatPage } from "./chat-page";
import { ChatSplitPanel } from "./chat-split-panel";

declare module "@tanstack/history" {
  interface HistoryState {
    /** The live tool event that opened the side app this history entry shows. */
    chatAppOpenedBy?: ChatToolEvent;
  }
}

export type ChatLayoutProps = UseChatOptions & {
  /** The chat layout route itself: its side apps are its direct children. */
  route: { id: string; fullPath: string };
};

/**
 * The chat layout route's component: the conversation, and beside it the side app whose child
 * route is active, rendered through `<Outlet />`. The side apps are the layout's direct child
 * routes that declare `staticData.chatApp`; the index child means none is open.
 *
 * A side app also opens on its own, the way an MCP app does: when the agent, during a turn sent
 * from this page, calls a tool the side app lists in `staticData.chatApp.tools`. The event rides on
 * that navigation's history entry and reaches the side app as `useChatContext().openedBy`. It is
 * honoured only for navigations this page made: a side app opened by hand has none, and so does a
 * history entry revisited after a reload (the browser keeps history state; this page does not).
 */
export function ChatLayout({ route, ...chatOptions }: ChatLayoutProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const activeId = useChildMatches({ select: (matches) => matches[0]?.routeId });
  const entryOpenedBy = useLocation({ select: (location) => location.state.chatAppOpenedBy });
  // The tool events this page itself opened a side app for. Starts empty on every load, so a
  // reloaded or server-rendered entry never claims a tool call from an earlier page.
  const [opens, setOpens] = useState<ReadonlySet<string>>(() => new Set());
  const openedBy = entryOpenedBy && opens.has(entryOpenedBy.id) ? entryOpenedBy : undefined;

  const apps = useMemo(
    () => sideAppsOf(Object.values(router.routesById), route.id),
    [router, route.id],
  );
  const active = apps.find((app) => app.id === activeId);

  const openFromTool = useCallback(
    (event: ChatToolEvent) => {
      const app = apps.find((candidate) => candidate.tools?.some((tool) => callsTool(event, tool)));
      if (!app) return;
      setOpens((previous) => new Set(previous).add(event.id));
      // Replaced when that side app is already open: repeated calls must not stack Back steps.
      void navigate({
        to: app.path,
        search: true,
        state: { chatAppOpenedBy: event },
        replace: app.id === activeId,
      });
    },
    [apps, navigate, activeId],
  );

  // Both keep the search, which carries the session: closing returns to the same conversation.
  const close = useCallback(() => {
    void navigate({ to: route.fullPath, search: true });
  }, [navigate, route.fullPath]);
  const fullscreen = active?.fullscreen;
  const openFullscreen = useCallback(() => {
    if (fullscreen) void navigate({ to: fullscreen });
  }, [navigate, fullscreen]);

  return (
    <ChatSideAppsContext.Provider value={apps}>
      <ChatPage
        {...chatOptions}
        onLiveToolEvent={openFromTool}
        openedBy={active ? openedBy : undefined}
        sideApp={
          active ? (
            <ChatSplitPanel
              app={active}
              onClose={close}
              onOpenFullscreen={fullscreen ? openFullscreen : undefined}
            >
              <Outlet />
            </ChatSplitPanel>
          ) : undefined
        }
      />
    </ChatSideAppsContext.Provider>
  );
}

/**
 * Whether `event` is a call to `tool`. The session's events may name a tool with the namespace of
 * the connector that serves it (`client.take_note`), so a bare name matches on the suffix.
 */
function callsTool(event: ChatToolEvent, tool: string): boolean {
  return event.name === tool || event.name.endsWith(`.${tool}`);
}
