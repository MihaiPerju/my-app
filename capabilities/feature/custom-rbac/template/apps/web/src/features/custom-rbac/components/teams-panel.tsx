import { useState } from "react";

import { Button, ButtonLeadIcon } from "@mistralai/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mistralai/ui/table";
import { TypographySpan } from "@mistralai/ui/typography";
import { IconPlus, IconTrash } from "nucleo-sharp";

import {
  useAccessMutations,
  useAccessTeams,
} from "@mistralai-capabilities/feature-custom-rbac/web";
import {
  ErrorState,
  LoadingState,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

import { RightsMatrix } from "./rights-matrix";
import { TeamMembers } from "./team-members";

const TEAM_PAGE_SIZE = 50;

export function TeamsPanel() {
  const mutations = useAccessMutations();
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  // The teams table pages + searches: a tenant can have many teams, and a team carries only a member
  // COUNT here, so listing an "Everyone" team never serializes one id per tenant user.
  const [teamQuery, setTeamQuery] = useState("");
  const [teamOffset, setTeamOffset] = useState(0);
  const teamsQuery = useAccessTeams({ limit: TEAM_PAGE_SIZE, offset: teamOffset, q: teamQuery });

  if (teamsQuery.error) return <ErrorState error={teamsQuery.error} title="Could not load teams" />;
  if (teamsQuery.isPending)
    return <LoadingState description="Fetching teams." title="Loading teams" />;

  const teamsPage = teamsQuery.data;
  const teams = teamsPage.items;
  const teamRangeStart = teamsPage.total === 0 ? 0 : teamsPage.offset + 1;
  const teamRangeEnd = teamsPage.offset + teams.length;
  const hasPrevTeams = teamsPage.offset > 0;
  const hasNextTeams = teamsPage.offset + teamsPage.limit < teamsPage.total;
  const team = teams.find((candidate) => candidate.id === selected) ?? null;

  const actionError =
    mutations.createTeam.error ??
    mutations.renameTeam.error ??
    mutations.deleteTeam.error ??
    mutations.replaceTeamGrants.error;

  return (
    <div className="flex flex-col gap-4">
      {actionError ? <ErrorState error={actionError} title="That action failed" /> : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          // Cleared only once the team exists, so a rejected add keeps what was typed.
          mutations.createTeam.mutate({ name: name.trim() }, { onSuccess: () => setName("") });
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-subtle">Team name</span>
          <input
            className="border-default bg-default rounded-md border px-2 py-1.5 text-sm"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Finance"
            value={name}
          />
        </label>
        <Button
          isDisabled={mutations.createTeam.isPending}
          size="sm"
          type="submit"
          variant="primary"
        >
          <ButtonLeadIcon icon={IconPlus} />
          Add team
        </Button>
      </form>

      <input
        aria-label="Search teams"
        className="border-default bg-default max-w-xs rounded-md border px-2 py-1.5 text-sm"
        onChange={(event) => {
          setTeamQuery(event.target.value);
          setTeamOffset(0);
        }}
        placeholder="Search teams by name"
        type="search"
        value={teamQuery}
      />

      <Table>
        <TableHeader>
          <TableRow className="text-subtle">
            <TableHead className="px-4 py-3">Team</TableHead>
            <TableHead className="px-4 py-3">Members</TableHead>
            <TableHead className="px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {teams.map((candidate) => (
            <TableRow
              className={`cursor-pointer ${candidate.id === selected ? "bg-subtle" : ""}`}
              key={candidate.id}
              onClick={() => setSelected(candidate.id)}
            >
              <TableCell className="px-4 py-3.5">
                <button
                  aria-pressed={candidate.id === selected}
                  className="text-left text-sm hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelected(candidate.id);
                  }}
                  type="button"
                >
                  {candidate.name}
                </button>
              </TableCell>
              <TableCell className="text-subtle px-4 py-3.5 text-sm">
                {candidate.member_count}
              </TableCell>
              <TableCell className="px-4 py-3.5">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    aria-label={`Delete team ${candidate.name}`}
                    icon={IconTrash}
                    mode="icon-only"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        !window.confirm(
                          `Delete ${candidate.name}? Its ${candidate.member_count} member(s) lose the rights it grants.`,
                        )
                      ) {
                        return;
                      }
                      mutations.deleteTeam.mutate(candidate.id);
                      if (selected === candidate.id) setSelected(null);
                    }}
                    size="xs"
                    title="Delete team"
                    type="button"
                    variant="ghost"
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="text-subtle flex items-center justify-between text-sm">
        <span>
          {teamsPage.total === 0
            ? "No teams"
            : `${teamRangeStart}-${teamRangeEnd} of ${teamsPage.total}`}
        </span>
        <div className="flex gap-2">
          <Button
            isDisabled={!hasPrevTeams}
            onClick={() => setTeamOffset(Math.max(0, teamOffset - TEAM_PAGE_SIZE))}
            size="xs"
            type="button"
            variant="ghost"
          >
            Previous
          </Button>
          <Button
            isDisabled={!hasNextTeams}
            onClick={() => setTeamOffset(teamOffset + TEAM_PAGE_SIZE)}
            size="xs"
            type="button"
            variant="ghost"
          >
            Next
          </Button>
        </div>
      </div>

      {team ? (
        <div className="flex flex-col gap-4">
          <TeamMembers key={team.id} team={team} />
          <div className="flex flex-col gap-2">
            <TypographySpan className="font-medium">Rights — {team.name}</TypographySpan>
            <RightsMatrix
              grants={team.grants}
              onReplace={(dimension, entries) =>
                mutations.replaceTeamGrants.mutate({ teamId: team.id, dimension, entries })
              }
              pending={mutations.replaceTeamGrants.isPending}
            />
          </div>
        </div>
      ) : (
        <TypographySpan className="text-subtle" size="sm">
          Select a team to manage members and rights.
        </TypographySpan>
      )}
    </div>
  );
}
