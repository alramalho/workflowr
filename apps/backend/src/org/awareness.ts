import type { App } from "@slack/bolt";
import { generateObject } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";
import { withRetry } from "../utils/retry.js";
import { getThreadReplies } from "../integrations/slack.js";
import { isThreadLocked, markThreadRead } from "../db/thread-reads.js";
import { getOrgByTeamId, type Org } from "../db/orgs.js";
import {
  propagatePerson,
  findPersonBySlackId,
  initializeTree,
  propagateOverview,
} from "./propagate.js";
import { allFilesInDir } from "./tree.js";
import { ingestSlackThread } from "context-engine";

const MIN_MESSAGES = 3;

function extractDomainName(urlOrDomain: string): string {
  const cleaned = urlOrDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const parts = cleaned.split(".");
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
    return parts.slice(0, -2).join(".");
  }
  return parts.slice(0, -1).join(".");
}

async function resolveSlackUser(app: App, slackId: string): Promise<{ name: string; isGuest: boolean; email?: string }> {
  try {
    const info = await app.client.users.info({ user: slackId });
    const user = info.user as any;
    const name = user?.real_name ?? user?.name ?? slackId;
    const isGuest = !!(user?.is_restricted || user?.is_ultra_restricted);
    const email = user?.profile?.email as string | undefined;
    return { name, isGuest, email };
  } catch {
    return { name: slackId, isGuest: false };
  }
}

export async function ensureOrgPerson(
  app: App,
  slackId: string,
  teamId?: string,
): Promise<{ name: string; slackId: string; isExternal: boolean }> {
  if (teamId) {
    const existing = await findPersonBySlackId(teamId, slackId);
    if (existing) {
      return {
        name: existing.frontmatter.name,
        slackId,
        isExternal: !!existing.frontmatter.is_external,
      };
    }
  }

  const { name, isGuest, email } = await resolveSlackUser(app, slackId);

  let isExternal = isGuest;
  if (!isExternal && email && teamId) {
    const org = getOrgByTeamId(teamId);
    if (org?.url) {
      const orgDomain = extractDomainName(org.url);
      const emailDomain = extractDomainName(email.split("@")[1] ?? "");
      if (orgDomain && emailDomain && orgDomain.toLowerCase() !== emailDomain.toLowerCase()) {
        isExternal = true;
      }
    }
  }

  if (teamId) {
    await initializeTree(teamId);
    await propagatePerson(teamId, { slackId, name, isExternal, email });
  }

  return { name, slackId, isExternal };
}

export async function enrichOrgFromUrl(
  url: string,
): Promise<{ name: string; description: string; industry: string; location: string }> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  let pageText = "";
  try {
    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Workflowr/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);
  } catch (e) {
    console.warn(`[org-awareness] Failed to fetch ${fullUrl}:`, e);
    pageText = `(Could not fetch page content for ${url})`;
  }

  const result = await withRetry(() =>
    generateObject({
      model: "openai/gpt-5.4-mini",
      schema: z.object({
        name: z.string().describe("Company name"),
        description: z.string().describe("1-2 sentences about what the company does"),
        industry: z.string().describe("Industry or domain"),
        location: z.string().describe("HQ city and country"),
      }),
      prompt: dedent`
        Extract basic company information from this website content.
        URL: ${url}

        Page content:
        ${pageText}

        Extract:
        - name: The company name
        - description: What the company does in 1-2 sentences
        - industry: The industry or domain they operate in (e.g. "e-commerce messaging", "fintech", "SaaS")
        - location: HQ city and country (e.g. "Vienna, Austria"). If unclear, use "Unknown"

        Be concise. Do not guess — if information is not available, use "Unknown".
      `,
    }),
  );

  return result.object;
}

export async function editOrgFromInstruction(
  org: Org,
  instruction: string,
): Promise<{ name: string; description: string; industry: string; location: string }> {
  const result = await withRetry(() =>
    generateObject({
      model: "openai/gpt-5.4-mini",
      schema: z.object({
        name: z.string(),
        description: z.string(),
        industry: z.string(),
        location: z.string(),
      }),
      prompt: dedent`
        Update the organization profile based on the user's instruction.
        Only change the fields the user is asking to change. Keep everything else as-is.

        Current profile:
      - Name: ${org.name}
      - Description: ${org.description ?? "Unknown"}
      - Industry: ${org.industry ?? "Unknown"}
      - Location: ${org.location ?? "Unknown"}

      User instruction: ${instruction}

      Return the full updated profile (all 4 fields), with only the relevant ones changed.
    `,
    }),
  );

  return result.object;
}

async function runBatched<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(fn));
  }
}

