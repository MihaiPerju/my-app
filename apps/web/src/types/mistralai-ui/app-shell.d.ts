import type { AnchorHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from "react";

type DivProps = ComponentPropsWithoutRef<"div"> & {
  children?: ReactNode;
};

export function AppShellLayout(
  props: DivProps & {
    sidebarCookieName?: string;
    // The library writes `sidebarCookieName` but never reads it back, so the restored value
    // has to be handed in here. See `src/components/sidebar-state.ts`.
    defaultSidebarOpen?: boolean;
    contentWrapperClassName?: string;
    mainClassName?: string;
    sidebarClassName?: string;
  },
): React.ReactElement;
export function AppShellSidebarContent(props: DivProps): React.ReactElement;
export function AppShellSidebarGroup(props: DivProps): React.ReactElement;
export function AppShellSidebarGroupLabel(props: DivProps): React.ReactElement;
export function AppShellSidebarHeader(props: DivProps): React.ReactElement;
export function AppShellTopNav(props: DivProps): React.ReactElement;
export function AppShellSidebarLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string;
    children?: ReactNode;
  },
): React.ReactElement;
