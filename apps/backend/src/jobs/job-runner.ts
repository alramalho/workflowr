import type { App } from "@slack/bolt";
import {
  getPendingJobs,
  markRunning,
  markCompleted,
  retryOrFail,
  resetStaleJobs,
  type DelayedJob,
} from "../db/delayed-jobs.js";

type JobHandler = (
  app: App,
  payload: Record<string, unknown>,
) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const POLL_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;

export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export function startJobRunner(app: App) {
  resetStaleJobs(MAX_ATTEMPTS);

  const interval = setInterval(() => {
    pollJobs(app).catch(console.error);
  }, POLL_INTERVAL_MS);

  pollJobs(app).catch(console.error);

  return () => clearInterval(interval);
}

async function pollJobs(app: App) {
  const jobs = getPendingJobs();
  for (const job of jobs) {
    const handler = handlers.get(job.type);
    if (!handler) {
      const { markFailed } = await import("../db/delayed-jobs.js");
      markFailed(job.id, `no handler for type "${job.type}"`);
      continue;
    }
    await runJob(app, job, handler);
  }
}

async function runJob(app: App, job: DelayedJob, handler: JobHandler) {
  markRunning(job.id);
  try {
    await handler(app, JSON.parse(job.payload));
    markCompleted(job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Job ${job.id} (${job.type}) failed:`, msg);
    retryOrFail(job.id, msg, MAX_ATTEMPTS);
  }
}
