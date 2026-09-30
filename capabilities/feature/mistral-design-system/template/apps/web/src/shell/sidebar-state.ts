import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

/** The name `AppShellLayout` is told to persist under; it writes this cookie, it never reads it. */
export const SIDEBAR_COOKIE_NAME = "sidebar:state";

/**
 * Whether the sidebar should start expanded. `@mistralai/ui`'s sidebar is write-only: it assigns
 * the cookie but never reads it back, so a collapsed rail did not survive a reload. It must resolve
 * the same way on server and client via `createIsomorphicFn`, or the sidebar is a hydration mismatch.
 */
export const readSidebarOpen = createIsomorphicFn()
  .server(() => getCookie(SIDEBAR_COOKIE_NAME) !== "false")
  .client(
    () =>
      !document.cookie.split(";").some((entry) => entry.trim() === `${SIDEBAR_COOKIE_NAME}=false`),
  );
