import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode, Ref } from "react";

import type { AgentStatus } from "../agent-status-icon/types";
import type { DisclosurePresence } from "../disclosure/disclosure-panel";

/** Lifecycle status shown by work icons and text emphasis. */
export type AgentWorkStatus = AgentStatus;

type DivProps = Omit<HTMLAttributes<HTMLDivElement>, "color">;
type SpanProps = Omit<HTMLAttributes<HTMLSpanElement>, "color">;

export interface AgentWorkTimelineProps extends DivProps {
  /** Work items in display order. They must be direct children. */
  children: ReactNode;
}

export interface AgentWorkProviderProps {
  /** Lifecycle status shared with the presentation parts inside. */
  status: AgentWorkStatus;
  children: ReactNode;
}

export interface AgentWorkItemProps extends DivProps {
  /** Ref for the item root, useful for virtualizer measurement and scrolling. */
  ref?: Ref<HTMLDivElement>;
  /** Lifecycle status shared with the item's presentation parts. */
  status: AgentWorkStatus;
  /**
   * Whether this item is part of the timeline's thread. `false` draws no
   * connector and leaves its details flush instead of indented past the rail —
   * for an item that groups other work rather than being a step in it. A
   * timeline nested in flush details starts its own thread at the item's own
   * indentation. Ignored outside a timeline.
   *
   * @default true
   */
  hasRail?: boolean;
  /** Initial expanded state. Ignored when `isOpen` is provided. */
  isOpenByDefault?: boolean;
  /** Controlled expanded state. */
  isOpen?: boolean;
  /** Called with the next expanded state whenever the disclosure toggles. */
  onOpenChange?: (isOpen: boolean) => void;
  /**
   * One `AgentWorkSummary` or `AgentWorkTrigger`, plus optional trailing content
   * and expandable details. Slots may be authored in any order.
   */
  children: ReactNode;
}

/** Non-interactive summary row for a work item. */
export interface AgentWorkSummaryProps extends SpanProps {
  children: ReactNode;
}

/** Interactive summary row that toggles the item's details. */
export interface AgentWorkTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "color" | "type"
> {
  children: ReactNode;
}

export interface AgentWorkIconProps {
  /**
   * Replaces the status glyph. Omit for the default glyph; omit the whole
   * `AgentWorkIcon` slot for no glyph at all.
   */
  children?: ReactElement;
  className?: string;
}

export interface AgentWorkTitleProps extends SpanProps {
  children: ReactNode;
}

/** Secondary text shown beside the title and hidden while details are expanded. */
export interface AgentWorkSubtitleProps extends SpanProps {
  children: ReactNode;
}

/**
 * End-aligned summary content, such as counts or integration glyphs. Keep the
 * slot mounted and vary its children so changes can animate in and out.
 */
export interface AgentWorkTrailingProps extends SpanProps {
  children?: ReactNode;
}

/** Controls whether details remain mounted while collapsed. */
export type AgentWorkDetailsPresence = DisclosurePresence;

export interface AgentWorkDetailsProps extends DivProps {
  children: ReactNode;
  /** @default "activity" */
  presence?: AgentWorkDetailsPresence;
}
