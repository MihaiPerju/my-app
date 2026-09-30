import { describe, expect, test } from "bun:test";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { landingPath } from "./landing";

function routerWith(...pages: { path: string; landing?: boolean | number }[]) {
  const rootRoute = createRootRoute();
  return createRouter({
    routeTree: rootRoute.addChildren(
      pages.map(({ path, landing }) =>
        createRoute({ getParentRoute: () => rootRoute, path, staticData: { landing } }),
      ),
    ),
  });
}

describe("landingPath", () => {
  test("is the route that declares staticData.landing", () => {
    expect(landingPath(routerWith({ path: "/a" }, { path: "/b", landing: true }))).toBe("/b");
  });

  test("is the strongest claim when several routes declare it", () => {
    const router = routerWith({ path: "/a", landing: true }, { path: "/b", landing: 10 });
    expect(landingPath(router)).toBe("/b");
  });

  test("goes to the route whose id sorts first between equal claims", () => {
    const router = routerWith({ path: "/b", landing: true }, { path: "/a", landing: true });
    expect(landingPath(router)).toBe("/a");
  });

  test("ignores a NaN claim, which could otherwise never be outranked", () => {
    const router = routerWith({ path: "/a", landing: Number.NaN }, { path: "/b", landing: true });
    expect(landingPath(router)).toBe("/b");
  });

  test("ignores a route that declares it false", () => {
    expect(landingPath(routerWith({ path: "/a", landing: false }))).toBeUndefined();
  });

  test("is undefined when no route declares it, so `/` renders its own page", () => {
    expect(landingPath(routerWith({ path: "/a" }))).toBeUndefined();
  });
});
