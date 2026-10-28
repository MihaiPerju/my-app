import * as AppShellComponents from "@mistralai/ui/app-shell";
import {
  AppShellLayout,
  AppShellSidebarContent,
  AppShellSidebarGroup,
  AppShellSidebarGroupLabel,
  AppShellSidebarHeader,
  AppShellSidebarLink,
} from "@mistralai/ui/app-shell";
import { CustomColorLogo } from "@mistralai/ui/branding";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mistralai/ui/tooltip";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { MoonIcon, SidebarSimpleIcon, SunIcon } from "@phosphor-icons/react";
import { useMemo, type ComponentType, type ReactNode } from "react";

import { useAppName } from "../app-name";
import { navFromRoutes, type NavItem } from "./nav";
import { SIDEBAR_COOKIE_NAME } from "./sidebar-state";
import { useTheme } from "./theme";

// SAFETY: `@mistralai/ui/app-shell` ships `AppShellSidebarFooter` and `useAppShellLayout` at
// runtime, but its published types omit them; this narrows the namespace to the members we call.
const { AppShellSidebarFooter, useAppShellLayout } =
  AppShellComponents as typeof AppShellComponents & {
    AppShellSidebarFooter: ComponentType<{ children?: ReactNode }>;
    useAppShellLayout: () => {
      isCollapsed: boolean;
      toggleSidebar: () => void;
    };
  };

/**
 * The name states the theme the toggle switches to, because a sun icon alone is ambiguous. This
 * is a plain button, not `AppShellSidebarButton`, which hides its tooltip when the rail expands
 * and renders an <li> that drew a bullet. The size, colour, and outline icons match the nav rows.
 */
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? "Light mode" : "Dark mode";
  const Icon = theme === "dark" ? SunIcon : MoonIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={label}
          className="text-subtle hover:bg-state-soft hover:text-default ring-default flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-2 [&>svg]:size-4"
        >
          <Icon aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function BrandMark() {
  return (
    <div className="bg-basic-red-strong flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[4px]">
      <div className="flex size-4 items-center justify-center">
        <CustomColorLogo className="size-full" color="text-white-default" />
      </div>
    </div>
  );
}

/**
 * The rail's brand block, and the only control at icon width. The mark is the collapse affordance
 * and cross-fades to a sidebar glyph on hover or focus. `data-app-shell-brand` is this app's own
 * handle, because the design system stopped emitting `[data-sidebar=header]` in 64.x.
 */
function SidebarBrand({ landingHref }: { landingHref: string }) {
  const { isCollapsed, toggleSidebar } = useAppShellLayout();
  const appName = useAppName();

  if (isCollapsed) {
    return (
      <button
        type="button"
        data-app-shell-brand=""
        aria-label="Expand sidebar"
        // A collapsed rail expands on any click that misses a `[data-sidebar=menu-button]`. This
        // is a bare <button>, so the primitive counts it as empty space. Without `stopPropagation`
        // the click toggles twice and returns to its start width.
        onClick={(event) => {
          event.stopPropagation();
          toggleSidebar();
        }}
        className="group/brand hover:bg-state-ghost-hover ring-default relative flex size-8 shrink-0 items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-2"
      >
        <span className="transition-opacity group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0">
          <BrandMark />
        </span>
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100"
        >
          {/* Same size and colour as the expanded toggle in `SIDEBAR_CLASS`: one affordance in
              two states, so it should not change appearance between them. */}
          <SidebarSimpleIcon className="text-muted size-4" />
        </span>
      </button>
    );
  }

  return (
    <Link
      to={landingHref}
      data-app-shell-brand=""
      className="hover:bg-state-ghost-hover flex h-8 min-w-0 items-center gap-2 rounded-md px-2 transition-colors"
    >
      <BrandMark />
      <span className="text-default block min-w-0 truncate text-base leading-5 font-medium">
        {appName}
      </span>
    </Link>
  );
}

/**
 * A route's "new X" action. It targets the route's empty state, so `search={{}}` clears sub-state.
 * `exact` plus `includeSearch` stop it announcing "current page" for a populated href with the same
 * path, such as `/chat?session=…` over `/chat`.
 */
function PrimaryActionLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <AppShellSidebarLink href={item.href} tooltip={item.label} asChild>
      <Link to={item.href} search={{}} activeOptions={{ exact: true, includeSearch: true }}>
        <Icon aria-hidden />
        <span>{item.label}</span>
      </Link>
    </AppShellSidebarLink>
  );
}

/**
 * A route's own rail section, such as a list of recent conversations. It is a child so it sits inside
 * `AppShellLayout`'s context, which `AppShell` is outside of. It is dropped when the sidebar is a
 * strip of icons, because a list of truncated titles has nothing to show at that width.
 */
