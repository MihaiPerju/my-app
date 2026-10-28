"use client";

import { TypographySpan, typographyVariants } from "@mistralai/ui/typography";
import { cn, createSlots } from "@mistralai/ui/utils";
import { AnimatePresence, motion } from "framer-motion";
import { IconChevronRight } from "nucleo-sharp";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useId, useMemo } from "react";

import { DURATION_FAST, EASE_OUT_CIRC } from "../../lib/eases";
import { useControllableState } from "../../lib/use-controllable-state";
import { AgentStatusIcon } from "../agent-status-icon/agent-status-icon";
import { DisclosurePanel } from "../disclosure/disclosure-panel";
import type {
  AgentWorkDetailsProps,
  AgentWorkIconProps,
  AgentWorkItemProps,
  AgentWorkProviderProps,
  AgentWorkStatus,
  AgentWorkSubtitleProps,
  AgentWorkSummaryProps,
  AgentWorkTimelineProps,
  AgentWorkTitleProps,
  AgentWorkTrailingProps,
  AgentWorkTriggerProps,
} from "./types";

export type {
  AgentWorkDetailsPresence,
  AgentWorkDetailsProps,
  AgentWorkIconProps,
  AgentWorkItemProps,
  AgentWorkProviderProps,
  AgentWorkStatus,
  AgentWorkSubtitleProps,
  AgentWorkSummaryProps,
  AgentWorkTimelineProps,
  AgentWorkTitleProps,
  AgentWorkTrailingProps,
  AgentWorkTriggerProps,
} from "./types";

interface AgentWorkTimelineContextValue {
  /** 0 outside any timeline; 1 for a top-level timeline. */
  depth: number;
}

const ROOT_TIMELINE_CONTEXT: AgentWorkTimelineContextValue = { depth: 0 };
const AgentWorkTimelineContext =
  createContext<AgentWorkTimelineContextValue>(ROOT_TIMELINE_CONTEXT);

const AgentWorkContext = createContext<AgentWorkStatus | null>(null);

function useAgentWork(slot: string): AgentWorkStatus {
  const context = useContext(AgentWorkContext);
  if (context === null) {
    throw new Error(`${slot} must be rendered inside an AgentWorkProvider or AgentWorkItem.`);
  }
  return context;
}

interface AgentWorkItemContextValue {
  contentId: string;
  isOpen: boolean;
  /** Whether this item draws a rail, which is also what indents its details. */
  isShowRail: boolean;
  setIsOpen: (isOpen: boolean) => void;
  triggerId: string;
}

const AgentWorkItemContext = createContext<AgentWorkItemContextValue | null>(null);

function useAgentWorkItem(slot: string): AgentWorkItemContextValue {
  const context = useContext(AgentWorkItemContext);
  if (context === null) {
    throw new Error(`${slot} must be rendered inside an AgentWorkItem.`);
  }
  return context;
}

/** Shares a lifecycle status with AgentWork presentation parts. */
export function AgentWorkProvider({ children, status }: AgentWorkProviderProps): ReactNode {
  return <AgentWorkContext.Provider value={status}>{children}</AgentWorkContext.Provider>;
}

/**
 * Renders a connected sequence of `AgentWorkItem`s for plans, tasks, or agent activity.
 *
 * Items must be **direct children** so the rail can follow their sequence.
 * Fragments, `.map()` output, and conditional rows are fine; extra DOM wrappers
 * around items are not.
 *
 * Nesting a timeline inside an item that draws a rail indents it and
 * draws a branch from the parent rail. `hasRail={false}` keeps it flush instead.
 */
export function AgentWorkTimeline({
  children,
  className,
  ...rest
}: AgentWorkTimelineProps): ReactNode {
  const { depth } = useContext(AgentWorkTimelineContext);
  const value = useMemo<AgentWorkTimelineContextValue>(() => ({ depth: depth + 1 }), [depth]);

  return (
    <AgentWorkTimelineContext.Provider value={value}>
      <div
        {...rest}
        data-agent-work-timeline=""
        data-depth={depth + 1}
        className={cn(
          depth > 0 &&
            "relative before:border-basic-gray-alpha-10 before:pointer-events-none before:absolute before:top-0 before:h-2.5 before:left-[calc(0.5rem-var(--agent-work-indent)-0.5px)] before:right-full before:rounded-bl-md before:border-b [[data-agent-work-item]:not([data-rail])_&]:before:hidden",
          className,
        )}
      >
        {children}
      </div>
    </AgentWorkTimelineContext.Provider>
  );
}

