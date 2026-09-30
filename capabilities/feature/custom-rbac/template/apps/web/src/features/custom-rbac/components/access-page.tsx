import { useState } from "react";

import { useMe } from "@mistralai-capabilities/feature-custom-rbac/web";
import {
  ErrorState,
  LoadingState,
  ProductSection,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

import { TeamsPanel } from "./teams-panel";
import { UsersPanel } from "./users-panel";

type Tab = "users" | "teams";

/**
 * The admin matrix: users and teams with their read/write rights. Admin-only — the API enforces it
 * (403), and this reads `/me` to show a clear message rather than a wall of failed requests to a
 * non-admin. The rights grid itself lives in `RightsMatrix`, reused for both a user and a team.
 */
export function AccessPage() {
  const [tab, setTab] = useState<Tab>("users");
  const me = useMe();

  if (me.isPending) {
    return (
      <ProductSection title="Access">
        <LoadingState description="Checking your access." title="Loading" />
      </ProductSection>
    );
  }

  // A failed /me (network, 401, server error) has no data; surface it instead of the misleading
  // "administrator access is required" state, which is reserved for a successful non-admin response.
  if (me.error) {
    return (
      <ProductSection title="Access">
        <ErrorState error={me.error} title="Could not check your access" />
      </ProductSection>
    );
  }

  if (!me.data?.is_admin) {
    return (
      <ProductSection description="Manage who can see and edit what." title="Access">
        <div className="text-subtle p-6 text-sm">
          Administrator access is required to manage access.
        </div>
      </ProductSection>
    );
  }

  return (
    <ProductSection description="Users, teams, and their read/write rights." title="Access">
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
          <legend className="sr-only">Access sections</legend>
          {(["users", "teams"] as const).map((value) => (
            <button
              aria-pressed={tab === value}
              className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                tab === value ? "bg-inverted text-inverted-default" : "hover:bg-state-ghost-hover"
              }`}
              key={value}
              onClick={() => setTab(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </fieldset>
        {tab === "users" ? <UsersPanel /> : <TeamsPanel />}
      </div>
    </ProductSection>
  );
}
