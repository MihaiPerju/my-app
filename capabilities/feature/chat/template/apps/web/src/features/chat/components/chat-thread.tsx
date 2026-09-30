import type { MessageRating } from "@mistralai-capabilities/feature-chat";
import { CustomColorLogo } from "@mistralai/ui/branding";
import {
  MessageThread,
  MessageThreadAssistantMessage,
  MessageThreadUserMessage,
} from "@mistralai/ui/chat-thread";
import { Loader } from "@mistralai/ui/loader";
import {
  CircleNotchIcon,
  CopyIcon,
  PlayCircleIcon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  type Icon as PhosphorIcon,
  type IconWeight,
} from "@phosphor-icons/react";
import { memo } from "react";
import type { ReactNode } from "react";

import { MarkdownSurface } from "./chat-markdown";
import type { ChatMessage } from "../use-chat";
import { useCopyToClipboard } from "../use-copy-to-clipboard";
import { useFeedback } from "../use-feedback";
import { useReadAloud, type ReadAloudStatus } from "../use-read-aloud";
import { useMotion } from "../chat-motion";

/**
 * le-chat's message entrance variants, verbatim.
 *
 * Only a prompt submitted while a turn generates starts anywhere but `static`. Answers mount in
 * place and stream in, so an entrance transform would run under text that is still arriving.
 */
const MESSAGE_VARIANTS = {
  initialUser: { opacity: 0, y: 10, x: 10 },
  initialAssistant: { opacity: 0, y: 10, x: -10 },
  static: { opacity: 1, y: 0, x: 0 },
};

const MESSAGE_TRANSITION = { duration: 0.2, ease: "easeInOut" } as const;

type ChatThreadProps = {
  messages: ChatMessage[];
  /** The active session votes are scoped to; `null`/absent until the SDK mints one — thumbs off. */
  sessionId?: string | null;
};

export function ChatThread({ messages, sessionId = null }: ChatThreadProps) {
  // Which answer is speaking, and which is rated, are properties of the thread being looked at.
  // Both hooks' functions are referentially stable, so threading them through the memo below does
  // not break the boundary; `canRate` flips once when the session id first appears.
  const { statusOf, toggle, isAvailable: canReadAloud } = useReadAloud();
  const { ratingOf, rate } = useFeedback(sessionId);
  const canRate = sessionId !== null;

  return (
    <MessageThread className="gap-8">
      {messages.map((message, index) => (
        <ThreadMessage
          key={message.id}
          message={message}
          spaced={index > 0}
          readAloudStatus={statusOf(message.id)}
          onReadAloud={canReadAloud ? toggle : undefined}
          rating={ratingOf(message.id)}
          onRate={rate}
          canRate={canRate}
        />
      ))}
    </MessageThread>
  );
}

type ThreadMessageProps = {
  message: ChatMessage;
  spaced: boolean;
  readAloudStatus: ReadAloudStatus;
  /** Absent when no capability provides read-aloud; the action is then not offered. */
  onReadAloud?: (messageId: string, text: string) => void;
  rating: MessageRating | null;
  onRate: (messageId: string, direction: MessageRating) => void;
  canRate: boolean;
};

/**
 * The memo boundary for the thread. It makes a streamed answer cost one markdown parse per frame,
 * not one per answer on screen. Compare message fields because the SDK re-projects snapshot objects
 * on every frame; callbacks and the remaining scalar props are referentially stable.
 */
const ThreadMessage = memo(function ThreadMessage({
  message,
  spaced,
  readAloudStatus,
  onReadAloud,
  rating,
  onRate,
  canRate,
}: ThreadMessageProps) {
  if (message.role === "user") {
    return (
      <MessageRow animateIn={message.animateIn} spaced={spaced}>
        <UserMessage message={message} />
      </MessageRow>
    );
  }

  return (
    <MessageRow paintsOutsideBounds={message.pending === true}>
      <AssistantMessage
        message={message}
        readAloudStatus={readAloudStatus}
        onReadAloud={onReadAloud}
        rating={rating}
        onRate={onRate}
        canRate={canRate}
      />
      {/* Mirrors the avatar column on the far side, so the answer reads as centred in the
          768px column instead of sitting 40px right of it. */}
      <div aria-hidden className="w-7 shrink-0" />
    </MessageRow>
  );
}, sameThreadMessage);

function sameThreadMessage(previous: ThreadMessageProps, next: ThreadMessageProps): boolean {
  return (
    previous.message.id === next.message.id &&
    previous.message.role === next.message.role &&
    previous.message.content === next.message.content &&
    previous.message.pending === next.message.pending &&
    previous.message.error === next.message.error &&
    previous.message.animateIn === next.message.animateIn &&
    previous.spaced === next.spaced &&
    previous.readAloudStatus === next.readAloudStatus &&
    previous.onReadAloud === next.onReadAloud &&
    previous.rating === next.rating &&
    previous.onRate === next.onRate &&
    previous.canRate === next.canRate
  );
}

