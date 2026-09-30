/**
 * Contracts for the access (RBAC) API. Field names match the JSON the API returns (the pydantic
 * models), so there is no mapping layer to drift. Dimension-agnostic: the catalog and the
 * permission maps are keyed by the app's dimension names, with `page` the one built-in.
 */

export interface Grant {
  dimension: string;
  value: string;
  write: boolean;
}

export interface GrantEntry {
  value: string;
  write: boolean;
}

export interface AccessUser {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
  grants: Grant[];
  team_ids: number[];
  /** A bootstrap admin: cannot be demoted or deleted (lock the controls). */
  protected: boolean;
}

/** One page of the admin matrix: the page's users plus the total matching the query, so the panel
 * can render page controls without the endpoint ever loading the whole tenant. */
export interface UsersPage {
  items: AccessUser[];
  total: number;
  limit: number;
  offset: number;
}

/** Parameters for one page of the admin matrix. All optional; the server defaults the page size. */
export interface UsersPageParams {
  limit?: number;
  offset?: number;
  /** Case-insensitive email/name filter (the same match the directory uses). */
  q?: string;
}

/** A team in the matrix: its grants plus a member COUNT rather than every id, so listing a team never
 * serializes one id per tenant user. Membership is read/edited via the paged members endpoints. */
export interface Team {
  id: number;
  name: string;
  member_count: number;
  grants: Grant[];
}

export interface TeamsPage {
  items: Team[];
  total: number;
  limit: number;
  offset: number;
}

/** Parameters for one page of the team matrix. All optional; the server defaults the page size. */
export interface TeamsPageParams {
  limit?: number;
  offset?: number;
  /** Case-insensitive team-name filter. */
  q?: string;
}

/** One member of a team (a principal). */
export interface TeamMember {
  id: number;
  email: string;
  name: string;
}

/** One page of a team's membership plus the total matching the query. */
export interface TeamMembersPage {
  items: TeamMember[];
  total: number;
  limit: number;
  offset: number;
}

/** Parameters for one page of a team's membership. All optional; the server defaults the page size. */
export interface TeamMembersPageParams {
  limit?: number;
  offset?: number;
  /** Case-insensitive member email/name filter. */
  q?: string;
}

export interface AccessSchema {
  /** Values of the `page` dimension. */
  pages: string[];
  /** The app's data dimensions (may be empty for a pages-only app). */
  dimensions: string[];
  /**
   * Tab values (`page:tab` codes) per page, so the matrix nests tabs under their page with a
   * select-all that cascades. A page absent here (or the whole map empty) renders flat. Tabs are
   * `page` values, so their labels come from the catalog like any other page value.
   */
  tabs: Record<string, string[]>;
}

export interface CatalogItem {
  value: string;
  label: string;
}

/** Grantable values per dimension, keyed by dimension name (`page` included). */
export type Catalog = Record<string, CatalogItem[]>;

export interface CatalogResponse {
  catalog: Catalog;
}

/**
 * The caller's own authorization, for gating nav + write actions. `is_admin`/`unrestricted` are the
 * bypass cases; otherwise `read`/`write` map each dimension to the granted values. `acting_as` is
 * set when an admin previews another user.
 */
export interface Me {
  email: string;
  is_admin: boolean;
  unrestricted: boolean;
  acting_as: string | null;
  read: Record<string, string[]>;
  write: Record<string, string[]>;
}

export interface DirectoryUser {
  email: string;
  name: string;
}
