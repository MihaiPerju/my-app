import { createFileRoute, redirect } from "@tanstack/react-router";

import { useAppName } from "../app-name";
import { Landing } from "../components/Landing";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    const to = context.landingPath();
    if (to && to !== "/") throw redirect({ href: to });
  },
  component: Home,
});

function Home() {
  return <Landing appName={useAppName()} />;
}
