import type { App } from "@slack/bolt";
import { generateObject } from "ai";
import { z } from "zod";
import { createHelicone } from "@helicone/ai-sdk-provider";
import dedent from "dedent";
import { config } from "../config.js";
import { getThreadReplies } from "../integrations/slack.js";
import { isThreadLocked, markThreadRead } from "../db/thread-reads.js";
import {
  getOrgMemberBySlackId,
  createOrgMember,
  updateOrgMember,
  getAllOrgMembers,
  type OrgMember,
} from "../db/org-members.js";
import { getOrgByTeamId, type Org } from "../db/orgs.js";

const MIN_MESSAGES = 3;

// Gemini 3 Flash Preview pricing ($/1M tokens)
const INPUT_PRICE_PER_M = 0.50;
const OUTPUT_PRICE_PER_M = 3.00;

async function resolveSlackName(app: App, slackId: string): Promise<string> {
  try {
    const info = await app.client.users.info({ user: slackId });
    return info.user?.real_name ?? info.user?.name ?? slackId;
  } catch {
    return slackId;
  }
}

async function ensureOrgMember(
  app: App,
  slackId: string,
  teamId?: string,
): Promise<OrgMember> {
  const existing = getOrgMemberBySlackId(slackId);
  if (existing) return existing;

  const name = await resolveSlackName(app, slackId);
  return createOrgMember(slackId, name, teamId);
}

