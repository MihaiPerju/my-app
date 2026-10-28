import { Button } from "@mistralai/ui/button";
import { CornersOutIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { ChatSideAppRoute } from "../side-apps";

export type ChatSplitPanelProps = {
  app: ChatSideAppRoute;
  onClose: () => void;
  /** Absent when the side app has no standalone page. */
  onOpenFullscreen?: () => void;
  /** The side app's route, rendered through the chat layout's `<Outlet />`. */
  children: ReactNode;
};

/** The frame around the open side app: its label and icon, "Open fullscreen" and "Close". */
export function ChatSplitPanel({ app, onClose, onOpenFullscreen, children }: ChatSplitPanelProps) {
  const Icon = app.icon;
  return (
    <div className="h-full min-h-0 p-2">
      <section
        aria-label={app.label}
        className="bg-default relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl p-4"
      >
        <header className="flex shrink-0 items-center gap-2 pb-2">
          <Icon className="size-4" aria-hidden />
          <h2 className="text-default min-w-0 grow truncate text-sm font-medium">{app.label}</h2>
          {onOpenFullscreen ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              mode="icon-only"
              icon={<CornersOutIcon className="size-4" />}
              aria-label="Open fullscreen"
              onClick={onOpenFullscreen}
            />
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            mode="icon-only"
            icon={<XIcon className="size-4" />}
            aria-label="Close panel"
            onClick={onClose}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </section>
    </div>
  );
}
