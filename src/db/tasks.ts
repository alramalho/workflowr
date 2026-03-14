import db from "./index.js";

export interface Task {
  id: number;
  user_id: string;
  team_id: string | null;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TaskStep {
  id: number;
  task_id: number;
  parent_step_id: number | null;
  title: string;
  instructions: string;
  type: string;
  schedule: string | null;
  tools_needed: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// --- Tasks ---

export function createTask(userId: string, title: string, opts?: { teamId?: string; description?: string }): Task {
  const result = db.prepare(
    `INSERT INTO tasks (user_id, team_id, title, description) VALUES (?, ?, ?, ?)`,
  ).run(userId, opts?.teamId ?? null, title, opts?.description ?? null);
  return getTask(result.lastInsertRowid as number)!;
}

export function getTask(id: number): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
}

export function getUserTasks(userId: string, teamId?: string): Task[] {
  if (teamId) {
    return db.prepare(
      `SELECT * FROM tasks WHERE user_id = ? AND team_id = ? AND status != 'deleted' ORDER BY created_at DESC`,
    ).all(userId, teamId) as Task[];
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`,
  ).all(userId) as Task[];
}

export function updateTask(id: number, fields: Partial<Pick<Task, "title" | "description" | "status">>): Task | undefined {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (sets.length === 0) return getTask(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getTask(id);
}

export function deleteTask(id: number) {
  db.prepare(`DELETE FROM task_steps WHERE task_id = ?`).run(id);
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// --- Task Steps ---

export function createTaskStep(
  taskId: number,
  title: string,
  instructions: string,
  opts?: { parentStepId?: number; type?: string; schedule?: string; toolsNeeded?: string[] },
): TaskStep {
  const result = db.prepare(
    `INSERT INTO task_steps (task_id, parent_step_id, title, instructions, type, schedule, tools_needed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    opts?.parentStepId ?? null,
    title,
    instructions,
    opts?.type ?? "action",
    opts?.schedule ?? null,
    JSON.stringify(opts?.toolsNeeded ?? []),
  );
  return getTaskStep(result.lastInsertRowid as number)!;
}

export function getTaskStep(id: number): TaskStep | undefined {
  return db.prepare(`SELECT * FROM task_steps WHERE id = ?`).get(id) as TaskStep | undefined;
}

export function getTaskSteps(taskId: number): TaskStep[] {
  return db.prepare(
    `SELECT * FROM task_steps WHERE task_id = ? ORDER BY parent_step_id NULLS FIRST, id ASC`,
  ).all(taskId) as TaskStep[];
}

export function getActivecronSteps(): TaskStep[] {
  return db.prepare(
    `SELECT ts.* FROM task_steps ts
     JOIN tasks t ON ts.task_id = t.id
     WHERE ts.type = 'cron' AND ts.status = 'active' AND t.status = 'active'
     AND ts.schedule IS NOT NULL`,
  ).all() as TaskStep[];
}

export function updateTaskStep(id: number, fields: Partial<Pick<TaskStep, "title" | "instructions" | "type" | "schedule" | "status">> & { toolsNeeded?: string[] }): TaskStep | undefined {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title); }
  if (fields.instructions !== undefined) { sets.push("instructions = ?"); vals.push(fields.instructions); }
  if (fields.type !== undefined) { sets.push("type = ?"); vals.push(fields.type); }
  if (fields.schedule !== undefined) { sets.push("schedule = ?"); vals.push(fields.schedule); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.toolsNeeded !== undefined) { sets.push("tools_needed = ?"); vals.push(JSON.stringify(fields.toolsNeeded)); }
  if (sets.length === 0) return getTaskStep(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE task_steps SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getTaskStep(id);
}

export function deleteTaskStep(id: number) {
  // re-parent children to this step's parent
  const step = getTaskStep(id);
  if (step) {
    db.prepare(`UPDATE task_steps SET parent_step_id = ? WHERE parent_step_id = ?`).run(step.parent_step_id, id);
  }
  db.prepare(`DELETE FROM task_steps WHERE id = ?`).run(id);
}

export function getTaskForStep(stepId: number): Task | undefined {
  const step = getTaskStep(stepId);
  if (!step) return undefined;
  return getTask(step.task_id);
}
