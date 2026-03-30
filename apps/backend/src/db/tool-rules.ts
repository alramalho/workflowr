import db from "./index.js";

export interface ToolRule {
  id: number;
  tool_name: string;
  memory_text: string;
  slack_user_id: string;
  team_id: string | null;
  created_at: string;
}

export function getToolRules(toolName: string, slackUserId: string): ToolRule[] {
  return db.prepare(
    `SELECT * FROM tool_rules WHERE tool_name = ? AND slack_user_id = ?`,
  ).all(toolName, slackUserId) as ToolRule[];
}

export function addToolRule(toolName: string, memoryText: string, slackUserId: string, teamId?: string) {
  db.prepare(
    `INSERT OR IGNORE INTO tool_rules (tool_name, memory_text, slack_user_id, team_id) VALUES (?, ?, ?, ?)`,
  ).run(toolName, memoryText, slackUserId, teamId ?? null);
}

export function deleteToolRule(id: number) {
  db.prepare(`DELETE FROM tool_rules WHERE id = ?`).run(id);
}
