import { tool } from "ai";
import { z } from "zod";
import {
  createTask,
  getUserTasks,
  getTask,
  updateTask,
  deleteTask,
  createTaskStep,
  getTaskSteps,
  updateTaskStep,
  deleteTaskStep,
} from "../../db/tasks.js";
import type { SubagentContext } from "./types.js";

export function createTaskTools(ctx: SubagentContext) {
  const { slackUserId, teamId } = ctx;
  if (!slackUserId) return {};

  return {
    task_create: tool({
      description: "Create a new high-level task for the user. A task is a goal the bot helps the user accomplish (e.g. 'Help Alex manage the AI team'). After creation, add steps to break it down.",
      inputSchema: z.object({
        title: z.string().describe("Short, clear title for the task"),
        description: z.string().optional().describe("Detailed description of the goal"),
      }),
      execute: async ({ title, description }) => {
        const task = createTask(slackUserId, title, { teamId, description });
        return { id: task.id, title: task.title, status: task.status };
      },
    }),

    task_list: tool({
      description: "List the user's tasks with their steps. Use to show current tasks or check what exists before creating new ones.",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = getUserTasks(slackUserId, teamId ?? undefined);
        return tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          steps: getTaskSteps(t.id).map((s) => ({
            id: s.id,
            title: s.title,
            instructions: s.instructions,
            type: s.type,
            schedule: s.schedule,
            tools_needed: JSON.parse(s.tools_needed),
            status: s.status,
            parent_step_id: s.parent_step_id,
          })),
        }));
      },
    }),

    task_update: tool({
      description: "Update a task's title, description, or status (active/paused/completed).",
      inputSchema: z.object({
        task_id: z.number().describe("ID of the task to update"),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["active", "paused", "completed"]).optional(),
      }),
      execute: async ({ task_id, title, description, status }) => {
        const task = getTask(task_id);
        if (!task) return { error: "Task not found" };
        if (task.user_id !== slackUserId) return { error: "Not your task" };
        const updated = updateTask(task_id, { title, description, status });
        return { id: updated!.id, title: updated!.title, status: updated!.status };
      },
    }),

    task_delete: tool({
      description: "Delete a task and all its steps permanently.",
      inputSchema: z.object({
        task_id: z.number().describe("ID of the task to delete"),
      }),
      execute: async ({ task_id }) => {
        const task = getTask(task_id);
        if (!task) return { error: "Task not found" };
        if (task.user_id !== slackUserId) return { error: "Not your task" };
        deleteTask(task_id);
        return { deleted: true };
      },
    }),

    task_add_step: tool({
      description: `Add a step to a task. Steps define what the bot does to fulfill the task.
Types:
• cron — runs on a schedule (requires 'schedule' field with cron expression, e.g. '0 9 * * *' for daily 9am)
• trigger — reacts to an event (describe the trigger condition in instructions)
• action — one-off action
• check — validation/verification step

Steps can be nested under a parent step to create hierarchy (subtasks).
The 'instructions' field is what the agent reads at execution time — be specific about what to do, where to read from, where to write to.
The 'tools_needed' field scopes which integrations the step needs (linear, slack, github, google_calendar).`,
      inputSchema: z.object({
        task_id: z.number().describe("ID of the parent task"),
        title: z.string().describe("Short title for this step"),
        instructions: z.string().describe("Detailed natural language instructions for execution"),
        type: z.enum(["cron", "trigger", "action", "check"]).default("action"),
        schedule: z.string().optional().describe("Cron expression (only for type=cron), e.g. '0 9 * * 1-5' for weekdays at 9am"),
        tools_needed: z.array(z.enum(["linear", "slack", "github", "google_calendar"])).default([]),
        parent_step_id: z.number().optional().describe("ID of parent step for nesting"),
        auto_confirm: z.boolean().default(false).describe("Set to true only if the user has explicitly confirmed this step"),
      }),
      execute: async ({ task_id, title, instructions, type, schedule, tools_needed, parent_step_id, auto_confirm }) => {
        const task = getTask(task_id);
        if (!task) return { error: "Task not found" };
        if (task.user_id !== slackUserId) return { error: "Not your task" };
        if (type === "cron" && !schedule) return { error: "Cron steps require a 'schedule' field" };
        const step = createTaskStep(task_id, title, instructions, {
          parentStepId: parent_step_id,
          type,
          schedule,
          toolsNeeded: tools_needed,
        });
        if (auto_confirm) {
          updateTaskStep(step.id, { status: "active" });
          return { id: step.id, title: step.title, status: "active", note: "Step activated" };
        }
        return { id: step.id, title: step.title, status: step.status, note: "Step created as pending_confirmation — ask the user to confirm before activating" };
      },
    }),

    task_update_step: tool({
      description: "Update a step's fields: title, instructions, type, schedule, status, or tools_needed. Use status='active' to activate a confirmed step, 'paused' to pause it.",
      inputSchema: z.object({
        step_id: z.number().describe("ID of the step to update"),
        title: z.string().optional(),
        instructions: z.string().optional(),
        type: z.enum(["cron", "trigger", "action", "check"]).optional(),
        schedule: z.string().optional(),
        status: z.enum(["pending_confirmation", "active", "paused", "completed", "failed"]).optional(),
        tools_needed: z.array(z.enum(["linear", "slack", "github", "google_calendar"])).optional(),
      }),
      execute: async ({ step_id, title, instructions, type, schedule, status, tools_needed }) => {
        const updated = updateTaskStep(step_id, { title, instructions, type, schedule, status, toolsNeeded: tools_needed });
        if (!updated) return { error: "Step not found" };
        return { id: updated.id, title: updated.title, status: updated.status, type: updated.type };
      },
    }),

    task_delete_step: tool({
      description: "Delete a step from a task. Children get re-parented.",
      inputSchema: z.object({
        step_id: z.number().describe("ID of the step to delete"),
      }),
      execute: async ({ step_id }) => {
        deleteTaskStep(step_id);
        return { deleted: true };
      },
    }),
  };
}