type MessageRowProps = {
  /** Only ever true for a prompt submitted mid-turn; see `MESSAGE_VARIANTS`. */
  animateIn?: boolean;
  /** A question asked after the first is set off from the answer above it; an answer never is. */
  spaced?: boolean;
  /** Set when the row draws beyond its own box; see `ROW_CONTAINED_CLASS` for why that matters. */
  paintsOutsideBounds?: boolean;
  children: ReactNode;
};

const ROW_BASE_CLASS = "flex w-full justify-center";

/**
 * `content-visibility: auto` lets the browser skip layout and paint for off-screen rows; without it
 * every markdown tree in a long thread is laid out on open. `contain-intrinsic-size: auto <n>px`
 * remembers each row's measured height. It is withheld from a row that paints outside itself,
 * because `content-visibility` would clip the pending answer's spinner to the row's box.
 */
const ROW_CONTAINED_CLASS = `${ROW_BASE_CLASS} [content-visibility:auto] [contain-intrinsic-size:auto_120px]`;

function MessageRow({
  animateIn = false,
  spaced = false,
  paintsOutsideBounds = false,
  children,
}: MessageRowProps) {
  const { motion } = useMotion();
  const row = paintsOutsideBounds ? ROW_BASE_CLASS : ROW_CONTAINED_CLASS;

  return (
    <div className={spaced ? `${row} mt-2 md:mt-4` : row}>
      <div className="w-full max-w-(--breakpoint-md) min-w-0">
        <motion.div
          variants={MESSAGE_VARIANTS}
          initial={animateIn ? "initialUser" : "static"}
          animate="static"
          transition={MESSAGE_TRANSITION}
          className="flex w-full gap-3"
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}

/**
 * Revealed on hover, and on keyboard focus.
 *
 * `pointer-events-none`, not opacity alone, because an invisible button that swallows clicks sits
 * under the bubble above. `focus-within` keeps the tray reachable without a pointer, and `min-h-8`
 * reserves the row so the transcript does not shift on hover.
 */
const USER_TRAY_CLASS = [
  "ms-auto flex min-h-8 w-fit items-center justify-end gap-3",
  "pointer-events-none opacity-0 transition-opacity duration-500 ease-in-out",
  "group-hover/question:pointer-events-auto group-hover/question:opacity-100",
  "group-focus-within/question:pointer-events-auto group-focus-within/question:opacity-100",
].join(" ");

function UserMessage({ message }: { message: ChatMessage }) {
  const copy = useCopyToClipboard(message.content);

  return (
    <MessageThreadUserMessage
      className="group/question min-w-0 flex-1"
      bubbleClassName="ms-auto items-stretch justify-between gap-1"
      footerClassName="w-full"
      footer={
        <div className={USER_TRAY_CLASS}>
          <div className="text-muted flex items-center gap-0.5">
            <ActionButton icon={CopyIcon} label="Copy message" onClick={copy} />
          </div>
        </div>
      }
    >
      {message.content}
    </MessageThreadUserMessage>
  );
}

type AssistantMessageProps = {
  message: ChatMessage;
  readAloudStatus: ReadAloudStatus;
  /** Absent when no capability provides read-aloud; the action is then not offered. */
  onReadAloud?: (messageId: string, text: string) => void;
  rating: MessageRating | null;
  onRate: (messageId: string, direction: MessageRating) => void;
  canRate: boolean;
};

/**
 * le-chat's own answer avatar, not the one `MessageThreadAssistantMessage` draws for `isLoading`.
 * That built-in draws a low-contrast ring against an undefined token and waits 450ms. So the prop
 * is left off, and a 48px orange `Loader` around the 28px mark is drawn here on CSS `animate-spin`.
 */
function AssistantAvatar({ isPending }: { isPending: boolean }) {
  const { motion } = useMotion();
  return (
    <>
      <motion.div
        animate={{ borderRadius: isPending ? "50%" : "25%" }}
        transition={{ duration: 0.3, ease: "easeInOut", delay: isPending ? 0 : 0.15 }}
        className="bg-state-brand text-white-default flex size-full items-center justify-center overflow-hidden"
      >
        <CustomColorLogo className="size-4" color="text-white-default" />
      </motion.div>
      {isPending ? (
        <Loader
          size="2xl"
          variant="warning"
          className="absolute top-1/2 left-1/2 size-12 -translate-x-1/2 -translate-y-1/2"
        />
      ) : null}
    </>
  );
}

function AssistantMessage({
  message,
  readAloudStatus,
  onReadAloud,
  rating,
  onRate,
  canRate,
}: AssistantMessageProps) {
  // The avatar rounds off only while the first chunk is outstanding. Once text is arriving the
  // answer speaks for itself, and a still-morphing avatar reads as a second, stuck spinner.
  const awaitingFirstChunk = message.pending === true && message.content.length === 0;

  return (
    <MessageThreadAssistantMessage
      className="min-w-0 flex-1"
      avatar={<AssistantAvatar isPending={awaitingFirstChunk} />}
      avatarClassName="overflow-visible"
      contentClassName="gap-0"
      footerClassName="mt-3 mb-2 w-full justify-between"
      footer={
        message.pending ? undefined : (
          <AssistantActions
            id={message.id}
            content={message.content}
            readAloudStatus={readAloudStatus}
            onReadAloud={onReadAloud}
            rating={rating}
            onRate={onRate}
            canRate={canRate}
            // The error bubble carries no answer to rate; it keeps Copy and Read aloud only.
            ratable={message.error !== true}
          />
        )
      }
    >
      <MarkdownSurface className={message.error ? "text-basic-red-strong" : "text-default"}>
        {message.content}
      </MarkdownSurface>
    </MessageThreadAssistantMessage>
  );
}

type AssistantActionsProps = {
  id: string;
  content: string;
  readAloudStatus: ReadAloudStatus;
  /** Absent when no capability provides read-aloud; the action is then not offered. */
  onReadAloud?: (messageId: string, text: string) => void;
  rating: MessageRating | null;
  onRate: (messageId: string, direction: MessageRating) => void;
  canRate: boolean;
  ratable: boolean;
};

function AssistantActions({
  id,
  content,
  readAloudStatus,
  onReadAloud,
  rating,
  onRate,
  canRate,
  ratable,
}: AssistantActionsProps) {
  const handleCopy = useCopyToClipboard(content);

  return (
    <div className="text-muted flex items-center gap-0.5">
      {ratable ? (
        <>
          <ThumbButton direction="up" rating={rating} canRate={canRate} onRate={onRate} id={id} />
          <ThumbButton direction="down" rating={rating} canRate={canRate} onRate={onRate} id={id} />
        </>
      ) : null}
      <ActionButton icon={CopyIcon} label="Copy" onClick={handleCopy} />
      {onReadAloud ? (
        <ReadAloudButton status={readAloudStatus} onClick={() => onReadAloud(id, content)} />
      ) : null}
    </div>
  );
}

const THUMBS = {
  up: { icon: ThumbsUpIcon, label: "Good response" },
  down: { icon: ThumbsDownIcon, label: "Bad response" },
} as const;

function ThumbButton({
  direction,
  rating,
  canRate,
  onRate,
  id,
}: {
  direction: MessageRating;
  rating: MessageRating | null;
  canRate: boolean;
  onRate: (messageId: string, direction: MessageRating) => void;
  id: string;
}) {
  const selected = rating === direction;
  const { icon, label } = THUMBS[direction];

  return (
    <ActionButton
      icon={icon}
      label={label}
      onClick={() => onRate(id, direction)}
      disabled={!canRate}
      pressed={selected}
      className={selected ? SELECTED_CLASS : undefined}
      // Phosphor draws the regular weight as a filled outline, so a CSS fill cannot solidify it:
      // the `fill` weight is the selected look.
      iconWeight={selected ? "fill" : undefined}
    />
  );
}

const SELECTED_CLASS = "text-default";

/**
 * Reads its whole appearance off one enum, which is what `ReadAloudStatus` already is. The labels
 * name the ACTION a click performs, not the state the button is in, because they are the
 * accessible names.
 */
function ReadAloudButton({ status, onClick }: { status: ReadAloudStatus; onClick: () => void }) {
  const synthesizing = status === "loading";

  return (
    <ActionButton
      icon={
        status === "loading" ? CircleNotchIcon : status === "playing" ? StopIcon : PlayCircleIcon
      }
      label={
        status === "loading"
          ? "Preparing read aloud"
          : status === "playing"
            ? "Stop reading aloud"
            : "Read aloud"
      }
      onClick={onClick}
      // Stoppable the moment it plays, but not while synthesizing: the click would land on a
      // request whose audio element does not exist yet.
      disabled={synthesizing}
      className={status === "playing" ? SELECTED_CLASS : undefined}
      iconClassName={synthesizing ? "animate-spin" : undefined}
    />
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  pressed,
  className,
  iconClassName,
  iconWeight,
}: {
  icon: PhosphorIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  // Only the thumbs pass this. Left undefined the attribute is omitted, which is what the one-shot
  // buttons need: `aria-pressed="false"` on Copy would announce it as a toggle.
  pressed?: boolean;
  className?: string;
  iconClassName?: string;
  iconWeight?: IconWeight;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={[
        "hover:bg-state-ghost-hover hover:text-default flex size-8 items-center justify-center rounded-md transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon
        className={iconClassName ? `size-4 ${iconClassName}` : "size-4"}
        weight={iconWeight}
        aria-hidden
      />
    </button>
  );
}
