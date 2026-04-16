import db from "./index.js";

export interface Skill {
  id: number;
  team_id: string;
  name: string;
  description: string;
  trigger: string;
  action: string;
  created_by: string | null;
  created_at: string;
}

export interface SkillTrigger {
  type: "keyword" | "intent";
  value: string;
}

export interface SkillActionConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body_template?: string;
  auth_secret?: string;
}

export interface SkillAction {
  type: "http_request";
  config: SkillActionConfig;
}

export function upsertSkill(
  teamId: string,
  name: string,
  description: string,
  trigger: string,
  action: string,
  createdBy?: string,
) {
  db.prepare(`
    INSERT INTO skills (team_id, name, description, trigger, action, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, name) DO UPDATE SET
      description = excluded.description,
      trigger = excluded.trigger,
      action = excluded.action,
      created_by = excluded.created_by,
      created_at = datetime('now')
  `).run(teamId, name, description, trigger, action, createdBy ?? null);
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

export function parseTrigger(skill: Skill): SkillTrigger {
  return JSON.parse(skill.trigger) as SkillTrigger;
}

export function parseAction(skill: Skill): SkillAction {
  return JSON.parse(skill.action) as SkillAction;
}
