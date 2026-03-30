import db from "./index.js";

export interface Team {
  id: number;
  org_id: number;
  name: string;
  tools: string | null;
}

export interface TeamMember {
  team_id: number;
  org_member_id: number;
}

export function getOrCreateTeam(orgId: number, name: string): Team {
  const existing = db.prepare(
    `SELECT * FROM teams WHERE org_id = ? AND name = ? COLLATE NOCASE`,
  ).get(orgId, name) as Team | undefined;
  if (existing) return existing;

  const result = db.prepare(
    `INSERT INTO teams (org_id, name) VALUES (?, ?)`,
  ).run(orgId, name);
  return db.prepare(`SELECT * FROM teams WHERE id = ?`).get(result.lastInsertRowid) as Team;
}

export function getTeamsByOrgId(orgId: number): Team[] {
  return db.prepare(`SELECT * FROM teams WHERE org_id = ?`).all(orgId) as Team[];
}

export function getTeamsForMember(orgMemberId: number): Team[] {
  return db.prepare(`
    SELECT t.* FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.org_member_id = ?
  `).all(orgMemberId) as Team[];
}

export function getMembersByTeam(teamId: number): number[] {
  return (db.prepare(
    `SELECT org_member_id FROM team_members WHERE team_id = ?`,
  ).all(teamId) as { org_member_id: number }[]).map((r) => r.org_member_id);
}

export function addMemberToTeam(teamId: number, orgMemberId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO team_members (team_id, org_member_id) VALUES (?, ?)`,
  ).run(teamId, orgMemberId);
}

export function removeMemberFromTeam(teamId: number, orgMemberId: number): void {
  db.prepare(
    `DELETE FROM team_members WHERE team_id = ? AND org_member_id = ?`,
  ).run(teamId, orgMemberId);
}

export function getTeamByName(orgId: number, name: string): Team | undefined {
  return db.prepare(`SELECT * FROM teams WHERE org_id = ? AND name = ? COLLATE NOCASE`).get(orgId, name) as Team | undefined;
}

export function updateTeamTools(teamId: number, tools: string[]): void {
  db.prepare(`UPDATE teams SET tools = ? WHERE id = ?`).run(JSON.stringify(tools), teamId);
}

export function setMemberTeams(orgMemberId: number, orgId: number, teamNames: string[]): void {
  // get or create all teams, then sync membership
  const teams = teamNames.map((name) => getOrCreateTeam(orgId, name.trim()));
  const teamIds = new Set(teams.map((t) => t.id));

  // remove from teams not in the new list
  const current = getTeamsForMember(orgMemberId);
  for (const t of current) {
    if (t.org_id === orgId && !teamIds.has(t.id)) {
      removeMemberFromTeam(t.id, orgMemberId);
    }
  }

  // add to new teams
  for (const t of teams) {
    addMemberToTeam(t.id, orgMemberId);
  }
}
