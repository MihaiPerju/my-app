// Ambient stand-ins for the private packages (@mistralai/ui) that this registry
// cannot install, because its bun.lock must stay on public npm. A consuming app installs the real
// packages, so this only affects the registry's own `check-types`.
/* eslint-disable */
declare module "@mistralai/ui/badge" {
  export const Badge: any;
  export type Badge = any;
}

declare module "@mistralai/ui/collapsible" {
  export const Collapsible: any;
  export type Collapsible = any;
  export const CollapsibleContent: any;
  export type CollapsibleContent = any;
  export const CollapsibleTrigger: any;
  export type CollapsibleTrigger = any;
}

declare module "@mistralai/ui/divider" {
  export const Divider: any;
  export type Divider = any;
}

declare module "@mistralai/ui/flex" {
  export const Flex: any;
  export type Flex = any;
}

declare module "@mistralai/ui/grid" {
  export const Grid: any;
  export type Grid = any;
  export const GridProps: any;
  export type GridProps = any;
}

declare module "@mistralai/ui/inline-tip" {
  export const InlineTip: any;
  export type InlineTip = any;
}

declare module "@mistralai/ui/loader" {
  export const Loader: any;
  export type Loader = any;
}

declare module "@mistralai/ui/task-loader" {
  export const TaskLoader: any;
  export type TaskLoader = any;
  export const TaskLoaderType: any;
  export type TaskLoaderType = any;
}

declare module "@mistralai/ui/typography" {
  export const TypographyH1: any;
  export type TypographyH1 = any;
  export const TypographyH2: any;
  export type TypographyH2 = any;
  export const TypographyP: any;
  export type TypographyP = any;
  export const TypographySpan: any;
  export type TypographySpan = any;
}
