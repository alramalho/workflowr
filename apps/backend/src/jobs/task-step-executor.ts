import type { App } from "@slack/bolt";
import cron from "node-cron";
import { getActivecronSteps, getTaskForStep, updateTaskStep } from "../db/tasks.js";
import { runAgent } from "../agent/index.js";
import { registerDelayedJobHandler, scheduleDelayedJob } from "../queues/delayed-jobs-queue.js";

const activeCrons = new Map<number, ReturnType<typeof cron.schedule>>();

export function setupTaskStepExecutor(app: App) {
  registerDelayedJobHandler("task_step_execute", async (_app, payload) => {
    const { stepId } = payload as { stepId: number };
    await executeStep(app, stepId);
  });

  syncCronSteps(app);
  // re-sync every 5 minutes to pick up newly activated cron steps
  setInterval(() => syncCronSteps(app), 5 * 60_000);
}

function syncCronSteps(app: App) {
  const activeSteps = getActivecronSteps();
  const activeIds = new Set(activeSteps.map((s) => s.id));

  // stop crons that are no longer active
  for (const [id, task] of activeCrons) {
    if (!activeIds.has(id)) {
      task.stop();
      activeCrons.delete(id);
    }
  }

  // start crons that aren't running yet
  for (const step of activeSteps) {
    if (activeCrons.has(step.id)) continue;
    if (!step.schedule || !cron.validate(step.schedule)) {
      console.error(`[task-steps] Invalid cron schedule for step ${step.id}: ${step.schedule}`);
      continue;
    }

    const scheduled = cron.schedule(step.schedule, () => {
      const key = `task_step_${step.id}_${Date.now()}`;
      scheduleDelayedJob("task_step_execute", key, { stepId: step.id }, new Date());
    });

    activeCrons.set(step.id, scheduled);
    console.log(`[task-steps] Scheduled cron step ${step.id}: "${step.title}" (${step.schedule})`);
  }
}

async function executeStep(app: App, stepId: number) {
  const { getTaskStep } = await import("../db/tasks.js");
  const step = getTaskStep(stepId);
  if (!step || step.status !== "active") return;

  const task = getTaskForStep(stepId);
  if (!task || task.status !== "active") return;

  console.log(`[task-steps] Executing step ${stepId}: "${step.title}" for task "${task.title}"`);

  try {
    const toolsNeeded = JSON.parse(step.tools_needed) as string[];
    const prompt = `You are executing a scheduled task step.

Task: ${task.title}
${task.description ? `Task description: ${task.description}` : ""}

Step: ${step.title}
Instructions: ${step.instructions}

Available integrations: ${toolsNeeded.length > 0 ? toolsNeeded.join(", ") : "all"}

Execute the instructions above. If you need to notify the user, DM them on Slack.`;

    const result = await runAgent(app, prompt, undefined, task.user_id, task.team_id ?? undefined);

    if (result.text) {
      await app.client.chat.postMessage({
        channel: task.user_id,
        text: `*Task step completed:* ${step.title}\n\n${result.text}`,
      });
    }
  } catch (error) {
    console.error(`[task-steps] Step ${stepId} failed:`, error);
    updateTaskStep(stepId, { status: "failed" });
    await app.client.chat.postMessage({
      channel: task.user_id,
      text: `*Task step failed:* ${step.title}\nI'll retry next time it's scheduled. Check \`/my-workflowr\` for details.`,
    }).catch(() => {});
  }
}
