import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@mistralai/ui/tooltip";
import { CircleIcon, PlusIcon } from "@phosphor-icons/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AppShell, groupSlug, isNavItemActive } from "./app-shell";
import { navFromRoutes } from "./nav";
import { ThemeContext } from "./theme";

// The shell renders whatever the route tree declares, so its test declares its own routes rather
// than naming pages another capability may or may not have installed.
function Recent() {
  return <p>Recent items</p>;
}

/** The app name the shell is rendered with. */
const APP_NAME_PROBE = "Probe App";

function renderShell(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell landingHref="/new">
        <Outlet />
      </AppShell>
    ),
  });
  const page = (path: string, staticData: Parameters<typeof createRoute>[0]["staticData"]) =>
    createRoute({ getParentRoute: () => rootRoute, path, staticData, component: () => null });
  const routeTree = rootRoute.addChildren([
    page("/new", { nav: { label: "New item", icon: PlusIcon, primary: true }, sidebar: Recent }),
    page("/beta", { nav: { label: "Beta", icon: CircleIcon, group: "Apps" } }),
    page("/alpha", { nav: { label: "Alpha", icon: CircleIcon, group: "Apps" } }),
    page("/settings", { nav: { label: "Settings", icon: CircleIcon } }),
    page("/hidden", {}),
  ]);
  const router = createRouter({
    routeTree,
    // Named here rather than left to the default: a task runner may export the app's own APP_NAME.
    context: { appName: APP_NAME_PROBE },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  const view = render(
    <TooltipProvider>
      <ThemeContext value={{ theme: "dark", toggleTheme: () => {} }}>
        <RouterProvider router={router} />
      </ThemeContext>
    </TooltipProvider>,
  );
  return { router, ...view };
}

const linksIn = (element: HTMLElement) =>
  within(element)
    .getAllByRole("link")
    .map((link) => ({ title: link.textContent, href: link.getAttribute("href") }));

function group(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  // SAFETY: the expect above fails the test unless `element` is present.
  return element as HTMLElement;
}

afterEach(cleanup);

describe("AppShell", () => {
  test("renders every route's staticData.nav, grouped, and each sidebar section", async () => {
    const { container, router } = renderShell("/alpha");
    await router.load();
    await waitFor(() => expect(container.querySelector("[data-app-shell-brand]")).not.toBeNull());

    expect(linksIn(group(container, ".nav-group-primary"))).toEqual([
      { title: "New item", href: "/new" },
    ]);
    const apps = group(container, ".nav-group-apps");
    expect(within(apps).getByText("Apps")).toBeTruthy();
    // Sorted by route id, never by declaration or filesystem order.
    expect(linksIn(apps)).toEqual([
      { title: "Alpha", href: "/alpha" },
      { title: "Beta", href: "/beta" },
    ]);
    expect(linksIn(group(container, ".nav-group-default"))).toEqual([
      { title: "Settings", href: "/settings" },
    ]);
    expect(within(group(container, ".nav-sidebar")).getByText("Recent items")).toBeTruthy();

    const current = [...container.querySelectorAll("a[aria-current='page']")].map((link) =>
      link.getAttribute("href"),
    );
    expect(current).toEqual(["/alpha"]);
  });

  test("the primary action stops claiming to be the current page once search state is open", async () => {
    const { container, router } = renderShell("/new?session=11111111-1111-4111-8111-111111111111");
    await router.load();
    await waitFor(() => expect(container.querySelector(".nav-group-primary")).not.toBeNull());

    const primary = group(container, ".nav-group-primary");
    expect(
      within(primary).getByRole("link", { name: "New item" }).hasAttribute("aria-current"),
    ).toBe(false);
  });

  test("the brand shows the app name and leads to the landing page", async () => {
    const { container, router } = renderShell("/alpha");
    await router.load();
    await waitFor(() => expect(container.querySelector("[data-app-shell-brand]")).not.toBeNull());

    const brand = group(container, "[data-app-shell-brand]");
    expect(within(brand).getByText(APP_NAME_PROBE)).toBeTruthy();
    expect(brand.getAttribute("href")).toBe("/new");
  });
});

describe("navFromRoutes", () => {
  test("ignores routes without staticData", () => {
    expect(navFromRoutes([{ id: "/x", fullPath: "/x", options: {} }])).toEqual({
      primary: [],
      groups: [],
      sidebars: [],
    });
  });
});

describe("groupSlug", () => {
  test("turns a heading into a class-safe hook", () => {
    expect(groupSlug("Apps")).toBe("apps");
    expect(groupSlug("My Tools & Stuff")).toBe("my-tools-stuff");
    expect(groupSlug("")).toBe("default");
  });
});

describe("isNavItemActive", () => {
  test("matches home exactly and other routes by path prefix", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/", "/any/nested/path")).toBe(false);
    expect(isNavItemActive("/alpha", "/")).toBe(false);
    expect(isNavItemActive("/alpha", "/alpha/jobs/job-123")).toBe(true);
    expect(isNavItemActive("/alpha", "/alpha-legacy")).toBe(false);
  });
});
