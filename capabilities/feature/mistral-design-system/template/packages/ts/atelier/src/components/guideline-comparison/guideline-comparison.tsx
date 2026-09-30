import { TypographyLi, TypographyP } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import { IconCircleCheck, IconCircleXmark } from "nucleo-sharp";
import { Children } from "react";
import type { ReactNode } from "react";

export interface GuidelineComparisonProps {
  /** Items shown in the positive column. */
  positive: readonly ReactNode[];
  /** Items shown in the negative column. */
  negative: readonly ReactNode[];
  /** Heading for the positive column. @default "Do" */
  positiveLabel?: ReactNode;
  /** Heading for the negative column. @default "Don't" */
  negativeLabel?: ReactNode;
  /** Additional class name for the comparison root. */
  className?: string;
}

/**
 * Compares recommended and discouraged items in two side-by-side checklists.
 *
 * Use this when the two sides form a meaningful contrast. The columns stack on
 * narrow screens.
 */
export function GuidelineComparison({
  positive,
  negative,
  positiveLabel = "Do",
  negativeLabel = "Don't",
  className,
}: GuidelineComparisonProps): ReactNode {
  return (
    <div className={cn("grid w-full grid-cols-1 sm:grid-cols-2", className)}>
      <GuidelineList label={positiveLabel} items={positive} polarity="positive" />
      <GuidelineList label={negativeLabel} items={negative} polarity="negative" />
    </div>
  );
}

interface GuidelineListProps {
  label: ReactNode;
  items: readonly ReactNode[];
  polarity: "positive" | "negative";
}

function GuidelineList({ label, items, polarity }: GuidelineListProps): ReactNode {
  const positive = polarity === "positive";

  return (
    <div
      className={cn(
        positive
          ? "pb-5 sm:pe-6 sm:pb-0"
          : "border-default border-t pt-5 sm:border-t-0 sm:border-s sm:ps-6 sm:pt-0",
      )}
    >
      <TypographyP variant="default" size="sm" weight="semibold" className="mb-3">
        {label}
      </TypographyP>
      <ul className="flex flex-col gap-3">
        {Children.map(items, (item) => (
          <TypographyLi variant="subtle" size="sm" className="flex items-start gap-2">
            {positive ? (
              <IconCircleCheck aria-hidden className="text-icon-success mt-0.5 size-4 shrink-0" />
            ) : (
              <IconCircleXmark
                aria-hidden
                className="text-icon-destructive mt-0.5 size-4 shrink-0"
              />
            )}
            {item}
          </TypographyLi>
        ))}
      </ul>
    </div>
  );
}
