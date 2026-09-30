import { Badge } from "@mistralai/ui/badge";
import { Flex } from "@mistralai/ui/flex";
import { InlineTip } from "@mistralai/ui/inline-tip";
import { Loader } from "@mistralai/ui/loader";
import { TaskLoader, type TaskLoaderType } from "@mistralai/ui/task-loader";
import { TypographyH2, TypographyP, TypographySpan } from "@mistralai/ui/typography";
import type { ReactNode } from "react";

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
};

type ErrorLike = {
  message?: unknown;
  detail?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
};

type ErrorStateProps = {
  error: unknown;
  title?: ReactNode;
  action?: ReactNode;
};

type LoadingStateProps = {
  title: ReactNode;
  description?: ReactNode;
  task?: TaskLoaderType;
};

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <Flex
      direction="column"
      alignItems="center"
      justifyContent="center"
      gap={4}
      padding="xl"
      className="border-default bg-card-subtle rounded-card-lg border border-dashed text-center"
    >
      {icon ? <div className="text-muted">{icon}</div> : null}
      <Flex direction="column" alignItems="center" gap={1} className="max-w-md">
        <TypographyH2 size="lg" weight="semibold">
          {title}
        </TypographyH2>
        {description ? (
          <TypographyP size="sm" variant="muted">
            {description}
          </TypographyP>
        ) : null}
      </Flex>
      {action}
    </Flex>
  );
}

export function ErrorState({ error, title, action }: ErrorStateProps) {
  const normalized = normalizeError(error);

  return (
    <InlineTip state="error" className="w-full">
      <Flex direction="column" gap={3}>
        <Flex alignItems="center" justifyContent="between" gap={3}>
          <Flex direction="column" gap={1} className="min-w-0">
            {title ? (
              <TypographyH2 size="sm" weight="semibold">
                {title}
              </TypographyH2>
            ) : null}
            <TypographyP size="sm" weight="medium">
              {normalized.message}
            </TypographyP>
          </Flex>
          {normalized.status ? (
            <Badge variant="red" bordered size="sm" className="shrink-0">
              {normalized.status}
            </Badge>
          ) : null}
        </Flex>
        {normalized.detail && normalized.detail !== normalized.message ? (
          <div className="border-default bg-floating-subtle rounded-card-sm border px-3 py-2">
            <TypographySpan size="xs" variant="muted" className="font-mono">
              {normalized.detail}
            </TypographySpan>
          </div>
        ) : null}
        {action}
      </Flex>
    </InlineTip>
  );
}

export function LoadingState({ title, description, task }: LoadingStateProps) {
  return (
    <Flex
      as="output"
      direction="column"
      alignItems="center"
      justifyContent="center"
      gap={4}
      padding="xl"
      className="text-center"
    >
      {task ? <TaskLoader variant={task} className="size-24" /> : <Loader size="lg" />}
      <Flex direction="column" alignItems="center" gap={1} className="max-w-md">
        <TypographyH2 size="lg" weight="semibold">
          {title}
        </TypographyH2>
        {description ? (
          <TypographyP size="sm" variant="muted">
            {description}
          </TypographyP>
        ) : null}
      </Flex>
    </Flex>
  );
}

function normalizeError(error: unknown): {
  message: string;
  detail?: string;
  status?: string;
} {
  if (error instanceof Error) {
    const errorWithMetadata = error as Error & ErrorLike;
    return {
      message: error.message,
      detail: stringifyValue(errorWithMetadata.detail),
      status: normalizeStatus(errorWithMetadata),
    };
  }

  if (error && typeof error === "object") {
    const errorLike = error as ErrorLike;
    const detail = stringifyValue(errorLike.detail);
    return {
      message: stringifyValue(errorLike.message) ?? detail ?? JSON.stringify(error),
      detail,
      status: normalizeStatus(errorLike),
    };
  }

  return { message: stringifyValue(error) ?? String(error) };
}

function normalizeStatus(error: ErrorLike): string | undefined {
  const status = error.status ?? error.statusCode ?? error.response?.status;
  return stringifyValue(status);
}

function stringifyValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
