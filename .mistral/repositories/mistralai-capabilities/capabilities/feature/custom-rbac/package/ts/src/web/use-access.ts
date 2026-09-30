/**
 * TanStack Query hooks over the access API. Headless: no components, no design system - a consumer
 * renders the admin matrix / nav gating however it likes. `@tanstack/react-query` and `react` are
 * optional peers. Each hook accepts an optional injected `AccessClient` (default: same-origin
 * `/api/v1/custom_rbac`).
 *
 * Query keys are scoped by the client's identity (base URL + effective act-as) so switching preview
 * identity or backend refetches rather than serving another identity's cached permissions. Mutations
 * invalidate the whole scope subtree, because writes are denormalized across resources (creating a
 * user touches the directory and a default team's members; replacing membership changes each user's
 * team_ids) and an admin panel writes rarely enough that refetching the scope is the safe default.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { type AccessClient, createAccessClient } from "../api";
import type {
  GrantEntry,
  TeamMembersPageParams,
  TeamsPageParams,
  UsersPageParams,
} from "../types";

const _default = createAccessClient();
const use = (client?: AccessClient): AccessClient => client ?? _default;

export const accessQueryKeys = {
  /** The whole subtree for a client scope: invalidate this to refresh every access view at once. */
  root: (scope: string) => ["access", scope] as const,
  me: (scope: string) => ["access", scope, "me"] as const,
  schema: (scope: string) => ["access", scope, "schema"] as const,
  catalog: (scope: string) => ["access", scope, "catalog"] as const,
  // Page params are part of the key so each page/search caches separately; mutations still invalidate
  // the whole `root(scope)` subtree, so every cached page refetches after a write.
  users: (scope: string, params: UsersPageParams = {}) =>
    ["access", scope, "users", params] as const,
  teams: (scope: string, params: TeamsPageParams = {}) =>
    ["access", scope, "teams", params] as const,
  teamMembers: (scope: string, teamId: number, params: TeamMembersPageParams = {}) =>
    ["access", scope, "team-members", teamId, params] as const,
  directory: (scope: string, q: string) => ["access", scope, "directory", q] as const,
};

export function useMe(client?: AccessClient) {
  const c = use(client);
  return useQuery({ queryKey: accessQueryKeys.me(c.scope()), queryFn: () => c.getMe() });
}

export function useAccessSchema(client?: AccessClient) {
  const c = use(client);
  return useQuery({ queryKey: accessQueryKeys.schema(c.scope()), queryFn: () => c.getSchema() });
}

export function useAccessCatalog(client?: AccessClient) {
  const c = use(client);
  return useQuery({ queryKey: accessQueryKeys.catalog(c.scope()), queryFn: () => c.getCatalog() });
}

/** Options a caller may pass through to a list query, e.g. `enabled: false` until it is needed. */
export interface AccessQueryOptions {
  enabled?: boolean;
}

export function useAccessUsers(
  params: UsersPageParams = {},
  client?: AccessClient,
  options: AccessQueryOptions = {},
) {
  const c = use(client);
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: accessQueryKeys.users(c.scope(), params),
    queryFn: () => c.listUsers(params),
    // Keep the previous page visible while the next one loads, so paging/searching doesn't flash a
    // loading state and lose the table (the admin panel's UX).
    placeholderData: (prev) => prev,
  });
}

export function useAccessTeams(params: TeamsPageParams = {}, client?: AccessClient) {
  const c = use(client);
  return useQuery({
    queryKey: accessQueryKeys.teams(c.scope(), params),
    queryFn: () => c.listTeams(params),
    // Keep the previous page visible while the next one loads (same UX as the paged user matrix).
    placeholderData: (prev) => prev,
  });
}

export function useTeamMembers(
  teamId: number | null,
  params: TeamMembersPageParams = {},
  client?: AccessClient,
) {
  const c = use(client);
  return useQuery({
    // `enabled` is false until a team is selected, so the hook can be called unconditionally.
    enabled: teamId != null,
    queryKey: accessQueryKeys.teamMembers(c.scope(), teamId ?? -1, params),
    queryFn: () => c.listTeamMembers(teamId as number, params),
    // Keep the previous page visible only while paging/searching WITHIN the same team (the team id is
    // the 4th key segment). On a team switch the previous team's members must never show, so drop the
    // placeholder and load fresh.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[3] === teamId ? prev : undefined,
  });
}

