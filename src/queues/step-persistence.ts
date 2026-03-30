import { getRedis } from "../redis.js";

const STEP_TTL = 30 * 60; // 30 minutes

function stepKey(jobId: string) {
  return `agent-steps:${jobId}`;
}

export async function persistStepMessages(jobId: string, messages: unknown[]) {
  const redis = getRedis();
  const key = stepKey(jobId);
  await redis.set(key, JSON.stringify(messages));
  await redis.expire(key, STEP_TTL);
}

export async function getPersistedStepMessages(jobId: string): Promise<any[] | null> {
  const redis = getRedis();
  const raw = await redis.get(stepKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function clearPersistedSteps(jobId: string) {
  const redis = getRedis();
  await redis.del(stepKey(jobId));
}
