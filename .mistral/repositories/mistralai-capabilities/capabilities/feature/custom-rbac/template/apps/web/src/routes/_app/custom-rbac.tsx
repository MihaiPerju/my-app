import { ShieldCheckIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";

import { AccessPage } from "../../features/custom-rbac/components/access-page";

export const Route = createFileRoute("/_app/custom-rbac")({
  staticData: { nav: { label: "Access", icon: ShieldCheckIcon, group: "Admin" } },
  component: AccessRoute,
});

function AccessRoute() {
  return <AccessPage />;
}
