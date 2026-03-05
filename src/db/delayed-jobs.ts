import db from "./index.js";

export interface DelayedJob {
  id: number;
  type: string;
  key: string;
  payload: string;
  run_at: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export function scheduleJob(
  type: string,
  key: string,
  payload: Record<string, unknown>,
  runAt: Date,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO delayed_jobs (type, key, payload, run_at) VALUES (?, ?, ?, ?)`,
    )
    .run(type, key, JSON.stringify(payload), runAt.toISOString());
  return result.changes > 0;
}

export function getPendingJobs(limit = 10): DelayedJob[] {
  return db
    .prepare(
      `SELECT * FROM delayed_jobs WHERE status = 'pending' AND run_at <= datetime('now') ORDER BY run_at ASC LIMIT ?`,
    )
    .all(limit) as DelayedJob[];
}

export function markRunning(id: number) {
  db.prepare(
    `UPDATE delayed_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?`,
  ).run(id);
}

export function markCompleted(id: number) {
  db.prepare(`UPDATE delayed_jobs SET status = 'completed' WHERE id = ?`).run(
    id,
  );
}

export function markFailed(id: number, error: string) {
  db.prepare(
    `UPDATE delayed_jobs SET status = 'failed', last_error = ? WHERE id = ?`,
  ).run(error, id);
}

export function retryOrFail(id: number, error: string, maxAttempts = 3) {
  const job = db
    .prepare(`SELECT attempts FROM delayed_jobs WHERE id = ?`)
    .get(id) as { attempts: number } | undefined;
  if (job && job.attempts < maxAttempts) {
    db.prepare(
      `UPDATE delayed_jobs SET status = 'pending', last_error = ? WHERE id = ?`,
    ).run(error, id);
  } else {
    markFailed(id, error);
  }
}

export function resetStaleJobs(maxAttempts = 3) {
  db.prepare(
    `UPDATE delayed_jobs SET status = 'pending' WHERE status = 'running' AND attempts < ?`,
  ).run(maxAttempts);
  db.prepare(
    `UPDATE delayed_jobs SET status = 'failed', last_error = 'max attempts exceeded' WHERE status = 'running' AND attempts >= ?`,
  ).run(maxAttempts);
}

export function cancelJob(key: string): boolean {
  const result = db
    .prepare(`DELETE FROM delayed_jobs WHERE key = ? AND status = 'pending'`)
    .run(key);
  return result.changes > 0;
}
