import db from "./index.js";

export interface PersistedArtifact {
  id: string;
  channel_id: string;
  thread_ts: string;
  filename: string;
  mime_type: string;
  summary: string | null;
  content: Buffer;
  created_at: string;
}

export function saveArtifact(params: {
  id: string;
  channelId: string;
  threadTs: string;
  filename: string;
  mimeType: string;
  summary?: string;
  content: Buffer;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO artifacts (id, channel_id, thread_ts, filename, mime_type, summary, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.channelId, params.threadTs, params.filename, params.mimeType, params.summary ?? null, params.content);
}

export function getArtifactFromDb(id: string): PersistedArtifact | undefined {
  return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as PersistedArtifact | undefined;
}

export function getThreadArtifacts(channelId: string, threadTs: string): Array<Omit<PersistedArtifact, "content">> {
  return db.prepare(`
    SELECT id, channel_id, thread_ts, filename, mime_type, summary, created_at
    FROM artifacts WHERE channel_id = ? AND thread_ts = ?
    ORDER BY created_at DESC
  `).all(channelId, threadTs) as any[];
}
