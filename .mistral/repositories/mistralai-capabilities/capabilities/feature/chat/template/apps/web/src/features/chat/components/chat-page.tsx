import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@mistralai/ui/resizable";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChatContext, type ChatContextValue } from "../chat-context";
import { useChat, type ChatMessage, type ChatToolEvent, type UseChatOptions } from "../use-chat";
import { ChatComposer } from "./chat-composer";
import { ChatThread } from "./chat-thread";
import { ChatProvider } from "../chat-provider";
import { useMotion } from "../chat-motion";

/**
 * Impersonal on purpose, not a placeholder for a literal.
 *
 * The browser does not know the caller. The gateway injects `x-user-id` and `x-user-email` for the
 * API only, and no route reads them back. Personalising this needs an endpoint that returns the
 * caller, not a hard-coded name here.
 */
const EMPTY_STATE_HEADING = "What can I help with?";

/** Slack in pixels before the reader counts as having left the bottom. Absorbs sub-pixel rounding. */
const FOLLOW_THRESHOLD_PX = 48;

type ChatPageProps = UseChatOptions & {
  /**
   * The open side app, already framed, shown in a resizable split beside the conversation. The
   * chat layout route passes its `<Outlet />` here; absent, the conversation fills the page.
   */
  sideApp?: ReactNode;
  /** The live tool event that opened `sideApp`, shared with it through `useChatContext()`. */
  openedBy?: ChatToolEvent;
  /**
   * Called once for each tool event that arrives during a turn sent from this page. Events a session
   * loads with are history, not calls the agent is making now, and are never reported.
   */
  onLiveToolEvent?: (event: ChatToolEvent) => void;
};

/**
 * Wraps the whole chat subtree in `ChatProvider` so `useChat` (via `useAgentChat`) can reach the
 * Vibe Agents transport from context. Self-contained rather than provided by the route, so the
 * page renders bare in its tests exactly as it did before the migration.
 */
export function ChatPage(props: ChatPageProps) {
  return (
    <ChatProvider>
      <ChatPageContent {...props} />
    </ChatProvider>
  );
}

