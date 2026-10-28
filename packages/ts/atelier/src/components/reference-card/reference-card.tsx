"use client";

import { Badge } from "@mistralai/ui/badge";
import { DocumentIcon } from "@mistralai/ui/file-icon";
import { Flex } from "@mistralai/ui/flex";
import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import type { MouseEvent, ReactNode } from "react";

import type { Reference } from "./types";

export type { Reference } from "./types";

function extensionFromString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  let path = value.replace(/[?#].*$/su, "");

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when callers pass malformed percent escapes.
  }

  return path.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? null;
}

/** Human-friendly hostname for display, or null for non-web/invalid hrefs. */
function hostnameFromHref(href: string | undefined): string | null {
  if (!href) {
    return null;
  }

  try {
    const { protocol, hostname } = new URL(href);
    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }
    return hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function extensionFromHref(href: string | undefined): string | null {
  if (!href) {
    return null;
  }

  try {
    // Skip non-web schemes (mailto:, tel:, data:) so we don't read ".com" off an address.
    const { protocol, pathname } = new URL(href, "https://placeholder.local");
    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }
    return extensionFromString(pathname);
  } catch {
    return extensionFromString(href);
  }
}

function DefaultIcon({ reference, className }: { reference: Reference; className?: string }) {
  const extension = extensionFromString(reference.title) ?? extensionFromHref(reference.href);
  const webUrl = !extension && /^https?:\/\//iu.test(reference.href ?? "") ? reference.href : null;

  return <DocumentIcon className={className} extension={extension} url={webUrl} />;
}

export interface ReferenceCardProps {
  /** Content and optional link data to display. */
  reference: Reference;
  /**
   * `compact` is a single dense row (icon, title, score). `expanded` adds the
   * description and a footer with origin and locator.
   *
   * @default "expanded"
   */
  variant?: "compact" | "expanded";
  /** Optional ordinal prefix, useful for citation-style references. */
  index?: number;
  /** Highlights a selected result or clicked marker. Also sets `aria-current`. */
  active?: boolean;
  /** Keeps the card visible but non-interactive, even when `href` or `onOpen` is provided. */
  readOnly?: boolean;
  /** Handles selection in an in-app viewer or side panel instead of navigation. */
  onOpen?: (reference: Reference) => void;
  /** Optional override for favicons, product icons, or custom artwork. */
  icon?: ReactNode;
  /** Additional class name for the card root. */
  className?: string;
}

/**
 * Displays a document, web page, file, generated asset, or citation reference.
 * Cards become links when `href` is provided, buttons when only `onOpen` is
 * provided, and non-interactive content when `readOnly` is true.
 */
export function ReferenceCard({
  reference,
  variant = "expanded",
  index,
  active = false,
  readOnly = false,
  onOpen,
  icon,
  className,
}: ReferenceCardProps): ReactNode {
  const expanded = variant === "expanded";
  const href = reference.href?.trim() ? reference.href : undefined;
  const origin = reference.origin ?? hostnameFromHref(href);
  const interactive = !readOnly && (onOpen != null || href != null);
  let Root: "a" | "button" | "div" = "div";
  if (interactive) {
    Root = href ? "a" : "button";
  }

  const scorePercent =
    reference.score == null ? null : Math.round(Math.min(1, Math.max(0, reference.score)) * 100);

  const open = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) {
      return;
    }

    event.preventDefault();
    onOpen(reference);
  };

  return (
    <Root
      {...(Root === "a"
        ? {
            href,
            target: "_blank",
            rel: "noreferrer",
            onClick: open,
          }
        : {})}
      {...(Root === "button" ? { type: "button", onClick: open } : {})}
      data-reference-card=""
      data-active={active || undefined}
      aria-current={active || undefined}
      className={cn(
        "rounded-card-sm border-darker bg-default flex w-full flex-col gap-1.5 border-[0.5px] p-3 text-start",
        Root === "button" && "appearance-none",
        interactive && "hover:border-basic-orangebright-accent cursor-pointer transition-colors",
        active && "border-basic-orangebright-accent",
        className,
      )}
    >
      <Flex alignItems="center" gap={2}>
        <span aria-hidden className="shrink-0">
          {icon ?? (
            <DefaultIcon reference={reference} className="size-5 [&>svg]:block [&>svg]:size-5" />
          )}
        </span>
        <span className="flex-1 truncate font-semibold">
          {index != null && (
            <TypographySpan variant="subtle" className="me-1 tabular-nums">
              [{index}]
            </TypographySpan>
          )}
          {reference.title}
        </span>
        {scorePercent != null && (
          <Badge
            variant="neutral"
            size="sm"
            className="shrink-0 tabular-nums"
            aria-label={`Relevance ${scorePercent}%`}
          >
            {scorePercent}%
          </Badge>
        )}
      </Flex>

      {expanded && reference.description ? (
        <TypographySpan variant="subtle" className="line-clamp-3 text-sm">
          {reference.description}
        </TypographySpan>
      ) : null}

      {expanded && (origin || reference.locator) ? (
        <TypographySpan variant="muted" className="flex items-center gap-1.5 text-xs tabular-nums">
          {origin ? <span className="truncate">{origin}</span> : null}
          {origin && reference.locator ? <span aria-hidden>·</span> : null}
          {reference.locator ? <span className="shrink-0">{reference.locator}</span> : null}
        </TypographySpan>
      ) : null}
    </Root>
  );
}