function SidebarSection({ Sidebar }: { Sidebar: ComponentType }) {
  const { isCollapsed } = useAppShellLayout();

  if (isCollapsed) {
    return null;
  }

  return <Sidebar />;
}

// The rail's groups are short, one or two rows each, but the primitive's defaults suit long ones:
// 8px of padding at each end of a group plus an 8px gap stacks 24px between "New chat" and "Apps".
// This halves the padding globally, not per-group, so the rhythm stays even.
const GROUP_CLASS = "py-1";

const SIDEBAR_CLASS = [
  // The sidebar surface. This rule sets `bg-sidebar` on the outer `[data-sidebar=sidebar]` shell,
  // which the DS leaves transparent while expanded, so the shell does not flash `bg-subtle` during
  // the collapse or expand transition.
  "[&_[data-sidebar=sidebar]]:bg-sidebar",
  // Earlier overrides are gone on purpose. Do not re-add them: each matches nothing or fights the
  // DS in 64.x, which no longer emits `[data-sidebar=header]` and aligns brand and nav icons
  // natively. Collapsed, the rail is only icons, so the next three rules remove the group padding
  // and menu gap that space out labelled rows.
  "group-data-[collapsible=icon]:[&_[data-sidebar=menu]]:gap-0.5",
  "group-data-[collapsible=icon]:[&_[data-sidebar=group]]:py-0",
  "group-data-[collapsible=icon]:[&_[data-sidebar=menu-item]]:mb-0",
  // The shell's own collapse button, kept on because it is the only collapse affordance while
  // expanded. These rules match its glyph to the nav rows at `text-muted` and 16px, the same
  // values `SidebarBrand` uses. The selector targets the only <button> the DS mounts as a direct
  // child of `[data-sidebar=content] > div` while expanded.
  "group-data-[state=expanded]:[&_[data-sidebar=content]>div>button_svg]:text-muted",
  "group-data-[state=expanded]:[&_[data-sidebar=content]>div>button_svg]:size-4",
].join(" ");

/**
 * A group's class hook (`nav-group-apps` for "Apps"). `AppShellSidebarGroup` forwards only
 * `className`, so classes are the only handle tests and styles have on a group.
 */
export function groupSlug(group: string): string {
  return (
    group
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}

export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  // Resolved from the cookie by the layout route's loader, which reads it the same way on the
  // server and in the browser. Defaulting to expanded matches the library.
  defaultSidebarOpen = true,
  landingHref = "/",
}: {
  children: ReactNode;
  defaultSidebarOpen?: boolean;
  landingHref?: string;
}) {
  const routesById = useRouter().routesById;
  const nav = useMemo(() => navFromRoutes(Object.values(routesById)), [routesById]);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <AppShellLayout
      sidebarCookieName={SIDEBAR_COOKIE_NAME}
      defaultSidebarOpen={defaultSidebarOpen}
      // The shell injects its own expand button as the first menu child when collapsed, above the
      // primary action, which reorders the rail at icon width. `SidebarBrand` is this rail's
      // expand affordance, so the shell's button is off.
      showCollapsedSidebarToggle={false}
      sidebarClassName={SIDEBAR_CLASS}
    >
      <AppShellSidebarHeader>
        <SidebarBrand landingHref={landingHref} />
      </AppShellSidebarHeader>

      <AppShellSidebarContent>
        {nav.primary.length ? (
          <AppShellSidebarGroup className={`nav-group-primary ${GROUP_CLASS}`}>
            {nav.primary.map((item) => (
              <PrimaryActionLink key={item.id} item={item} />
            ))}
          </AppShellSidebarGroup>
        ) : null}

        {nav.groups.map(([group, items]) => (
          <AppShellSidebarGroup
            key={group}
            className={`nav-group-${groupSlug(group)} ${GROUP_CLASS}`}
          >
            {group ? <AppShellSidebarGroupLabel>{group}</AppShellSidebarGroupLabel> : null}
            {items.map((item) => {
              const Icon = item.icon;
              const isActive = isNavItemActive(item.href, pathname);

              return (
                <AppShellSidebarLink
                  key={item.id}
                  href={item.href}
                  isActive={isActive}
                  tooltip={item.label}
                  asChild
                >
                  <Link to={item.href} aria-current={isActive ? "page" : undefined}>
                    <Icon aria-hidden />
                    <span>{item.label}</span>
                  </Link>
                </AppShellSidebarLink>
              );
            })}
          </AppShellSidebarGroup>
        ))}

        {nav.sidebars.map(({ id, Sidebar }) => (
          <AppShellSidebarGroup key={id} className={`nav-sidebar ${GROUP_CLASS}`}>
            <SidebarSection Sidebar={Sidebar} />
          </AppShellSidebarGroup>
        ))}
      </AppShellSidebarContent>

      <AppShellSidebarFooter>
        <ThemeToggle />
      </AppShellSidebarFooter>

      {children}
    </AppShellLayout>
  );
}
