import type { StaticDataRouteOption } from "@tanstack/react-router";
import { createContext, useContext, type ComponentType, type SVGProps } from "react";

/**
 * A chat side app: a child route of the chat layout that opens in the panel beside the
 * conversation, at `/chat/<app>`. It declares itself on its own route:
 *
 * ```tsx
 * export const Route = createFileRoute("/_app/chat/notes")({
 *   staticData: { chatApp: { label: "Notes", icon: NotePencilIcon, tools: ["take_note"] } },
 *   component: NotesPanel,
 * });
 * ```
 *
 * The Apps menu, the panel header and its actions are built from those routes, so chat names no
 * side app. The side app reads the conversation with `useChatContext()`.
 */
export type ChatSideApp = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Tool names whose live tool events open this side app. */
  tools?: readonly string[];
  /** The standalone page "Open fullscreen" goes to. Without one the action is not offered. */
  fullscreen?: string;
};

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    chatApp?: ChatSideApp;
  }
}

/** A side app with the route that serves it. */
export type ChatSideAppRoute = ChatSideApp & { id: string; path: string };

type SideAppRoute = {
  id: string;
  fullPath: string;
  parentRoute?: { id: string } | undefined;
  options: { staticData?: StaticDataRouteOption };
};

/**
 * The side apps of the chat layout route `layoutId`: its direct children that declare
 * `staticData.chatApp`, sorted by route id so the order never depends on the filesystem.
 */
export function sideAppsOf(routes: readonly SideAppRoute[], layoutId: string): ChatSideAppRoute[] {
  return routes
    .filter((route) => route.parentRoute?.id === layoutId)
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .flatMap((route) => {
      const app = route.options.staticData?.chatApp;
      return app ? [{ ...app, id: route.id, path: route.fullPath }] : [];
    });
}

/** The installed side apps, provided by the chat layout; empty when chat renders on its own. */
export const ChatSideAppsContext = createContext<readonly ChatSideAppRoute[]>([]);

export function useChatSideApps(): readonly ChatSideAppRoute[] {
  return useContext(ChatSideAppsContext);
}