export function useDirectory(q = "", client?: AccessClient) {
  const c = use(client);
  return useQuery({
    queryKey: accessQueryKeys.directory(c.scope(), q),
    queryFn: () => c.listDirectory(q),
  });
}

/** The write side of the matrix. Every mutation invalidates the client scope's whole subtree so no
 * denormalized view (users, teams, directory, /me) is left stale. */
export function useAccessMutations(client?: AccessClient) {
  const c = use(client);
  const qc = useQueryClient();
  // Invalidate the scope the write was issued under (captured in `onMutate`), not the current one:
  // switching act-as while a mutation is in flight must not leave the mutated identity's views stale.
  const refresh = (_data: unknown, _vars: unknown, scope: string) =>
    qc.invalidateQueries({ queryKey: accessQueryKeys.root(scope) });
  // `begin` returns the scope the write is issued under. Starting an action clears every *other* action's stale error (the panels render the union of
  // these errors) but never resets the mutation entering `pending` - resetting the active one
  // detaches its observer, so its own pending/error state would be lost. Siblings already pending
  // are skipped too, so a concurrent action is never clobbered.
  const group = useRef<Record<string, { reset: () => void; status: string }>>({});
  const begin = (self: string) => (): string => {
    for (const [key, m] of Object.entries(group.current)) {
      if (key !== self && m.status !== "pending") m.reset();
    }
    return c.scope();
  };
  const mutations = {
    createUser: useMutation({
      mutationFn: (v: { email: string; name?: string }) => c.createUser(v.email, v.name),
      onMutate: begin("createUser"),
      onSuccess: refresh,
    }),
    setUserAdmin: useMutation({
      mutationFn: (v: { userId: number; isAdmin: boolean }) => c.setUserAdmin(v.userId, v.isAdmin),
      onMutate: begin("setUserAdmin"),
      onSuccess: refresh,
    }),
    deleteUser: useMutation({
      mutationFn: (userId: number) => c.deleteUser(userId),
      onMutate: begin("deleteUser"),
      onSuccess: refresh,
    }),
    replaceUserGrants: useMutation({
      mutationFn: (v: { userId: number; dimension: string; entries: GrantEntry[] }) =>
        c.replaceUserGrants(v.userId, v.dimension, v.entries),
      onMutate: begin("replaceUserGrants"),
      onSuccess: refresh,
    }),
    createTeam: useMutation({
      mutationFn: (v: { name: string }) => c.createTeam(v.name),
      onMutate: begin("createTeam"),
      onSuccess: refresh,
    }),
    renameTeam: useMutation({
      mutationFn: (v: { teamId: number; name: string }) => c.renameTeam(v.teamId, v.name),
      onMutate: begin("renameTeam"),
      onSuccess: refresh,
    }),
    deleteTeam: useMutation({
      mutationFn: (teamId: number) => c.deleteTeam(teamId),
      onMutate: begin("deleteTeam"),
      onSuccess: refresh,
    }),
    replaceTeamMembers: useMutation({
      mutationFn: (v: { teamId: number; principalIds: number[] }) =>
        c.replaceTeamMembers(v.teamId, v.principalIds),
      onMutate: begin("replaceTeamMembers"),
      onSuccess: refresh,
    }),
    addTeamMember: useMutation({
      mutationFn: (v: { teamId: number; principalId: number }) =>
        c.addTeamMember(v.teamId, v.principalId),
      onMutate: begin("addTeamMember"),
      onSuccess: refresh,
    }),
    removeTeamMember: useMutation({
      mutationFn: (v: { teamId: number; principalId: number }) =>
        c.removeTeamMember(v.teamId, v.principalId),
      onMutate: begin("removeTeamMember"),
      onSuccess: refresh,
    }),
    replaceTeamGrants: useMutation({
      mutationFn: (v: { teamId: number; dimension: string; entries: GrantEntry[] }) =>
        c.replaceTeamGrants(v.teamId, v.dimension, v.entries),
      onMutate: begin("replaceTeamGrants"),
      onSuccess: refresh,
    }),
  };
  group.current = mutations;
  return mutations;
}
