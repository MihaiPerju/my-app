import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import { Children, Fragment, isValidElement } from "react";
import type { ReactNode } from "react";

export interface InlineDetailsProps {
  /** Values to render inline, separated by middle dots. Nullish values are omitted. */
  children?: ReactNode;
  /** Additional class name for the row. */
  className?: string;
}

// Remove nullish children and flatten fragments.
function flattenItems(children: ReactNode): ReactNode[] {
  // Annotate the callback's return: React 19's `ReactNode` includes a Promise
  // member, so an inferred node return trips `promise-function-async`.
  return Children.toArray(children).flatMap((child): ReactNode[] | ReactNode =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flattenItems(child.props.children)
      : child,
  );
}

/**
 * Renders compact metadata such as counts, durations, and status details in a
 * single row. Nullish or conditional values do not leave extra separators.
 *
 * Perf: For expensive children, memoize them with `React.memo`.
 */
export function InlineDetails({ children, className }: InlineDetailsProps): ReactNode {
  const items = flattenItems(children);

  if (items.length === 0) {
    return null;
  }

  return (
    <TypographySpan
      variant="muted"
      className={cn("flex shrink-0 items-center gap-1.5 tabular-nums", className)}
    >
      {items.map((item, index) => {
        const key = isValidElement(item) ? item.key : index;
        return (
          <Fragment key={key}>
            {index > 0 && (
              <TypographySpan aria-hidden variant="subtle">
                ·
              </TypographySpan>
            )}
            {item}
          </Fragment>
        );
      })}
    </TypographySpan>
  );
}
