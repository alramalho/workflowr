import db from "./index.js";
import crypto from "node:crypto";

export interface Runner {
  id: string;
  user_id: string;
  team_id: string;
  token: string;
  status: string;
  cwd: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface RunnerDirectory {
  id: number;
  runner_id: string;
  name: string;
  path: string;
  description: string | null;
  created_at: string;
}

export function createRunner(userId: string, teamId: string): Runner {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO runners (id, user_id, team_id, token) VALUES (?, ?, ?, ?)`).run(id, userId, teamId, token);
  return db.prepare(`SELECT * FROM runners WHERE id = ?`).get(id) as Runner;
}

export function getRunnerByToken(token: string): Runner | undefined {
  return db.prepare(`SELECT * FROM runners WHERE token = ?`).get(token) as Runner | undefined;
}

export function getRunnerForUser(userId: string, teamId: string): Runner | undefined {
  return db.prepare(`SELECT * FROM runners WHERE user_id = ? AND team_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1`).get(userId, teamId) as Runner | undefined;
}

export function updateRunnerStatus(id: string, status: string) {
  db.prepare(`UPDATE runners SET status = ?, last_seen_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function updateRunnerCwd(id: string, cwd: string) {
  db.prepare(`UPDATE runners SET cwd = ? WHERE id = ?`).run(cwd, id);
}

export function upsertRunnerDirectory(runnerId: string, name: string, relativePath: string, description: string | null) {
  db.prepare(`
    INSERT INTO runner_directories (runner_id, name, path, description)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(runner_id, name) DO UPDATE SET path = excluded.path, description = excluded.description
  `).run(runnerId, name, relativePath, description);
}

export function getRunnerDirectories(runnerId: string): RunnerDirectory[] {
  return db.prepare(`SELECT * FROM runner_directories WHERE runner_id = ?`).all(runnerId) as RunnerDirectory[];
}

export function deleteRunnerDirectories(runnerId: string) {
  db.prepare(`DELETE FROM runner_directories WHERE runner_id = ?`).run(runnerId);
}
