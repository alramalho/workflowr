import db from "./index.js";

export interface User {
  id: number;
  name: string;
  slack_id: string | null;
  linear_id: string | null;
  github_username: string | null;
  metadata: string;
}

export function createUser(
  name: string,
  ids: { slackId?: string; linearId?: string; githubUsername?: string },
  metadata: Record<string, unknown> = {}
): User {
  const result = db.prepare(`
    INSERT INTO users (name, slack_id, linear_id, github_username, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, ids.slackId ?? null, ids.linearId ?? null, ids.githubUsername ?? null, JSON.stringify(metadata));

  return getUser(result.lastInsertRowid as number)!;
}

export function getUser(id: number): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function getUserBySlackId(slackId: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE slack_id = ?`).get(slackId) as User | undefined;
}

export function getUserByLinearId(linearId: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE linear_id = ?`).get(linearId) as User | undefined;
}

export function getUserByGithubUsername(username: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE github_username = ?`).get(username) as User | undefined;
}

export function getAllUsers(): User[] {
  return db.prepare(`SELECT * FROM users`).all() as User[];
}

export function updateUser(
  id: number,
  fields: { name?: string; slackId?: string; linearId?: string; githubUsername?: string; metadata?: Record<string, unknown> }
) {
  const user = getUser(id);
  if (!user) return undefined;

  db.prepare(`
    UPDATE users SET
      name = ?,
      slack_id = ?,
      linear_id = ?,
      github_username = ?,
      metadata = ?
    WHERE id = ?
  `).run(
    fields.name ?? user.name,
    fields.slackId ?? user.slack_id,
    fields.linearId ?? user.linear_id,
    fields.githubUsername ?? user.github_username,
    fields.metadata ? JSON.stringify(fields.metadata) : user.metadata,
    id,
  );

  return getUser(id);
}

export function deleteUser(id: number) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}
