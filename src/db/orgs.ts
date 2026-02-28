import db from "./index.js";

export interface Org {
  id: number;
  name: string;
  github_org: string | null;
  linear_team_id: string | null;
  metadata: string;
}

export function createOrg(
  name: string,
  ids: { githubOrg?: string; linearTeamId?: string },
  metadata: Record<string, unknown> = {}
): Org {
  const result = db.prepare(`
    INSERT INTO orgs (name, github_org, linear_team_id, metadata)
    VALUES (?, ?, ?, ?)
  `).run(name, ids.githubOrg ?? null, ids.linearTeamId ?? null, JSON.stringify(metadata));

  return getOrg(result.lastInsertRowid as number)!;
}

export function getOrg(id: number): Org | undefined {
  return db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) as Org | undefined;
}

export function getAllOrgs(): Org[] {
  return db.prepare(`SELECT * FROM orgs`).all() as Org[];
}

export function updateOrg(
  id: number,
  fields: { name?: string; githubOrg?: string; linearTeamId?: string; metadata?: Record<string, unknown> }
) {
  const org = getOrg(id);
  if (!org) return undefined;

  db.prepare(`
    UPDATE orgs SET
      name = ?,
      github_org = ?,
      linear_team_id = ?,
      metadata = ?
    WHERE id = ?
  `).run(
    fields.name ?? org.name,
    fields.githubOrg ?? org.github_org,
    fields.linearTeamId ?? org.linear_team_id,
    fields.metadata ? JSON.stringify(fields.metadata) : org.metadata,
    id,
  );

  return getOrg(id);
}

export function deleteOrg(id: number) {
  db.prepare(`DELETE FROM orgs WHERE id = ?`).run(id);
}
