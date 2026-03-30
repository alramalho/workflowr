import { Queue, Worker, type Job } from "bullmq";
import type { App } from "@slack/bolt";
import { createBullMQConnection, KEY_PREFIX } from "../redis.js";
import { runAgent } from "../agent/index.js";
import { getPersistedStepMessages, clearPersistedSteps } from "./step-persistence.js";
import { saveBotCall, updateBotCallMessageTs } from "../db/bot-calls.js";
import { updateUsageToolCalls } from "../db/usage-log.js";
import { textToBlocksWithTable } from "../slack-table.js";

export interface AgentJobData {
  prompt: string;
  context?: string;
  slackUserId?: string;
  teamId?: string;
  senderName?: string;
  images?: { data: string; mimeType: string }[];
  files?: { data: string; mimeType: string; name: string }[];
  channelId: string;
  threadTs: string;
  replyTs: string;
  messageTs: string;
  usageLogId?: number;
}

const QUEUE_NAME = "agent-execution";

const queueConnection = createBullMQConnection();
export const agentQueue = new Queue<AgentJobData>(QUEUE_NAME, {
  connection: queueConnection,
  prefix: KEY_PREFIX,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

export function enqueueAgentJob(data: AgentJobData): Promise<Job<AgentJobData>> {
  const jobId = `${data.channelId}-${data.messageTs}`;
  return agentQueue.add("agent", data, { jobId });
}

export function startAgentWorker(app: App) {
  const workerConnection = createBullMQConnection();

  const worker = new Worker<AgentJobData>(
    QUEUE_NAME,
    async (job) => processAgentJob(job, app),
    {
      connection: workerConnection,
      prefix: KEY_PREFIX,
      concurrency: 3,
      lockDuration: 10 * 60_000, // 10 min — agent calls can take minutes
      stalledInterval: 5 * 60_000, // check stalls every 5 min
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[agent-queue] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[agent-queue] job ${job.id} completed`);
  });

  console.log("[agent-queue] worker started (concurrency: 3)");
  return worker;
}

async function processAgentJob(job: Job<AgentJobData>, app: App) {
  const { prompt, context, slackUserId, teamId, senderName, images, files, channelId, threadTs, replyTs, usageLogId } = job.data;

  const decodedImages = images?.map((i) => ({
    data: Buffer.from(i.data, "base64"),
    mimeType: i.mimeType,
  }));
  const decodedFiles = files?.map((f) => ({
    data: Buffer.from(f.data, "base64"),
    mimeType: f.mimeType,
    name: f.name,
  }));

  const recoveryMessages = await getPersistedStepMessages(job.id!);

  const onStatusUpdate = (status: string) => {
    app.client.assistant.threads
      .setStatus({ channel_id: channelId, thread_ts: threadTs, status, loading_messages: [status] })
      .catch(() => {});
  };

  try {
    const result = await runAgent(
      app,
      prompt,
      context,
      slackUserId,
      teamId,
      senderName,
      decodedImages,
      channelId,
      threadTs,
      onStatusUpdate,
      decodedFiles,
      job.id!,
      recoveryMessages ?? undefined,
    );

    await app.client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status: "" });

    const responseText = result.text || "I couldn't generate a response.";
    const tableResult = textToBlocksWithTable(responseText);
    const reply = await app.client.chat.postMessage({
      channel: channelId,
      text: responseText,
      thread_ts: replyTs,
      ...(tableResult && { blocks: tableResult.blocks }),
    });

    const callId = saveBotCall({
      callerId: slackUserId!,
      channelId,
      threadTs: replyTs,
      prompt,
      response: result.text,
      toolCalls: result.toolCalls,
      latencyMs: result.latencyMs,
    });
    if (reply.ts) updateBotCallMessageTs(callId, reply.ts);
    if (usageLogId) updateUsageToolCalls(usageLogId, result.toolCalls.length);

    await clearPersistedSteps(job.id!);
  } catch (error) {
    await app.client.assistant.threads
      .setStatus({ channel_id: channelId, thread_ts: threadTs, status: "" })
      .catch(() => {});

    // Only post error message on the final attempt
    if (job.attemptsMade >= (job.opts.attempts ?? 2)) {
      await app.client.chat
        .postMessage({
          channel: channelId,
          text: "Sorry, something went wrong while processing your request.",
          thread_ts: replyTs,
        })
        .catch(() => {});
    }

    throw error;
  }
}
