import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { ComponentType, SVGProps } from "react";

/**
 * A route's row in the sidebar, declared on the route itself:
 *
 * ```tsx
 * export const Route = createFileRoute("/_app/reviews")({
 *   staticData: { nav: { label: "Reviews", icon: ListChecksIcon, group: "Apps" } },
 *   component: ReviewsPage,
 * });
 * ```
 *
 * The route tree is the registry: there is no manifest to keep in step with the routes, and a nav
 * entry cannot point at a page that does not exist.
 */
export type NavEntry = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /**
   * A "new X" action pinned above every group. It links to the route with its search cleared and
   * is only current on that exact, empty-search location.
   */
  primary?: boolean;
  /** The heading of the group this row sits in. Rows with no group share one unlabelled group. */
  group?: string;
};

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    nav?: NavEntry;
    /** A section of the expanded sidebar below the nav, such as a list of recent items. */
    sidebar?: ComponentType;
  }
}

export type NavItem = NavEntry & { id: string; href: string };

export type Nav = {
  primary: NavItem[];
  /** In first-appearance order; `""` is the unlabelled group. */
  groups: [group: string, items: NavItem[]][];
  sidebars: { id: string; Sidebar: ComponentType }[];
};

type NavRoute = { id: string; fullPath: string; options: { staticData?: StaticDataRouteOption } };

/** Builds the sidebar from the routes that declare it, sorted by route id so order never depends on the filesystem. */
export function navFromRoutes(routes: readonly NavRoute[]): Nav {
  const sorted = routes.toSorted((left, right) => left.id.localeCompare(right.id));
  const items = sorted.flatMap((route): NavItem[] => {
    const nav = route.options.staticData?.nav;
    return nav ? [{ ...nav, id: route.id, href: route.fullPath }] : [];
  });

  const groups = new Map<string, NavItem[]>();
  for (const item of items.filter((candidate) => !candidate.primary)) {
    const group = item.group ?? "";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }

  return {
    primary: items.filter((item) => item.primary),
    groups: [...groups],
    sidebars: sorted.flatMap((route) => {
      const Sidebar = route.options.staticData?.sidebar;
      return Sidebar ? [{ id: route.id, Sidebar }] : [];
    }),
  };
}
