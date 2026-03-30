import db from "./index.js";

export interface OrgMember {
  id: number;
  slack_id: string;
  team_id: string | null;
  name: string;
  linear_id: string | null;
  reports_to: string | null;
  role: string | null;
  writing_style: string | null;
  representative_example_message: string | null;
  is_external: number;
  problem_to_solve: string | null;
  user_overrides: string | null;
  updated_at: string;
}

export function createOrgMember(
  slackId: string,
  name: string,
  teamId?: string,
): OrgMember {
  const result = db.prepare(`
    INSERT INTO org_members (slack_id, team_id, name)
    VALUES (?, ?, ?)
  `).run(slackId, teamId ?? null, name);
  return getOrgMember(result.lastInsertRowid as number)!;
}

export function getOrgMember(id: number): OrgMember | undefined {
  return db.prepare(`SELECT * FROM org_members WHERE id = ?`).get(id) as OrgMember | undefined;
}

export function getOrgMemberBySlackId(slackId: string): OrgMember | undefined {
  return db.prepare(`SELECT * FROM org_members WHERE slack_id = ?`).get(slackId) as OrgMember | undefined;
}

export function getAllOrgMembers(teamId?: string): OrgMember[] {
  if (teamId) {
    return db.prepare(`SELECT * FROM org_members WHERE team_id = ?`).all(teamId) as OrgMember[];
  }
  return db.prepare(`SELECT * FROM org_members`).all() as OrgMember[];
}

export function updateOrgMember(
  slackId: string,
  fields: { name?: string; linearId?: string; reportsTo?: string; role?: string; writingStyle?: string; representativeExampleMessage?: string; isExternal?: boolean; problemToSolve?: string; userOverrides?: string },
) {
  const member = getOrgMemberBySlackId(slackId);
  if (!member) return undefined;

  db.prepare(`
    UPDATE org_members SET
      name = ?,
      linear_id = ?,
      reports_to = ?,
      role = ?,
      writing_style = ?,
      representative_example_message = ?,
      is_external = ?,
      problem_to_solve = ?,
      user_overrides = ?,
      updated_at = datetime('now')
    WHERE slack_id = ?
  `).run(
    fields.name ?? member.name,
    fields.linearId !== undefined ? fields.linearId : member.linear_id,
    fields.reportsTo !== undefined ? fields.reportsTo : member.reports_to,
    fields.role !== undefined ? fields.role : member.role,
    fields.writingStyle !== undefined ? fields.writingStyle : member.writing_style,
    fields.representativeExampleMessage !== undefined ? fields.representativeExampleMessage : member.representative_example_message,
    fields.isExternal !== undefined ? (fields.isExternal ? 1 : 0) : member.is_external,
    fields.problemToSolve !== undefined ? fields.problemToSolve : member.problem_to_solve,
    fields.userOverrides !== undefined ? fields.userOverrides : member.user_overrides,
    slackId,
  );

  return getOrgMemberBySlackId(slackId);
}
