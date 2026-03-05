import db from "./index.js";

export interface IssueThreadLink {
  id: number;
  issue_identifier: string;
  channel_id: string;
  thread_ts: string;
  resolved: number;
  created_at: string;
}

export function linkIssueToThread(
  issueIdentifier: string,
  channelId: string,
  threadTs: string,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO issue_thread_links (issue_identifier, channel_id, thread_ts) VALUES (?, ?, ?)`,
    )
    .run(issueIdentifier, channelId, threadTs);
  return result.changes > 0;
}

export function getUnresolvedLinks(): IssueThreadLink[] {
  return db
    .prepare(`SELECT * FROM issue_thread_links WHERE resolved = 0`)
    .all() as IssueThreadLink[];
}

export function markResolved(id: number) {
  db.prepare(
    `UPDATE issue_thread_links SET resolved = 1 WHERE id = ?`,
  ).run(id);
}

export function getLinkByIssue(issueIdentifier: string): IssueThreadLink | undefined {
  return db
    .prepare(`SELECT * FROM issue_thread_links WHERE issue_identifier = ? ORDER BY created_at DESC LIMIT 1`)
    .get(issueIdentifier) as IssueThreadLink | undefined;
}
