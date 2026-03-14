import db from "./index.js";

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
}

export interface BotCall {
  id: number;
  caller_id: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string | null;
  prompt: string;
  response: string | null;
  tool_calls: ToolCallRecord[];
  latency_ms: number;
  created_at: string;
}

export function saveBotCall(params: {
  callerId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  prompt: string;
  response?: string;
  toolCalls: ToolCallRecord[];
  latencyMs: number;
}): number {
  const stmt = db.prepare(`
    INSERT INTO bot_calls (caller_id, channel_id, thread_ts, message_ts, prompt, response, tool_calls, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    params.callerId,
    params.channelId,
    params.threadTs ?? null,
    params.messageTs ?? null,
    params.prompt,
    params.response ?? null,
    JSON.stringify(params.toolCalls),
    params.latencyMs,
  );
  return result.lastInsertRowid as number;
}

export function updateBotCallMessageTs(id: number, messageTs: string) {
  db.prepare(`UPDATE bot_calls SET message_ts = ? WHERE id = ?`).run(messageTs, id);
}

export function getBotCallByMessageTs(channelId: string, messageTs: string): BotCall | undefined {
  const row = db.prepare(
    `SELECT * FROM bot_calls WHERE channel_id = ? AND message_ts = ? ORDER BY id DESC LIMIT 1`,
  ).get(channelId, messageTs) as any;
  if (!row) return undefined;
  return { ...row, tool_calls: JSON.parse(row.tool_calls) };
}
