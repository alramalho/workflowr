import db from "./index.js";

export function upsertSecret(teamId: string, name: string, value: string, createdBy?: string) {
  db.prepare(`
    INSERT INTO secrets (team_id, name, value, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id, name) DO UPDATE SET
      value = excluded.value,
      created_by = excluded.created_by,
      created_at = datetime('now')
  `).run(teamId, name, value, createdBy ?? null);
}

export function getSecret(teamId: string, name: string): string | undefined {
  const row = db.prepare(
    `SELECT value FROM secrets WHERE team_id = ? AND name = ?`
  ).get(teamId, name) as { value: string } | undefined;
  return row?.value;
}

export function listSecrets(teamId: string): Array<{ name: string; created_by: string | null; created_at: string }> {
  return db.prepare(
    `SELECT name, created_by, created_at FROM secrets WHERE team_id = ? ORDER BY name`
  ).all(teamId) as Array<{ name: string; created_by: string | null; created_at: string }>;
}

export function deleteSecret(teamId: string, name: string): boolean {
  const result = db.prepare(`DELETE FROM secrets WHERE team_id = ? AND name = ?`).run(teamId, name);
  return result.changes > 0;
}
