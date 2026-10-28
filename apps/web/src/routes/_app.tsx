import { TooltipProvider } from "@mistralai/ui/tooltip";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { Toaster } from "sonner";

import { AppShell } from "../shell/app-shell";
import { readSidebarOpen } from "../shell/sidebar-state";
import { THEME_SCRIPT, ThemeContext, applyTheme, readTheme, type Theme } from "../shell/theme";

/**
 * The Mistral app shell, as a pathless layout route: every page under `routes/_app/` renders inside
 * it and keeps its own URL (`routes/_app/reviews.tsx` is `/reviews`). A page that should not wear the
 * shell lives outside `_app/`. `?embed` renders the page bare, for hosting it in an iframe.
 */
export const Route = createFileRoute("/_app")({
  head: () => ({ scripts: [{ children: THEME_SCRIPT }] }),
  // Reads cookies and nothing else: the deployed topology authenticates API calls at the gateway,
  // so a server-side data fetch would carry no identity.
  loader: () => ({ sidebarOpen: readSidebarOpen(), theme: readTheme() }),
  component: AppLayout,
});

function AppLayout() {
  const { sidebarOpen, theme: initialTheme } = Route.useLoaderData();
  const { landingPath } = Route.useRouteContext();
  const isEmbed = useLocation({ select: (location) => "embed" in location.search });

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  const themeControls = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return (
    <ThemeContext value={themeControls}>
      <TooltipProvider delayDuration={0}>
        {isEmbed ? (
          <div className="bg-default flex h-dvh w-full flex-col">
            <Outlet />
          </div>
        ) : (
          <AppShell defaultSidebarOpen={sidebarOpen} landingHref={landingPath() ?? "/"}>
            <Outlet />
          </AppShell>
        )}
        <Toaster position="top-right" richColors />
      </TooltipProvider>
    </ThemeContext>
  );
}
