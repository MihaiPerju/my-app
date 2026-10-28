export interface SparklineProps {
  /** Numeric series to plot. Empty renders nothing; one value renders a dot. */
  values: number[];
  /** Line stroke width. @default 1.5 */
  strokeWidth?: number;
  /** Visual style. Use `bars` for discrete data where a connecting line could mislead. @default "line" */
  variant?: "line" | "filled" | "bars";
  /** Additional class name for the root SVG. Text color controls the chart color. */
  className?: string;
  /** Accessible summary. Derived from the first and last values when omitted. */
  label?: string;
}