export async function enrichOrgFromUrl(
  url: string,
): Promise<{ name: string; description: string; industry: string; location: string }> {
  const helicone = createHelicone({
    apiKey: config.ai.heliconeApiKey,
    headers: { "Helicone-Property-App": "workflowr" },
  });
  const model = helicone("gemini-3-flash-preview");

  // normalize URL and fetch page content
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  let pageText = "";
  try {
    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Workflowr/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    // strip HTML tags, scripts, styles to get raw text
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

  const result = await generateObject({
    model,
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
  });

  return result.object;
}

async function extractOrgSignals(
  threadContent: string,
  existingMembers: OrgMember[],
  org?: Org,
): Promise<
  Array<{
    slackId: string;
    role?: string;
    reportsTo?: string;
    writingStyle?: string;
    representativeExampleMessage?: string;
    isExternal?: boolean;
  }>
> {
  const helicone = createHelicone({
    apiKey: config.ai.heliconeApiKey,
    headers: { "Helicone-Property-App": "workflowr" },
  });
  const model = helicone("gemini-3-flash-preview");

  const profilesContext =
    existingMembers.length > 0
      ? existingMembers
          .map(
            (m) =>
              `• ${m.name} (${m.slack_id}): role=${m.role ?? "unknown"}, reportsTo=${m.reports_to ?? "unknown"}, writingStyle=${m.writing_style ?? "unknown"}, isExternal=${m.is_external ? "yes" : "no"}, representativeExampleMessage=${m.representative_example_message ?? "unknown"}`,
          )
          .join("\n")
      : "No existing profiles yet.";

  const result = await generateObject({
    model,
    schema: z.object({
      members: z.array(
        z.object({
          slackId: z.string(),
          role: z.string().optional(),
          reportsTo: z.string().optional(),
          writingStyle: z.string().optional(),
          representativeExampleMessage: z.string().optional(),
          isExternal: z.boolean().optional(),
        }),
      ),
    }),
    prompt: dedent`
      You are incrementally building organizational profiles from Slack threads.
      Your job is to REFINE and ADD to existing profiles, not replace them.
      Only report findings you have genuine signal for from THIS thread. Do not guess.

      ${org ? `Organization: ${org.name}${org.description ? ` — ${org.description}` : ""}${org.industry ? ` (${org.industry})` : ""}${org.location ? `, based in ${org.location}` : ""}` : "Organization: Unknown"}

      Existing org profiles:
      ${profilesContext}

      Thread messages:
      ${threadContent}

      For each participant where you have NEW signal, extract:

      1. role: Their job function or title. Look for signals like responsibilities mentioned,
         domain expertise shown, decisions they make. Only set if you see clear evidence.
         If a role already exists, KEEP IT unless you have strong contradictory evidence.
         When refining, build on the existing description (e.g. "Frontend Engineer" → "Frontend Engineer, focused on design system") rather than replacing with a synonym.

      2. reportsTo: The slack_id of their apparent manager/lead. Look for signals like:
         asking for approval, being assigned work, deferring decisions, saying "my manager".
         Only set if there's clear evidence. If already set, only change it if you see strong evidence of a different reporting line.

      3. writingStyle: How they communicate in 1-2 sentences. Note tone (formal/casual),
         message length, emoji usage, whether they ask questions or give directions, etc.
         If there's an existing writingStyle, refine it by incorporating new observations into the existing description rather than rewriting from scratch.

      4. isExternal: Whether this person is external to the organization (e.g. a client, vendor,
         partner representative, or someone from another company participating in a shared channel).
         Use the organization info above to determine who belongs and who doesn't.
         Set to true if they appear to be from outside the team. If already set, only change it with strong evidence.

      5. representativeExampleMessage: Pick one actual message from this thread that best
         exemplifies this person's writing style. Copy it verbatim. This should capture their
         tone, casing, punctuation habits, emoji usage, etc. Only set when you also set or
         refine writingStyle. If the existing example already captures their style well, don't replace it.

      Rules:
      - Only include participants where you have genuine NEW signal from this thread
      - If a participant's existing profile already captures what you see, SKIP them entirely
      - NEVER replace a field value with a mere rephrasing — only update when new information adds meaningful detail or corrects something wrong
      - For reportsTo, use the slack_id (format: U followed by alphanumeric), not the name
      - Return an empty members array if no new insights were found
    `,
  });

  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const cost =
    (inputTokens * INPUT_PRICE_PER_M + outputTokens * OUTPUT_PRICE_PER_M) /
    1_000_000;
  console.log(
    `[org-awareness] Gemini Flash: ${inputTokens} in / ${outputTokens} out — $${cost.toFixed(5)}`,
  );

  return result.object.members;
}

export async function bootstrapOrgAwareness(app: App, teamId: string): Promise<number> {
  console.log(`[org-awareness] Bootstrapping org awareness for team ${teamId}`);

  // list channels the bot is a member of
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

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // collect candidate threads with their participants
  interface CandidateThread {
    channelId: string;
    threadTs: string;
    participants: string[];
  }
  const candidates: CandidateThread[] = [];
  for (const channelId of channelIds) {
    try {
      const messages = await app.client.conversations.history({
        channel: channelId,
        limit: 100,
      });
      for (const msg of messages.messages ?? []) {
        if ((msg as any).reply_count && (msg as any).reply_count >= MIN_MESSAGES && msg.ts) {
          // use reply_users from the thread parent if available (no extra API call)
          const replyUsers = (msg as any).reply_users as string[] | undefined;
          if (replyUsers && replyUsers.length > 0) {
            candidates.push({ channelId, threadTs: msg.ts, participants: replyUsers });
          } else {
            // fallback: fetch replies
            try {
              await delay(500);
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
      await delay(300);
    } catch (e) {
      console.warn(`[org-awareness] Skipping channel ${channelId}:`, e);
    }
  }

  // greedy selection: pick threads that maximize participant diversity
  const MAX_BOOTSTRAP_THREADS = 100;
  console.log(`[org-awareness] Found ${candidates.length} candidate threads, selecting up to ${MAX_BOOTSTRAP_THREADS} for diversity`);

  // build set of known external users to deprioritize them in scoring
  const knownExternals = new Set(
    getAllOrgMembers(teamId)
      .filter((m) => m.is_external)
      .map((m) => m.slack_id),
  );

  const userSeenCount = new Map<string, number>();
  const selected: CandidateThread[] = [];

  while (selected.length < MAX_BOOTSTRAP_THREADS && candidates.length > 0) {
    // score by minimum seen count of internal participants (lower = more novel)
    // ignore known externals so they don't drive thread selection
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const internalParticipants = candidates[i].participants.filter(
        (uid) => !knownExternals.has(uid),
      );
      // skip threads with only external participants
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

  let analyzed = 0;
  for (const { channelId, threadTs } of selected) {
    try {
      await analyzeThread(app, channelId, threadTs, teamId);
      analyzed++;
      await delay(1000);
    } catch (e) {
      console.warn(`[org-awareness] Failed to analyze thread ${threadTs}:`, e);
    }
  }

  console.log(`[org-awareness] Bootstrap complete — analyzed ${analyzed} threads`);
  return analyzed;
}

export function setupOrgAwareness(app: App) {
  app.event("message", async ({ event }) => {
    const msg = event as any;

    // skip bot messages, DMs, subtypes
    if (msg.bot_id || msg.bot_profile) return;
    if (msg.channel_type === "im") return;
    if (msg.subtype) return;

    // only analyze threads (messages that are replies)
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

  // lock immediately to prevent concurrent analysis
  markThreadRead(channelId, threadTs);

  const replies = await getThreadReplies(app, channelId, threadTs);
  if (replies.length < MIN_MESSAGES) return;

  // collect unique human participants
  const participantIds = [
    ...new Set(
      replies
        .filter((r: any) => r.user && !r.bot_id && !r.bot_profile)
        .map((r: any) => r.user as string),
    ),
  ];
  if (participantIds.length === 0) return;

  // ensure all participants have org_member records
  const members = await Promise.all(
    participantIds.map((id) => ensureOrgMember(app, id, teamId)),
  );
  const memberMap = new Map(members.map((m) => [m.slack_id, m]));

  // build thread content with resolved names
  const threadContent = replies
    .filter((r: any) => r.text)
    .map((r: any) => {
      const member = memberMap.get(r.user);
      const name = member?.name ?? r.user;
      return `${name} (${r.user}): ${r.text}`;
    })
    .join("\n");

  const existingMembers = getAllOrgMembers(teamId);
  const org = teamId ? getOrgByTeamId(teamId) : undefined;

  console.log(`[org-awareness] Calling Gemini Flash for thread ${threadTs} (${replies.length} messages, ${participantIds.length} participants)`);
  const updates = await extractOrgSignals(threadContent, existingMembers, org);

  for (const update of updates) {
    if (!getOrgMemberBySlackId(update.slackId)) continue;

    const fields: Parameters<typeof updateOrgMember>[1] = {};
    if (update.role) fields.role = update.role;
    if (update.reportsTo) fields.reportsTo = update.reportsTo;
    if (update.writingStyle) fields.writingStyle = update.writingStyle;
    if (update.representativeExampleMessage) fields.representativeExampleMessage = update.representativeExampleMessage;
    if (update.isExternal !== undefined) fields.isExternal = update.isExternal;

    if (Object.keys(fields).length > 0) {
      updateOrgMember(update.slackId, fields);
    }
  }
}
