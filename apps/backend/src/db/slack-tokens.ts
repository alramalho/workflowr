import db from "./index.js";

export function upsertSlackToken(slackUserId: string, accessToken: string) {
  db.prepare(`
    INSERT INTO slack_tokens (slack_user_id, access_token)
    VALUES (?, ?)
    ON CONFLICT(slack_user_id) DO UPDATE SET
      access_token = excluded.access_token,
      connected_at = datetime('now')
  `).run(slackUserId, accessToken);
}

export function getSlackToken(slackUserId: string): string | undefined {
  const row = db.prepare(
    `SELECT access_token FROM slack_tokens WHERE slack_user_id = ?`
  ).get(slackUserId) as { access_token: string } | undefined;
  return row?.access_token;
}

export function deleteSlackToken(slackUserId: string) {
  db.prepare(`DELETE FROM slack_tokens WHERE slack_user_id = ?`).run(slackUserId);
}
