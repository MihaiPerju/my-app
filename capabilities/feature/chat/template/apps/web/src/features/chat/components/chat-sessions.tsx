import { Link, useRouterState } from "@tanstack/react-router";
import { PlusIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { z } from "zod";

import { useSessions } from "../use-sessions";

const UNTITLED = "Untitled chat";

/**
 * le-chat's sticky group label, inlined. `@mistralai/ui/sidebar` does not export the sticky variant,
 * and importing that subpath drags the whole sidebar module (and a CJS-only `lodash.debounce`) into
 * the browser graph, so the classes are hand-ported. No `before:` slab, because a "New chat" row
 * sits above this label and a masking slab would cover it.
 */
function StickyGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="bg-sidebar text-hint sticky top-0 z-40 flex h-8 w-full items-center gap-1 rounded-none px-2 text-xs">
      {children}
    </div>
  );
}

// le-chat's `MenuMainButton`, non-emphasized branch, minus its `mx-3`: this shell's scroll
// container already insets the rail.
const ROW_CLASS =
  "text-default ring-default group/button flex h-8 w-full shrink-0 items-center rounded-md px-2 text-sm font-[450] outline-hidden transition-[background-color,color,margin,opacity] duration-200 ease-in-out hover:bg-state-soft active:bg-state-soft focus-visible:ring-2 data-[active=true]:bg-state-soft data-[active=true]:font-medium [&>svg]:size-4 [&>svg]:shrink-0";

const ICON_BUTTON_CLASS =
  "text-muted hover:bg-state-soft-hover hover:text-default ring-default flex size-6 shrink-0 items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-2 [&>svg]:size-3.5";

const SECTION_CLASS = "flex w-full min-w-0 flex-col gap-0.5";
const LIST_CLASS = "m-0 flex w-full min-w-0 list-none flex-col gap-0.5 p-0";

function RowTitle({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-5.5 w-full min-w-0 truncate text-sm leading-5.5 font-[450]">
      {children}
    </div>
  );
}

const sessionParamSchema = z.string();

/**
 * Reads the `session` search param without asserting a route: the sidebar renders on every page,
 * and only `/chat` declares that param. The value is untyped at this boundary, so it is decoded
 * rather than probed.
 */
function useActiveSessionId(): string | undefined {
  return useRouterState({
    select: (state) => {
      const value = Object.getOwnPropertyDescriptor(state.location.search, "session")?.value;
      const parsed = sessionParamSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  });
}

const SKELETON_WIDTHS = ["75%", "60%", "45%", "80%", "55%", "70%"];

function SessionsSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-0.5">
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={width} className="flex h-8 items-center px-2">
          <div
            className="bg-state-soft h-3.5 animate-pulse rounded"
            style={{ width, animationDelay: `${index * 50}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

function SessionRow({
  title,
  sessionId,
  isActive,
}: {
  title: string;
  sessionId: string;
  isActive: boolean;
}) {
  return (
    <li className="relative">
      <Link
        to="/chat"
        search={{ session: sessionId }}
        data-active={isActive}
        aria-current={isActive ? "page" : undefined}
        title={title}
        className={`${ROW_CLASS} pe-2`}
      >
        <RowTitle>{title}</RowTitle>
      </Link>
    </li>
  );
}

export function ChatSessions() {
  const activeSessionId = useActiveSessionId();
  const sessions = useSessions();

  // Newest activity first. Restated here so a reordered response cannot scramble the rail.
  const rows = (sessions.data ?? []).toSorted((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className={SECTION_CLASS}>
      <StickyGroupLabel>
        <span className="text-subtle flex-1">Chats</span>
        <Link to="/chat" search={{}} aria-label="Start a new chat" className={ICON_BUTTON_CLASS}>
          <PlusIcon aria-hidden />
        </Link>
      </StickyGroupLabel>

      {sessions.isPending ? <SessionsSkeleton /> : null}

      {sessions.isError ? (
        <p className="text-muted px-2 py-1 text-xs">Could not load your chats.</p>
      ) : null}

      {sessions.isSuccess && rows.length === 0 ? (
        <p className="text-muted px-2 py-1 text-xs">No chats yet.</p>
      ) : null}

      <ul className={LIST_CLASS}>
        {rows.map((session) => (
          <SessionRow
            key={session.session_id}
            title={session.title ?? UNTITLED}
            sessionId={session.session_id}
            isActive={session.session_id === activeSessionId}
          />
        ))}
      </ul>
    </div>
  );
}