export async function bootstrapOrgAwareness(app: App, teamId: string): Promise<number> {
  console.log(`[org-awareness] Bootstrapping org awareness for team ${teamId}`);

  await initializeTree(teamId);

  const channelIds: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await app.client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (ch.is_member && ch.id) channelIds.push(ch.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.log(`[org-awareness] Found ${channelIds.length} channels to scan`);

  interface CandidateThread {
    channelId: string;
    threadTs: string;
    participants: string[];
  }
  const candidates: CandidateThread[] = [];

  // scan channels in parallel batches of 5
  await runBatched(channelIds, 5, async (channelId) => {
    try {
      const messages = await app.client.conversations.history({
        channel: channelId,
        limit: 100,
      });
      for (const msg of messages.messages ?? []) {
        if ((msg as any).reply_count && (msg as any).reply_count >= MIN_MESSAGES && msg.ts) {
          const replyUsers = (msg as any).reply_users as string[] | undefined;
          if (replyUsers && replyUsers.length > 0) {
            candidates.push({ channelId, threadTs: msg.ts, participants: replyUsers });
          } else {
            try {
              const replies = await getThreadReplies(app, channelId, msg.ts);
              const participants = [
                ...new Set(
                  replies
                    .filter((r: any) => r.user && !r.bot_id && !r.bot_profile)
                    .map((r: any) => r.user as string),
                ),
              ];
              if (participants.length > 0) {
                candidates.push({ channelId, threadTs: msg.ts, participants });
              }
            } catch {
              // skip threads we can't read
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[org-awareness] Skipping channel ${channelId}:`, e);
    }
  });

  const MAX_BOOTSTRAP_THREADS = 100;
  console.log(`[org-awareness] Found ${candidates.length} candidate threads, selecting up to ${MAX_BOOTSTRAP_THREADS} for diversity`);

  // known externals from tree
  const knownExternals = new Set(
    (await allFilesInDir(teamId, "people"))
      .filter((f) => f.name !== "_index.mdx" && f.frontmatter.is_external)
      .map((f) => f.frontmatter.slack_id as string),
  );

  const userSeenCount = new Map<string, number>();
  const selected: CandidateThread[] = [];

  while (selected.length < MAX_BOOTSTRAP_THREADS && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const internalParticipants = candidates[i].participants.filter(
        (uid) => !knownExternals.has(uid),
      );
      if (internalParticipants.length === 0) {
        candidates.splice(i, 1);
        i--;
        continue;
      }
      const score = Math.min(
        ...internalParticipants.map((uid) => userSeenCount.get(uid) ?? 0),
      );
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (candidates.length === 0) break;

    const picked = candidates.splice(bestIdx, 1)[0];
    selected.push(picked);
    for (const uid of picked.participants) {
      if (!knownExternals.has(uid)) {
        userSeenCount.set(uid, (userSeenCount.get(uid) ?? 0) + 1);
      }
    }
  }

  // analyze threads in parallel batches of 5
  let analyzed = 0;
  await runBatched(selected, 5, async ({ channelId, threadTs }) => {
    try {
      await analyzeThread(app, channelId, threadTs, teamId);
      analyzed++;
    } catch (e) {
      console.warn(`[org-awareness] Failed to analyze thread ${threadTs}:`, e);
    }
  });

  console.log(`[org-awareness] Bootstrap complete — analyzed ${analyzed} threads`);
  return analyzed;
}

export function setupOrgAwareness(app: App) {
  app.event("message", async ({ event }) => {
    const msg = event as any;

    if (msg.bot_id || msg.bot_profile) return;
    if (msg.channel_type === "im") return;
    if (msg.subtype) return;

    const threadTs = msg.thread_ts;
    if (!threadTs) return;

    const channel = msg.channel;
    analyzeThread(app, channel, threadTs, msg.team).catch((e) =>
      console.error("Org awareness error:", e),
    );
  });

  console.log("Org awareness listener registered");
}

export async function analyzeThread(
  app: App,
  channelId: string,
  threadTs: string,
  teamId?: string,
) {
  if (isThreadLocked(channelId, threadTs)) return;

  console.log(`[org-awareness] Analyzing thread ${threadTs} in channel ${channelId}`);
  markThreadRead(channelId, threadTs);

  const replies = await getThreadReplies(app, channelId, threadTs);
  if (replies.length < MIN_MESSAGES) return;

  const participantIds = [
    ...new Set(
      replies
        .filter((r: any) => r.user && !r.bot_id && !r.bot_profile)
        .map((r: any) => r.user as string),
    ),
  ];
  if (participantIds.length === 0) return;

  // ensure all participants exist in the tree
  const personMap = new Map<string, { name: string; slackId: string; isExternal: boolean }>();
  for (const id of participantIds) {
    const person = await ensureOrgPerson(app, id, teamId);
    personMap.set(id, person);
  }

  if (!teamId) return;

  const org = getOrgByTeamId(teamId);
  console.log(`[org-awareness] Ingesting thread ${threadTs} into context engine (${replies.length} messages, ${participantIds.length} participants)`);
  await ingestSlackThread({
    teamId,
    channelId,
    threadTs,
    org: org
      ? {
          name: org.name,
          url: org.url ?? undefined,
          description: org.description ?? undefined,
          industry: org.industry ?? undefined,
          location: org.location ?? undefined,
        }
      : undefined,
    participants: [...personMap.values()],
    messages: replies
      .filter((r: any) => r.user && r.text)
      .map((r: any) => {
        const person = personMap.get(r.user);
        return {
          slackId: r.user as string,
          name: person?.name ?? r.user,
          text: r.text as string,
          ts: r.ts as string | undefined,
        };
      }),
  });
}
