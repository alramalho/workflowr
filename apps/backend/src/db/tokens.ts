import db from "./index.js";

export function upsertToken(slackUserId: string, refreshToken: string, email?: string) {
  db.prepare(`
    INSERT INTO google_tokens (slack_user_id, refresh_token, email)
    VALUES (?, ?, ?)
    ON CONFLICT(slack_user_id) DO UPDATE SET
      refresh_token = excluded.refresh_token,
      email = excluded.email,
      connected_at = datetime('now')
  `).run(slackUserId, refreshToken, email ?? null);
}

export function getToken(slackUserId: string): { refresh_token: string; email: string | null } | undefined {
  return db.prepare(
    `SELECT refresh_token, email FROM google_tokens WHERE slack_user_id = ?`
  ).get(slackUserId) as { refresh_token: string; email: string | null } | undefined;
}

export function getAllTokens(): Array<{ slack_user_id: string; refresh_token: string }> {
  return db.prepare(
    `SELECT slack_user_id, refresh_token FROM google_tokens`
  ).all() as Array<{ slack_user_id: string; refresh_token: string }>;
}

export function deleteToken(slackUserId: string) {
  db.prepare(`DELETE FROM google_tokens WHERE slack_user_id = ?`).run(slackUserId);
}