/**
 * One unit of agent work: a plan row, execution step, tool call, or complete
 * agent activity. Compose it from a summary or trigger, optional trailing
 * content, and optional expandable details.
 *
 * Recognized slots may be authored in any order. The component keeps the
 * summary, trailing content, and details in an accessible reading order.
 *
 * Not memoized, because its props are nodes and never compare equal. Memoize
 * your own row component instead, where the props are scalars.
 */
export function AgentWorkItem({
  children,
  className,
  isOpenByDefault = false,
  onOpenChange,
  isOpen: controlledIsOpen,
  hasRail = true,
  ref,
  status,
  ...rest
}: AgentWorkItemProps): ReactNode {
  const orderedChildren = useMemo<ReactNode>(
    (): ReactNode => orderAgentWorkSlots(children),
    [children],
  );
  const { depth } = useContext(AgentWorkTimelineContext);
  const isShowRail = depth > 0 && hasRail;
  const id = useId();

  const [isOpen, setIsOpen] = useControllableState({
    defaultValue: isOpenByDefault,
    onChange: onOpenChange,
    value: controlledIsOpen,
  });

  const value = useMemo<AgentWorkItemContextValue>(
    () => ({
      contentId: `${id}-content`,
      isOpen,
      isShowRail,
      setIsOpen,
      triggerId: `${id}-trigger`,
    }),
    [id, isOpen, isShowRail, setIsOpen],
  );

  return (
    <AgentWorkProvider status={status}>
      <AgentWorkItemContext.Provider value={value}>
        <div
          ref={ref}
          {...rest}
          data-agent-work-item=""
          data-rail={isShowRail || undefined}
          data-status={status}
          className={cn(
            // Grid, not nested flex: trailing content must sit beside the
            // trigger, not inside the button where it would be unreachable.
            "grid grid-cols-[minmax(0,1fr)_auto]",
            depth > 0 && [
              "pb-3",
              // Skip off-screen rows; the remembered size keeps the scrollbar stable.
              "[contain-intrinsic-size:auto_2rem] [content-visibility:auto]",
            ],
            isShowRail && [
              "relative [--agent-work-indent:1.5rem]",
              "after:bg-basic-gray-alpha-10 after:pointer-events-none after:absolute after:w-px after:rounded-full",
              "after:left-[7.5px] after:top-5 after:bottom-0",
              // The tail follows the last real item, not a virtualizer spacer or
              // trailing padding.
              "[&:not(:has(~[data-agent-work-item]))]:after:bottom-3",
              // Stop at the first nested timeline so its branch starts cleanly.
              "[&:not(:has(~[data-agent-work-item])):has(>[data-disclosure-panel]>[data-disclosure-content]>[data-agent-work-timeline]:first-child)]:after:max-h-2.5",
            ],
            className,
          )}
        >
          {orderedChildren}
        </div>
      </AgentWorkItemContext.Provider>
    </AgentWorkProvider>
  );
}

function summaryClassName(status: AgentWorkStatus, className?: string) {
  return typographyVariants({
    size: "sm",
    variant: status === "pending" ? "default" : "muted",
    weight: "medium",
    // Keep the icon on the first line while additional lines grow downward.
    className: cn("flex min-h-5 min-w-0 items-start gap-2", className),
  });
}

/** Status-aware, non-interactive summary row. */
export function AgentWorkSummary({
  children,
  className,
  ...rest
}: AgentWorkSummaryProps): ReactNode {
  const status = useAgentWork("AgentWorkSummary");
  return (
    <span {...rest} className={summaryClassName(status, className)}>
      {children}
    </span>
  );
}
AgentWorkSummary.displayName = "AgentWorkSummary";

/** Interactive summary row that toggles the item's `AgentWorkDetails`. */
export function AgentWorkTrigger({
  children,
  className,
  onClick,
  ...rest
}: AgentWorkTriggerProps): ReactNode {
  const status = useAgentWork("AgentWorkTrigger");
  const { contentId, isOpen, setIsOpen, triggerId } = useAgentWorkItem("AgentWorkTrigger");

  const handleClick = useCallback<NonNullable<AgentWorkTriggerProps["onClick"]>>(
    (event) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      setIsOpen(!isOpen);
    },
    [isOpen, onClick, setIsOpen],
  );

  return (
    <button
      {...rest}
      id={triggerId}
      type="button"
      aria-controls={contentId}
      aria-expanded={isOpen}
      className={summaryClassName(status, cn("group/disclosure-trigger text-left", className))}
      onClick={handleClick}
    >
      {children}
      <span aria-hidden className="flex h-5 shrink-0 items-center">
        <IconChevronRight className="text-default size-2.5 opacity-40 transition ease-out group-hover/disclosure-trigger:opacity-100 group-hover/disclosure-trigger:duration-300 group-focus-visible/disclosure-trigger:opacity-100 group-aria-expanded/disclosure-trigger:rotate-90 motion-reduce:transition-none" />
      </span>
    </button>
  );
}
AgentWorkTrigger.displayName = "AgentWorkTrigger";

