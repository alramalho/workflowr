import db from "./index.js";

export interface OrgGuideline {
  id: number;
  team_id: string | null;
  key: string;
  value: string;
}

export function getGuidelines(teamId?: string): OrgGuideline[] {
  if (teamId) {
    return db.prepare(`SELECT * FROM org_guidelines WHERE team_id = ? OR team_id IS NULL`).all(teamId) as OrgGuideline[];
  }
  return db.prepare(`SELECT * FROM org_guidelines WHERE team_id IS NULL`).all() as OrgGuideline[];
}

export function getGuideline(key: string, teamId?: string): string | undefined {
  const row = teamId
    ? db.prepare(`SELECT value FROM org_guidelines WHERE key = ? AND (team_id = ? OR team_id IS NULL) ORDER BY team_id DESC LIMIT 1`).get(key, teamId) as { value: string } | undefined
    : db.prepare(`SELECT value FROM org_guidelines WHERE key = ? AND team_id IS NULL LIMIT 1`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setGuideline(key: string, value: string, teamId?: string) {
  db.prepare(`
    INSERT INTO org_guidelines (team_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(key, team_id) DO UPDATE SET value = excluded.value
  `).run(teamId ?? null, key, value);
}
