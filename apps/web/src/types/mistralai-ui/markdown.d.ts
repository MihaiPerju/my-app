import type { ReactNode } from "react";

export type MarkdownProps = {
  children?: ReactNode;
  className?: string;
};

export function Markdown(props: MarkdownProps): React.ReactElement;
