import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { resolveAppName } from "./app-name";
import { landingPath } from "./landing";
import type { RouterContext } from "./routes/__root";
import { routeTree } from "./routeTree.gen";

// Called once per request on the server and once in the browser, so each gets its own cache.
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000 } },
  });

  const context: RouterContext = {
    queryClient,
    landingPath: (): string | undefined => landingPath(router),
    appName: resolveAppName(),
  };

  const router = createRouter({
    routeTree,
    context,
    // The server resolves the app's name at request time; the browser adopts it before it matches
    // a route, so the first client render shows the name the server rendered.
    dehydrate: () => ({ appName: context.appName }),
    hydrate: (dehydrated) => {
      context.appName = dehydrated.appName;
    },
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p className="p-8">Not found.</p>,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
