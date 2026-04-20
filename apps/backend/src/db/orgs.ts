import db from "./index.js";

export interface Org {
  id: number;
  name: string;
  team_id: string | null;
  url: string | null;
  description: string | null;
  industry: string | null;
  location: string | null;
  slack_domain: string | null;
  github_org: string | null;
  linear_team_id: string | null;
  metadata: string;
}

export function createOrg(
  name: string,
  fields: {
    teamId?: string;
    url?: string;
    description?: string;
    industry?: string;
    location?: string;
    slackDomain?: string;
    githubOrg?: string;
    linearTeamId?: string;
  } = {},
  metadata: Record<string, unknown> = {}
): Org {
  const result = db.prepare(`
    INSERT INTO orgs (name, team_id, url, description, industry, location, slack_domain, github_org, linear_team_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    fields.teamId ?? null,
    fields.url ?? null,
    fields.description ?? null,
    fields.industry ?? null,
    fields.location ?? null,
    fields.slackDomain ?? null,
    fields.githubOrg ?? null,
    fields.linearTeamId ?? null,
    JSON.stringify(metadata),
  );

  return getOrg(result.lastInsertRowid as number)!;
}

export function getOrg(id: number): Org | undefined {
  return db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) as Org | undefined;
}

export function getOrgByTeamId(teamId: string): Org | undefined {
  return db.prepare(`SELECT * FROM orgs WHERE team_id = ?`).get(teamId) as Org | undefined;
}

export function getAllOrgs(): Org[] {
  return db.prepare(`SELECT * FROM orgs`).all() as Org[];
}

export function updateOrg(
  id: number,
  fields: {
    name?: string;
    url?: string;
    description?: string;
    industry?: string;
    location?: string;
    slackDomain?: string;
    githubOrg?: string;
    linearTeamId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const org = getOrg(id);
  if (!org) return undefined;

  db.prepare(`
    UPDATE orgs SET
      name = ?,
      url = ?,
      description = ?,
      industry = ?,
      location = ?,
      slack_domain = ?,
      github_org = ?,
      linear_team_id = ?,
      metadata = ?
    WHERE id = ?
  `).run(
    fields.name ?? org.name,
    fields.url !== undefined ? fields.url : org.url,
    fields.description !== undefined ? fields.description : org.description,
    fields.industry !== undefined ? fields.industry : org.industry,
    fields.location !== undefined ? fields.location : org.location,
    fields.slackDomain !== undefined ? fields.slackDomain : org.slack_domain,
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
