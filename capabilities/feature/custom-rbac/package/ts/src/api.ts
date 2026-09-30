/**
 * A tiny, dependency-free client for the access API (`/api/v1/custom_rbac/*`).
 *
 * Headless by design: it uses the standard `fetch` (same-origin, so the gateway forwards the
 * caller's identity headers), takes an optional base path and an optional `actAs` provider (the
 * admin preview header), and returns typed data. A design system is never involved.
 *
 * `actAs` only affects THIS client's requests (e.g. `/me`, so nav gating previews the target). An
 * app previewing its data views as another user must send `ACT_AS_HEADER` from its own API client
 * too, and key its own queries on the previewed identity; otherwise those views keep showing the
 * admin's data. The server honours the header for admins only.
 */

import type {
  AccessSchema,
  AccessUser,
  Catalog,
  CatalogResponse,
  DirectoryUser,
  GrantEntry,
  Me,
  Team,
  TeamMembersPage,
  TeamMembersPageParams,
  TeamsPage,
  TeamsPageParams,
  UsersPage,
  UsersPageParams,
} from "./types";

export interface AccessClientOptions {
  /** Base path the routes are mounted at. Defaults to `/api/v1/custom_rbac`. */
  baseUrl?: string;
  /** Fetch implementation (injectable for tests / SSR). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Returns the email to preview as (admin act-as), or null for none. */
  actAs?: () => string | null | undefined;
}

const DEFAULT_BASE = "/api/v1/custom_rbac";
/** The admin preview header the server honours (admins only). */
export const ACT_AS_HEADER = "x-act-as-email";

export class AccessApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AccessApiError";
  }
}

/** The human message in a FastAPI error body: `detail` as a string, or the joined `msg` of a
 * validation error list. Falls back to the raw body when it is not that shape. */
export function errorMessage(body: string): string {
  try {
    const detail: unknown = (JSON.parse(body) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : undefined))
        .filter((m): m is string => typeof m === "string");
      if (msgs.length) return msgs.join("; ");
    }
  } catch {
    // Not JSON: the raw body is the best message there is.
  }
  return body;
}

async function request<T>(path: string, init: RequestInit, opts: AccessClientOptions): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const actAs = opts.actAs?.();
  if (actAs) headers.set(ACT_AS_HEADER, actAs);
  const res = await doFetch(`${opts.baseUrl ?? DEFAULT_BASE}${path}`, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AccessApiError(res.status, errorMessage(body) || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** The full access API surface, bound to one set of options. */
export function createAccessClient(opts: AccessClientOptions = {}) {
  return {
    // A stable identity for this client's (base URL + effective act-as) pairing, so query caches
    // key on it and switching preview identity or backend refetches instead of serving another
    // identity's cached permissions. Recomputed each call, so a changing `actAs` changes the key.
    scope: () => `${opts.baseUrl ?? DEFAULT_BASE}::${opts.actAs?.() ?? ""}`,

    // caller
    getMe: () => request<Me>("/me", { method: "GET" }, opts),
    listDirectory: (q = "") =>
      request<DirectoryUser[]>(`/users?q=${encodeURIComponent(q)}`, { method: "GET" }, opts),

    // matrix metadata
    getSchema: () => request<AccessSchema>("/admin/schema", { method: "GET" }, opts),
    getCatalog: () =>
      request<CatalogResponse>("/admin/catalog", { method: "GET" }, opts).then(
        (r) => r.catalog as Catalog,
      ),

    // principals
    listUsers: (params: UsersPageParams = {}) => {
      const search = new URLSearchParams();
      if (params.limit != null) search.set("limit", String(params.limit));
      if (params.offset != null) search.set("offset", String(params.offset));
      if (params.q) search.set("q", params.q);
      const qs = search.toString();
      return request<UsersPage>(`/admin/users${qs ? `?${qs}` : ""}`, { method: "GET" }, opts);
    },
    createUser: (email: string, name = "") =>
      request<AccessUser>("/admin/users", { method: "POST", ...json({ email, name }) }, opts),
    setUserAdmin: (userId: number, isAdmin: boolean) =>
      request<AccessUser>(
        `/admin/users/${userId}`,
        { method: "PATCH", ...json({ is_admin: isAdmin }) },
        opts,
      ),
    deleteUser: (userId: number) =>
      request<void>(`/admin/users/${userId}`, { method: "DELETE" }, opts),
    replaceUserGrants: (userId: number, dimension: string, entries: GrantEntry[]) =>
      request<AccessUser>(
        `/admin/users/${userId}/grants/${encodeURIComponent(dimension)}`,
        { method: "PUT", ...json({ entries }) },
        opts,
      ),

    // teams
    listTeams: (params: TeamsPageParams = {}) => {
      const search = new URLSearchParams();
      if (params.limit != null) search.set("limit", String(params.limit));
      if (params.offset != null) search.set("offset", String(params.offset));
      if (params.q) search.set("q", params.q);
      const qs = search.toString();
      return request<TeamsPage>(`/admin/teams${qs ? `?${qs}` : ""}`, { method: "GET" }, opts);
    },
    createTeam: (name: string) =>
      request<Team>("/admin/teams", { method: "POST", ...json({ name }) }, opts),
    renameTeam: (teamId: number, name: string) =>
      request<Team>(`/admin/teams/${teamId}`, { method: "PATCH", ...json({ name }) }, opts),
    deleteTeam: (teamId: number) =>
      request<void>(`/admin/teams/${teamId}`, { method: "DELETE" }, opts),
    replaceTeamMembers: (teamId: number, principalIds: number[]) =>
      request<Team>(
        `/admin/teams/${teamId}/members`,
        { method: "PUT", ...json({ principal_ids: principalIds }) },
        opts,
      ),
    listTeamMembers: (teamId: number, params: TeamMembersPageParams = {}) => {
      const search = new URLSearchParams();
      if (params.limit != null) search.set("limit", String(params.limit));
      if (params.offset != null) search.set("offset", String(params.offset));
      if (params.q) search.set("q", params.q);
      const qs = search.toString();
      return request<TeamMembersPage>(
        `/admin/teams/${teamId}/members${qs ? `?${qs}` : ""}`,
        { method: "GET" },
        opts,
      );
    },
    addTeamMember: (teamId: number, principalId: number) =>
      request<Team>(`/admin/teams/${teamId}/members/${principalId}`, { method: "PUT" }, opts),
    removeTeamMember: (teamId: number, principalId: number) =>
      request<Team>(`/admin/teams/${teamId}/members/${principalId}`, { method: "DELETE" }, opts),
    replaceTeamGrants: (teamId: number, dimension: string, entries: GrantEntry[]) =>
      request<Team>(
        `/admin/teams/${teamId}/grants/${encodeURIComponent(dimension)}`,
        { method: "PUT", ...json({ entries }) },
        opts,
      ),
  };
}

export type AccessClient = ReturnType<typeof createAccessClient>;
