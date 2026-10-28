import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type MessageThreadProps = {
  children: ReactNode;
  className?: string;
};

export function MessageThread(props: MessageThreadProps): React.ReactElement;

export type MessageThreadUserMessageProps = ComponentPropsWithoutRef<"div"> & {
  header?: ReactNode;
  footer?: ReactNode;
  headerClassName?: string;
  bubbleClassName?: string;
  footerClassName?: string;
};

export function MessageThreadUserMessage(props: MessageThreadUserMessageProps): React.ReactElement;

export type MessageThreadAssistantMessageProps = ComponentPropsWithoutRef<"div"> & {
  header?: ReactNode;
  footer?: ReactNode;
  avatar?: ReactNode;
  isLoading?: boolean;
  avatarWrapperClassName?: string;
  avatarClassName?: string;
  contentClassName?: string;
  headerClassName?: string;
  footerClassName?: string;
};

export function MessageThreadAssistantMessage(
  props: MessageThreadAssistantMessageProps,
): React.ReactElement;
