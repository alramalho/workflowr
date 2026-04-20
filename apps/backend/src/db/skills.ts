import db from "./index.js";

export interface Skill {
  id: number;
  team_id: string;
  name: string;
  description: string;
  content: string;
  created_by: string | null;
  created_at: string;
}

export function upsertSkill(
  teamId: string,
  name: string,
  description: string,
  content: string,
  createdBy?: string,
) {
  db.prepare(`
    INSERT INTO skills (team_id, name, description, content, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_id, name) DO UPDATE SET
      description = excluded.description,
      content = excluded.content,
      created_by = excluded.created_by,
      created_at = datetime('now')
  `).run(teamId, name, description, content, createdBy ?? null);
}

export function getSkill(teamId: string, name: string): Skill | undefined {
  return db.prepare(
    `SELECT * FROM skills WHERE team_id = ? AND name = ?`,
  ).get(teamId, name) as Skill | undefined;
}

export function listSkills(teamId: string): Skill[] {
  return db.prepare(
    `SELECT * FROM skills WHERE team_id = ? ORDER BY name`,
  ).all(teamId) as Skill[];
}

export function deleteSkill(teamId: string, name: string): boolean {
  const result = db.prepare(`DELETE FROM skills WHERE team_id = ? AND name = ?`).run(teamId, name);
  return result.changes > 0;
}
