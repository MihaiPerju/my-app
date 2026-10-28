import type { ReactElement, ReactNode } from "react";

/** Optional custom glyph replacing the default status indicator. */
export type PipelineStageIcon = ReactElement | null;

/** Lifecycle status for a stage, driving its indicator and styling. */
export type PipelineStageStatus = "pending" | "running" | "completed" | "failed";

/** Data and behavior for one stage in a `PipelineStage`. */
export interface PipelineStageItem {
  /** Stable identity for the stage. */
  id: string;
  /** Primary label, e.g. "Build". */
  label: ReactNode;
  /** Current stage status. */
  status: PipelineStageStatus;
  /** Elapsed or completed duration in milliseconds. Omit for pending stages. */
  duration?: number;
  /** Optional custom indicator glyph, overriding the status default. */
  icon?: PipelineStageIcon;
  /** Makes the stage keyboard- and pointer-interactive. */
  interactive?: boolean;
  /** Called when an interactive stage is activated. */
  onClick?: () => void;
  /** Marks this as the current stage for styling and assistive technology. */
  isActive?: boolean;
}

export interface PipelineStageProps {
  /** Accessible name for the pipeline. @default "Pipeline" */
  label?: string;
  /** Additional class name for the root. */
  className?: string;
  /** `PipelineStage.Stage` elements in sequence. */
  children: ReactNode;
}
