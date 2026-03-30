import Redis from "ioredis";
import { config } from "./config.js";

const KEY_PREFIX = "workflowr:";

let sharedConnection: Redis | null = null;

// For direct Redis usage (step persistence, etc.) — has keyPrefix so all
// get/set calls are automatically prefixed with "workflowr:"
export function getRedis(): Redis {
  if (!sharedConnection) {
    sharedConnection = new Redis(config.redis.url, {
      keyPrefix: KEY_PREFIX,
      maxRetriesPerRequest: null,
    });
  }
  return sharedConnection;
}

// For BullMQ — no keyPrefix (BullMQ rejects it), uses its own `prefix` option instead
export function createBullMQConnection(): Redis {
  return new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });
}

export { KEY_PREFIX };
