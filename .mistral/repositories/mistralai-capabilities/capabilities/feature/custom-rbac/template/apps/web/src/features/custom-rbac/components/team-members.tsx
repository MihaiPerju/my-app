import { useState } from "react";

import { Button } from "@mistralai/ui/button";
import { TypographySpan } from "@mistralai/ui/typography";

import type { Team } from "@mistralai-capabilities/feature-custom-rbac";
import {
  useAccessMutations,
  useAccessUsers,
  useTeamMembers,
} from "@mistralai-capabilities/feature-custom-rbac/web";
import {
  ErrorState,
  LoadingState,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

const MEMBER_PAGE_SIZE = 50;
const ADD_PAGE_SIZE = 50;

/**
 * One team's membership: a directory search to add users one at a time and the paged, searchable
 * current members. Incremental, so an edit never resends the whole membership set and a large team
 * never loads whole. Mount it keyed by the team id so switching teams starts from a clean search.
 */
export function TeamMembers({ team }: { team: Team }) {
  const mutations = useAccessMutations();
  const [memberQuery, setMemberQuery] = useState("");
  const [memberOffset, setMemberOffset] = useState(0);
  const membersQuery = useTeamMembers(team.id, {
    limit: MEMBER_PAGE_SIZE,
    offset: memberOffset,
    q: memberQuery,
  });
  const [addQuery, setAddQuery] = useState("");
  const [addOffset, setAddOffset] = useState(0);
  const addSearch = useAccessUsers(
    { limit: ADD_PAGE_SIZE, offset: addOffset, q: addQuery },
    undefined,
    { enabled: addQuery !== "" },
  );
  const membersBusy = mutations.addTeamMember.isPending || mutations.removeTeamMember.isPending;

  const memberError = mutations.addTeamMember.error ?? mutations.removeTeamMember.error;

  return (
    <div className="flex flex-col gap-2">
      {memberError ? <ErrorState error={memberError} title="That action failed" /> : null}
      <TypographySpan className="font-medium">
        Members — {team.name} ({team.member_count})
      </TypographySpan>

      <TypographySpan className="text-subtle" size="sm">
        Add a member
      </TypographySpan>
      <input
        aria-label="Search users to add"
        className="border-default bg-default max-w-xs rounded-md border px-2 py-1.5 text-sm"
        onChange={(event) => {
          setAddQuery(event.target.value);
          setAddOffset(0);
        }}
        placeholder="Search users by email or name"
        type="search"
        value={addQuery}
      />
      {addQuery ? (
        addSearch.isPending ? (
          <LoadingState description="Searching users." title="Loading users" />
        ) : addSearch.error ? (
          <ErrorState error={addSearch.error} title="Could not load users" />
        ) : (
          <>
            <div className="grid gap-1.5">
              {addSearch.data.items.map((user) => (
                <div className="flex items-center justify-between gap-2 text-sm" key={user.id}>
                  <span>{user.email}</span>
                  <Button
                    isDisabled={membersBusy}
                    onClick={() =>
                      mutations.addTeamMember.mutate({
                        teamId: team.id,
                        principalId: user.id,
                      })
                    }
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Add
                  </Button>
                </div>
              ))}
              {addSearch.data.total === 0 ? (
                <TypographySpan className="text-subtle" size="sm">
                  No matching users.
                </TypographySpan>
              ) : null}
            </div>
            {addSearch.data.total > 0 ? (
              <div className="text-subtle flex items-center justify-between text-sm">
                <span>
                  {`${addSearch.data.offset + 1}-${
                    addSearch.data.offset + addSearch.data.items.length
                  } of ${addSearch.data.total}`}
                </span>
                <div className="flex gap-2">
                  <Button
                    isDisabled={addSearch.data.offset === 0}
                    onClick={() => setAddOffset(Math.max(0, addOffset - ADD_PAGE_SIZE))}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Previous
                  </Button>
                  <Button
                    isDisabled={
                      addSearch.data.offset + addSearch.data.limit >= addSearch.data.total
                    }
                    onClick={() => setAddOffset(addOffset + ADD_PAGE_SIZE)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )
      ) : null}

      <TypographySpan className="text-subtle" size="sm">
        Current members
      </TypographySpan>
      <input
        aria-label="Search members"
        className="border-default bg-default max-w-xs rounded-md border px-2 py-1.5 text-sm"
        onChange={(event) => {
          setMemberQuery(event.target.value);
          setMemberOffset(0);
        }}
        placeholder="Search members"
        type="search"
        value={memberQuery}
      />
      {membersQuery.error ? (
        <ErrorState error={membersQuery.error} title="Could not load members" />
      ) : membersQuery.isPending ? (
        <LoadingState description="Fetching members." title="Loading members" />
      ) : (
        <>
          <div className="grid gap-1.5">
            {membersQuery.data.items.map((member) => (
              <div className="flex items-center justify-between gap-2 text-sm" key={member.id}>
                <span>{member.email}</span>
                <Button
                  isDisabled={membersBusy}
                  onClick={() =>
                    mutations.removeTeamMember.mutate({
                      teamId: team.id,
                      principalId: member.id,
                    })
                  }
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
            ))}
            {membersQuery.data.total === 0 ? (
              <TypographySpan className="text-subtle" size="sm">
                No members yet.
              </TypographySpan>
            ) : null}
          </div>
          <div className="text-subtle flex items-center justify-between text-sm">
            <span>
              {membersQuery.data.total === 0
                ? "No members"
                : `${membersQuery.data.offset + 1}-${
                    membersQuery.data.offset + membersQuery.data.items.length
                  } of ${membersQuery.data.total}`}
            </span>
            <div className="flex gap-2">
              <Button
                isDisabled={membersQuery.data.offset === 0}
                onClick={() => setMemberOffset(Math.max(0, memberOffset - MEMBER_PAGE_SIZE))}
                size="xs"
                type="button"
                variant="ghost"
              >
                Previous
              </Button>
              <Button
                isDisabled={
                  membersQuery.data.offset + membersQuery.data.limit >= membersQuery.data.total
                }
                onClick={() => setMemberOffset(memberOffset + MEMBER_PAGE_SIZE)}
                size="xs"
                type="button"
                variant="ghost"
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
