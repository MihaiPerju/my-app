import { useState } from "react";

import { Badge } from "@mistralai/ui/badge";
import { Button, ButtonLeadIcon } from "@mistralai/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mistralai/ui/table";
import { TypographySpan } from "@mistralai/ui/typography";
import { IconPlus, IconTrash } from "nucleo-sharp";

import {
  useAccessMutations,
  useAccessUsers,
  useMe,
} from "@mistralai-capabilities/feature-custom-rbac/web";
import {
  ErrorState,
  LoadingState,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

import { RightsMatrix } from "./rights-matrix";

const PAGE_SIZE = 50;

export function UsersPanel() {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const usersQuery = useAccessUsers({ limit: PAGE_SIZE, offset, q: query });
  const mutations = useAccessMutations();
  const me = useMe();
  const [selected, setSelected] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  if (usersQuery.error) return <ErrorState error={usersQuery.error} title="Could not load users" />;
  if (usersQuery.isPending)
    return <LoadingState description="Fetching principals." title="Loading users" />;

  const page = usersQuery.data;
  const users = page.items;
  // The selected user is only editable while it is on the current page; changing page or search
  // clears the rights editor rather than showing another user's grants.
  const active = users.find((user) => user.id === selected) ?? null;
  const rangeStart = page.total === 0 ? 0 : page.offset + 1;
  const rangeEnd = page.offset + users.length;
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + page.limit < page.total;
  const actionError =
    mutations.createUser.error ??
    mutations.setUserAdmin.error ??
    mutations.deleteUser.error ??
    mutations.replaceUserGrants.error;

  return (
    <div className="flex flex-col gap-4">
      {actionError ? <ErrorState error={actionError} title="That action failed" /> : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim()) return;
          // Cleared only once the user exists, so a rejected add keeps what was typed.
          mutations.createUser.mutate(
            { email: email.trim(), name: name.trim() },
            {
              onSuccess: () => {
                setEmail("");
                setName("");
              },
            },
          );
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-subtle">Email</span>
          <input
            className="border-default bg-default rounded-md border px-2 py-1.5 text-sm"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@company.com"
            value={email}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-subtle">Name</span>
          <input
            className="border-default bg-default rounded-md border px-2 py-1.5 text-sm"
            onChange={(event) => setName(event.target.value)}
            placeholder="Optional"
            value={name}
          />
        </label>
        <Button
          isDisabled={mutations.createUser.isPending}
          size="sm"
          type="submit"
          variant="primary"
        >
          <ButtonLeadIcon icon={IconPlus} />
          Add user
        </Button>
      </form>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-subtle">Search</span>
        <input
          className="border-default bg-default max-w-xs rounded-md border px-2 py-1.5 text-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
          placeholder="Filter by email or name"
          type="search"
          value={query}
        />
      </label>

      <Table>
        <TableHeader>
          <TableRow className="text-subtle">
            <TableHead className="px-4 py-3">Email</TableHead>
            <TableHead className="px-4 py-3">Name</TableHead>
            <TableHead className="px-4 py-3">Admin</TableHead>
            <TableHead className="px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            // The API refuses self-demotion and self-deletion too; this only avoids a dead click.
            const isSelf = user.email.toLowerCase() === me.data?.email.toLowerCase();
            return (
              <TableRow
                className={`cursor-pointer ${user.id === selected ? "bg-subtle" : ""}`}
                key={user.id}
                onClick={() => setSelected(user.id)}
              >
                <TableCell className="px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <button
                      aria-pressed={user.id === selected}
                      className="text-left text-sm hover:underline"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(user.id);
                      }}
                      type="button"
                    >
                      {user.email}
                    </button>
                    {user.protected ? (
                      <Badge bordered size="sm" variant="neutral">
                        protected
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-subtle px-4 py-3.5 text-sm">
                  {user.name || "—"}
                </TableCell>
                <TableCell className="px-4 py-3.5">
                  <Button
                    isDisabled={user.protected || (user.is_admin && isSelf)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        user.is_admin &&
                        !window.confirm(`Remove admin rights from ${user.email}?`)
                      ) {
                        return;
                      }
                      mutations.setUserAdmin.mutate({ userId: user.id, isAdmin: !user.is_admin });
                    }}
                    size="xs"
                    type="button"
                    variant={user.is_admin ? "primary" : "ghost"}
                  >
                    {user.is_admin ? "Admin" : "Make admin"}
                  </Button>
                </TableCell>
                <TableCell className="px-4 py-3.5">
                  <Button
                    aria-label={`Delete ${user.email}`}
                    icon={IconTrash}
                    isDisabled={user.protected || isSelf}
                    mode="icon-only"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!window.confirm(`Delete ${user.email} and all of their rights?`)) return;
                      mutations.deleteUser.mutate(user.id);
                      if (selected === user.id) setSelected(null);
                    }}
                    size="xs"
                    title="Delete user"
                    type="button"
                    variant="ghost"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="text-subtle flex items-center justify-between text-sm">
        <span>{page.total === 0 ? "No users" : `${rangeStart}-${rangeEnd} of ${page.total}`}</span>
        <div className="flex gap-2">
          <Button
            isDisabled={!hasPrev}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            size="xs"
            type="button"
            variant="ghost"
          >
            Previous
          </Button>
          <Button
            isDisabled={!hasNext}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            size="xs"
            type="button"
            variant="ghost"
          >
            Next
          </Button>
        </div>
      </div>

      {active ? (
        <div className="flex flex-col gap-2">
          <TypographySpan className="font-medium">Rights — {active.email}</TypographySpan>
          <TypographySpan className="text-subtle" size="sm">
            {active.is_admin
              ? "Admins can see and edit everything; the grants below apply only if the admin flag is removed."
              : active.team_ids.length > 0
                ? `Direct grants only. Rights inherited from this user's ${active.team_ids.length} team(s) also apply and are managed on the Teams tab.`
                : "Direct grants only. This user belongs to no team."}
          </TypographySpan>
          <RightsMatrix
            grants={active.grants}
            onReplace={(dimension, entries) =>
              mutations.replaceUserGrants.mutate({ userId: active.id, dimension, entries })
            }
            pending={mutations.replaceUserGrants.isPending}
          />
        </div>
      ) : (
        <TypographySpan className="text-subtle" size="sm">
          Select a user to edit their rights.
        </TypographySpan>
      )}
    </div>
  );
}
