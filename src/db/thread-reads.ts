import db from "./index.js";

const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export interface ThreadRead {
  id: number;
  channel_id: string;
  thread_ts: string;
  last_read_at: string;
}

export function isThreadLocked(channelId: string, threadTs: string): boolean {
  const row = db.prepare(
    `SELECT last_read_at FROM thread_reads WHERE channel_id = ? AND thread_ts = ?`,
  ).get(channelId, threadTs) as { last_read_at: string } | undefined;

  if (!row) return false;

  const lastRead = new Date(row.last_read_at + "Z").getTime();
  return Date.now() - lastRead < LOCK_DURATION_MS;
}

export function clearThreadLocks(channelId?: string) {
  if (channelId) {
    db.prepare(`DELETE FROM thread_reads WHERE channel_id = ?`).run(channelId);
  } else {
    db.prepare(`DELETE FROM thread_reads`).run();
  }
}

export function markThreadRead(channelId: string, threadTs: string) {
  db.prepare(`
    INSERT INTO thread_reads (channel_id, thread_ts, last_read_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id, thread_ts)
    DO UPDATE SET last_read_at = datetime('now')
  `).run(channelId, threadTs);
}
