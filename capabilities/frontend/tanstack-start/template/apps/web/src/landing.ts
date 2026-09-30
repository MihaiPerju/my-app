import type { AnyRouter } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * Claim the app's landing page: `/` redirects to the strongest claim. `true` is a claim of rank
     * 0; a number is a claim of that rank, for a page that should win over the ordinary ones when
     * both are installed. Equal claims go to the route whose id sorts first.
     */
    landing?: boolean | number;
  }
}

/**
 * The path `/` redirects to: the route with the strongest `staticData.landing` claim, if any. Routes
 * are the registry — a capability that wants to be the app's front door says so on its own route,
 * so an app opens on whichever installed feature claims it most strongly.
 */
export function landingPath(router: AnyRouter): string | undefined {
  let best: { rank: number; id: string; path: string } | undefined;
  for (const route of Object.values(router.routesById)) {
    const claim = route.options.staticData?.landing;
    if (claim === undefined || claim === false) continue;
    const rank = claim === true ? 0 : claim;
    // `NaN` compares false both ways, so a claim ranked with it could never be displaced.
    if (Number.isNaN(rank)) continue;
    if (!best || rank > best.rank || (rank === best.rank && route.id < best.id)) {
      best = { rank, id: route.id, path: route.fullPath };
    }
  }
  return best?.path;
}
