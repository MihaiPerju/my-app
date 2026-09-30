import { createFileRoute, redirect } from "@tanstack/react-router";

import { useAppName } from "../app-name";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    const to = context.landingPath();
    if (to && to !== "/") throw redirect({ href: to });
  },
  component: Home,
});

function Home() {
  const appName = useAppName();
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-2 p-8">
      <h1 className="text-3xl font-semibold">{appName}</h1>
      <p>
        Edit <code>apps/web/src/routes/index.tsx</code>, or add a route under{" "}
        <code>apps/web/src/routes/</code>.
      </p>
    </main>
  );
}