function ChatPageContent({ sideApp, openedBy, onLiveToolEvent, ...chatOptions }: ChatPageProps) {
  const { motion, AnimatePresence } = useMotion();
  // The id the SDK mints for a new chat on its first turn: that session change is this
  // conversation naming itself, not the user opening another one.
  const mintedSession = useRef<string | null>(null);
  const { onSessionIdChange } = chatOptions;
  const trackMintedSession = useCallback(
    (id: string | null) => {
      mintedSession.current = id;
      onSessionIdChange?.(id);
    },
    [onSessionIdChange],
  );
  const chat = useChat({ ...chatOptions, onSessionIdChange: trackMintedSession });
  const { messages, toolEvents, isResponding, stop, sessionId } = chat;
  const send = useLiveToolEvents(
    { toolEvents, sessionId, isResponding, mintedSession },
    chat.send,
    onLiveToolEvent,
  );
  const conversation = useMemo<ChatContextValue>(
    () => ({ messages, toolEvents, sessionId, isResponding, openedBy }),
    [messages, toolEvents, sessionId, isResponding, openedBy],
  );
  const hasConversation = messages.length > 0;
  const { scrollRef, threadEndRef, showScrollButton, scrollToBottom, handleScroll } = useAutoScroll(
    messages,
    hasConversation,
    sessionId,
  );

  const chatPane = (
    <div className="bg-subtle text-default relative flex h-full w-full flex-col">
      {hasConversation ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl grow flex-col px-4 py-6">
            <ChatThread messages={messages} sessionId={sessionId} />
            <div ref={threadEndRef} />
          </div>
        </div>
      ) : (
        <WelcomeScreen />
      )}

      {/* The composer deliberately sits OUTSIDE the branch above, at one fixed position in both
          states. It is the reason this is not two sibling `<WelcomeScreen/>` / `<ActiveThread/>`
          components each owning their own: handing the same composer to a different parent
          unmounts it when the first answer lands, taking the textarea's focus and any dictation
          still recording with it. */}
      <div className="shrink-0">
        <div className="relative mx-auto w-full max-w-3xl px-4">
          {/* The centring translate stays on a plain wrapper: framer-motion writes the
              scale as an inline `transform`, which would drop a Tailwind one entirely. */}
          <div className="absolute -top-12 left-1/2 -translate-x-1/2">
            <AnimatePresence>
              {showScrollButton ? (
                <motion.button
                  type="button"
                  onClick={scrollToBottom}
                  aria-label="Scroll to latest message"
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0 }}
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                  className="border-default bg-subtle text-default hover:bg-card flex size-9 items-center justify-center rounded-full border shadow-md transition-colors"
                >
                  <ArrowDownIcon className="size-4" aria-hidden />
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>
          <ChatComposer
            onSend={send}
            onStop={stop}
            isResponding={isResponding}
            disabled={isResponding}
          />
        </div>
      </div>

      {/* The two states need opposite things below the composer, so one branch covers both: a
          disclaimer once there is a transcript, and otherwise the counterweight that balances
          the welcome block and leaves the composer centred — what `grid-rows-[1fr_auto_1fr]`
          used to buy. */}
      {hasConversation ? (
        <p className="text-muted shrink-0 px-4 py-3 text-center text-xs">
          AI models can make mistakes. Check important info.
        </p>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );

  // One tree whether or not a side app is open: the conversation keeps its place in it, so opening,
  // switching or closing a side app never remounts the thread, its scroll position or the draft.
  return (
    <ChatContext.Provider value={conversation}>
      <ResizablePanelGroup direction="horizontal" className="bg-subtle">
        <ResizablePanel id="chat" order={1} defaultSize={58} minSize={30} className="min-w-0">
          {chatPane}
        </ResizablePanel>
        {sideApp ? (
          <>
            <ResizableHandle className="w-[0.5px] cursor-col-resize bg-(--transparent-light-4)" />
            <ResizablePanel
              id="side-app"
              order={2}
              defaultSize={42}
              minSize={25}
              className="min-w-0"
            >
              {sideApp}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </ChatContext.Provider>
  );
}

/**
 * Keeps the newest content in view while a turn streams, without fighting the reader.
 *
 * A new bubble is a discrete event, so it animates. The snapshots that fill it are not:
 * `scrollIntoView` with `behavior: "smooth"` restarts its animation on every call and never
 * arrives, so growth writes `scrollTop` straight to the bottom instead.
 */
function useAutoScroll(
  messages: ChatMessage[],
  hasConversation: boolean,
  sessionId: string | null,
) {
  const threadEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Whether the reader is parked at the newest content. Following unconditionally would drag a
  // reader who scrolled up back down mid-sentence. A ref, not state: it is read by the effect
  // below and must not schedule a render on every wheel event.
  const isAtBottomRef = useRef(true);
  const messageCountRef = useRef(messages.length);

  const scrollToBottom = useCallback(() => {
    // Pressing the button is a request to resume following, not just one jump.
    isAtBottomRef.current = true;
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  // Every other transition of this button is driven by a scroll event, and switching threads
  // produces none: "New chat" empties the thread, which unmounts the scroller entirely, so a
  // reader who had scrolled up left the affordance stranded over the welcome screen pointing at
  // nothing. Opening a different conversation is the same problem one step quieter — it starts
  // at the newest message, which is where following should resume from.
  // Session changes are external navigation events; reset the scroll affordance to the new thread.
  /* oxlint-disable react/exhaustive-effect-dependencies, react/set-state-in-effect -- Session navigation resets imperative scroll state. */
  useEffect(() => {
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, [sessionId, hasConversation]);
  /* oxlint-enable react/exhaustive-effect-dependencies, react/set-state-in-effect */

  useEffect(() => {
    const isNewMessage = messages.length !== messageCountRef.current;
    messageCountRef.current = messages.length;

    if (!hasConversation || !isAtBottomRef.current) return;

    if (isNewMessage) {
      threadEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, hasConversation]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    setShowScrollButton(distanceFromBottom > FOLLOW_THRESHOLD_PX);
  }, []);

  return { scrollRef, threadEndRef, showScrollButton, scrollToBottom, handleScroll };
}

function WelcomeScreen() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-5 px-4 pb-5">
      <div aria-hidden>
        <WelcomeLogo />
      </div>
      <h1 className="text-default font-sans text-3xl font-medium">{EMPTY_STATE_HEADING}</h1>
    </div>
  );
}

const WELCOME_LOGO_HEIGHT = 34;
const WELCOME_LOGO_ASPECT_RATIO = 1.4;

function WelcomeLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={WELCOME_LOGO_HEIGHT * WELCOME_LOGO_ASPECT_RATIO}
      height={WELCOME_LOGO_HEIGHT}
      viewBox="0 0 212.121 151.515"
      shapeRendering="crispEdges"
    >
      <rect x="30.303" y="0" width="30.303" height="30.303" fill="#FFAF01" />
      <rect x="151.515" y="0" width="30.303" height="30.303" fill="#FFAF01" />
      <rect x="30.303" y="30.303" width="60.606" height="30.303" fill="#FF8204" />
      <rect x="121.212" y="30.303" width="60.606" height="30.303" fill="#FF8204" />
      <rect x="30.303" y="60.606" width="151.515" height="30.303" fill="#FA500F" />
      <rect x="30.303" y="90.909" width="30.303" height="30.303" fill="#E51300" />
      <rect x="90.909" y="90.909" width="30.303" height="30.303" fill="#E51300" />
      <rect x="151.515" y="90.909" width="30.303" height="30.303" fill="#E51300" />
      <rect x="0" y="121.212" width="90.909" height="30.303" fill="#C4001D" />
      <rect x="121.212" y="121.212" width="90.909" height="30.303" fill="#C4001D" />
    </svg>
  );
}

/**
 * Reports each tool event the first time it is seen, if it arrives during a turn sent from this
 * page. Everything else is history, marked seen without being reported: the events a session loads
 * with (a reload, even mid-turn, or picking a past chat from the rail) are not calls the agent is
 * making for this user now, and replaying a conversation must never open side apps on its own. A
 * turn stops being live when it ends, or when another conversation is opened; a new chat receiving
 * its minted id is the same conversation. Returns `send`, wrapped to start watching.
 */
function useLiveToolEvents(
  chat: {
    toolEvents: readonly ChatToolEvent[];
    sessionId: string | null;
    isResponding: boolean;
    mintedSession: { readonly current: string | null };
  },
  send: (draft: string) => void,
  onLiveToolEvent: ((event: ChatToolEvent) => void) | undefined,
): (draft: string) => void {
  const { toolEvents, sessionId, isResponding, mintedSession } = chat;
  const seen = useRef(new Set<string>());
  const live = useRef(false);
  const watchedSession = useRef(sessionId);
  // The minted id already honoured: each mint excuses exactly one session change.
  const honouredMint = useRef<string | null>(null);
  const wasResponding = useRef(isResponding);

  useEffect(() => {
    if (watchedSession.current !== sessionId) {
      // The minted id is honoured once, for the transition it announced; any later change of
      // session, including back to that one, is another conversation opening.
      const mint = mintedSession.current;
      if (sessionId !== null && sessionId === mint && honouredMint.current !== mint) {
        honouredMint.current = mint;
      } else {
        live.current = false;
      }
    }
    watchedSession.current = sessionId;
    for (const event of toolEvents) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (live.current) onLiveToolEvent?.(event);
    }
    // After this frame's events: the last calls of a turn arrive with its end.
    if (wasResponding.current && !isResponding) live.current = false;
    wasResponding.current = isResponding;
  }, [toolEvents, sessionId, isResponding, mintedSession, onLiveToolEvent]);

  return useCallback(
    (draft: string) => {
      live.current = true;
      send(draft);
    },
    [send],
  );
}
