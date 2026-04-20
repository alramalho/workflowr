import type { App } from "@slack/bolt";

type Entry = { name: string | null; expires: number };
const cache = new Map<string, Entry>();
const TTL_MS = 10 * 60 * 1000;

const SLACK_ID_RE = /\b([UWCG][A-Z0-9]{7,12})\b/g;

function getCached(id: string): Entry | null {
  const entry = cache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(id);
    return null;
  }
  return entry;
}

function setCache(id: string, name: string | null) {
  cache.set(id, { name, expires: Date.now() + TTL_MS });
}

async function resolveOne(app: App, id: string): Promise<string | null> {
  try {
    if (id.startsWith("U") || id.startsWith("W")) {
      const res = await app.client.users.info({ user: id });
      const name = res.user?.profile?.display_name || res.user?.real_name;
      return name ? `@${name}` : null;
    }
    if (id.startsWith("C") || id.startsWith("G")) {
      const res = await app.client.conversations.info({ channel: id });
      const name = (res.channel as any)?.name;
      return name ? `#${name}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractSlackIds(input: unknown): string[] {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const ids = new Set<string>();
  for (const m of text.matchAll(SLACK_ID_RE)) ids.add(m[1]);
  return Array.from(ids);
}

export async function resolveSlackIds(app: App, input: unknown): Promise<Record<string, string>> {
  const ids = extractSlackIds(input);
  if (ids.length === 0) return {};

  const result: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const id of ids) {
    const cached = getCached(id);
    if (cached) {
      if (cached.name) result[id] = cached.name;
    } else {
      unresolved.push(id);
    }
  }

  const resolved = await Promise.all(
    unresolved.map(async (id) => [id, await resolveOne(app, id)] as const),
  );

  for (const [id, name] of resolved) {
    setCache(id, name);
    if (name) result[id] = name;
  }

  return result;
}
