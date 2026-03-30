import { Queue, Worker, type Job } from "bullmq";
import type { App } from "@slack/bolt";
import { createBullMQConnection, KEY_PREFIX } from "../redis.js";

type JobHandler = (app: App, payload: Record<string, unknown>) => Promise<void>;

const QUEUE_NAME = "delayed-jobs";
const handlers = new Map<string, JobHandler>();

const queueConnection = createBullMQConnection();
export const delayedJobsQueue = new Queue(QUEUE_NAME, {
  connection: queueConnection,
  prefix: KEY_PREFIX,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

export function registerDelayedJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export function scheduleDelayedJob(
  type: string,
  key: string,
  payload: Record<string, unknown>,
  runAt: Date,
) {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  const safeKey = key.replaceAll(":", "-");
  return delayedJobsQueue.add(type, { type, payload }, { jobId: safeKey, delay });
}

export function startDelayedJobsWorker(app: App) {
  const workerConnection = createBullMQConnection();

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { type, payload } = job.data as { type: string; payload: Record<string, unknown> };
      const handler = handlers.get(type);
      if (!handler) {
        throw new Error(`No handler for delayed job type "${type}"`);
      }
      await handler(app, payload);
    },
    {
      connection: workerConnection,
      prefix: KEY_PREFIX,
      concurrency: 2,
      lockDuration: 5 * 60_000,
      stalledInterval: 3 * 60_000,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[delayed-jobs] job ${job?.id} (${job?.name}) failed:`, err.message);
  });

  console.log("[delayed-jobs] worker started");
  return worker;
}
