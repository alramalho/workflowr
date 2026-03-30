import db from "./index.js";

export interface UsageEntry {
  id: number;
  user_id: string;
  user_name: string | null;
  team_id: string | null;
  invocation_type: string;
  channel_id: string | null;
  thread_ts: string | null;
  tool_calls_count: number;
  created_at: string;
}

export function logUsage(params: {
  userId: string;
  userName?: string;
  teamId?: string;
  invocationType: string;
  channelId?: string;
  threadTs?: string;
}): number {
  const stmt = db.prepare(`
    INSERT INTO usage_log (user_id, user_name, team_id, invocation_type, channel_id, thread_ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    params.userId,
    params.userName ?? null,
    params.teamId ?? null,
    params.invocationType,
    params.channelId ?? null,
    params.threadTs ?? null,
  );
  return result.lastInsertRowid as number;
}

export function updateUsageToolCalls(id: number, count: number) {
  db.prepare(`UPDATE usage_log SET tool_calls_count = ? WHERE id = ?`).run(count, id);
}

export interface UsageSummary {
  totalCalls: number;
  byUser: { user_id: string; user_name: string | null; count: number }[];
  byType: { invocation_type: string; count: number }[];
  byUserAndType: { user_id: string; user_name: string | null; invocation_type: string; count: number }[];
  totalToolCalls: number;
  recentActivity: { date: string; count: number }[];
}

export function getUsageSummary(days = 30): UsageSummary {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const totalCalls = (db.prepare(
    `SELECT COUNT(*) as count FROM usage_log WHERE created_at >= ?`,
  ).get(since) as any).count;

  const byUser = db.prepare(
    `SELECT user_id, user_name, COUNT(*) as count FROM usage_log WHERE created_at >= ? GROUP BY user_id ORDER BY count DESC`,
  ).all(since) as UsageSummary["byUser"];

  const byType = db.prepare(
    `SELECT invocation_type, COUNT(*) as count FROM usage_log WHERE created_at >= ? GROUP BY invocation_type ORDER BY count DESC`,
  ).all(since) as UsageSummary["byType"];

  const byUserAndType = db.prepare(
    `SELECT user_id, user_name, invocation_type, COUNT(*) as count FROM usage_log WHERE created_at >= ? GROUP BY user_id, invocation_type ORDER BY count DESC`,
  ).all(since) as UsageSummary["byUserAndType"];

  const totalToolCalls = (db.prepare(
    `SELECT COALESCE(SUM(tool_calls_count), 0) as total FROM usage_log WHERE created_at >= ?`,
  ).get(since) as any).total;

  const recentActivity = db.prepare(
    `SELECT DATE(created_at) as date, COUNT(*) as count FROM usage_log WHERE created_at >= ? GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 14`,
  ).all(since) as UsageSummary["recentActivity"];

  return { totalCalls, byUser, byType, byUserAndType, totalToolCalls, recentActivity };
}