/**
 * Renders the item's leading glyph. With no child it uses the status glyph; with
 * a child it uses that custom glyph. Omit the slot to render no glyph.
 */
export function AgentWorkIcon({ children, className }: AgentWorkIconProps): ReactNode {
  const status = useAgentWork("AgentWorkIcon");
  return (
    <AgentStatusIcon
      className={cn("h-5 shrink-0", className)}
      icon={children}
      size="md"
      status={status}
    />
  );
}

export function AgentWorkTitle({ children, className, ...rest }: AgentWorkTitleProps): ReactNode {
  const status = useAgentWork("AgentWorkTitle");
  return (
    <span
      {...rest}
      className={cn("min-w-0 truncate", status === "running" && "animate-shimmer-text", className)}
    >
      {children}
    </span>
  );
}

export function AgentWorkSubtitle({
  children,
  className,
  ...rest
}: AgentWorkSubtitleProps): ReactNode {
  // Lopsided shrink lets the subtitle give up its width before the title.
  return (
    <TypographySpan
      {...rest}
      data-agent-work-subtitle=""
      variant="muted"
      className={cn(
        "min-w-0 shrink-9999 truncate group-aria-expanded/disclosure-trigger:hidden",
        className,
      )}
    >
      {children}
    </TypographySpan>
  );
}

const TRANSITION_QUICK_OUT = { duration: DURATION_FAST, ease: EASE_OUT_CIRC };
const TRAILING_INITIAL = { opacity: 0, x: 6 };
const TRAILING_ANIMATE = { opacity: 1, x: 0 };
const TRAILING_EXIT = { opacity: 0, x: -6 };

function isEmptyish(value: ReactNode): boolean {
  if (value === null || value === undefined || value === false) {
    return true;
  }
  return typeof value === "string" && value === "";
}

/**
 * End-aligned summary content, such as counts or integration glyphs. Keep the
 * slot mounted and vary its children so changes can animate in and out.
 */
export function AgentWorkTrailing({
  children,
  className,
  ...rest
}: AgentWorkTrailingProps): ReactNode {
  const status = useAgentWork("AgentWorkTrailing");

  return (
    <span {...rest} className={cn("col-start-2 flex h-5 items-center", className)}>
      <AnimatePresence initial={false}>
        {isEmptyish(children) ? null : (
          // The gap from the summary lives here, not on the slot, so an empty
          // trailing occupies no width.
          <motion.span
            key="trailing"
            animate={TRAILING_ANIMATE}
            className={typographyVariants({
              size: "sm",
              variant: status === "pending" ? "default" : "muted",
              weight: "medium",
              className: "flex items-center gap-1.5 ps-2",
            })}
            exit={TRAILING_EXIT}
            initial={TRAILING_INITIAL}
            transition={TRANSITION_QUICK_OUT}
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
AgentWorkTrailing.displayName = "AgentWorkTrailing";

export function AgentWorkDetails({
  children,
  className,
  presence = "activity",
  ...rest
}: AgentWorkDetailsProps): ReactNode {
  const { contentId, isOpen, isShowRail } = useAgentWorkItem("AgentWorkDetails");

  // The indent clears the rail; opted-out items keep their details flush.
  return (
    <DisclosurePanel
      {...rest}
      contentId={contentId}
      frameClassName="col-span-2"
      isOpen={isOpen}
      presence={presence}
      className={cn("before:block before:h-2", isShowRail && "ps-(--agent-work-indent)", className)}
    >
      {children}
    </DisclosurePanel>
  );
}
AgentWorkDetails.displayName = "AgentWorkDetails";

const AGENT_WORK_SLOTS = {
  details: AgentWorkDetails,
  summary: AgentWorkSummary,
  trailing: AgentWorkTrailing,
  trigger: AgentWorkTrigger,
};

function orderAgentWorkSlots(children: ReactNode): ReactNode {
  const slots = createSlots(children, AGENT_WORK_SLOTS);

  return (
    <>
      {slots.trigger ?? slots.summary}
      {slots.trailing}
      {slots.details}
      {slots.main}
    </>
  );
}
