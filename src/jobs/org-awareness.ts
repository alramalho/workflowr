import type { App } from "@slack/bolt";
import { generateObject } from "ai";
import { z } from "zod";
import { createHelicone } from "@helicone/ai-sdk-provider";
import dedent from "dedent";
import { config } from "../config.js";
import { getThreadReplies } from "../integrations/slack.js";
import { ALLOWED_USERS } from "../listeners/events.js";
import { isThreadLocked, markThreadRead } from "../db/thread-reads.js";
import {
  getOrgMemberBySlackId,
  createOrgMember,
  updateOrgMember,
  getAllOrgMembers,
  type OrgMember,
} from "../db/org-members.js";

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

async function extractOrgSignals(
  threadContent: string,
  existingMembers: OrgMember[],
): Promise<
  Array<{
    slackId: string;
    role?: string;
    reportsTo?: string;
    writingStyle?: string;
    representativeExampleMessage?: string;
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
              `• ${m.name} (${m.slack_id}): role=${m.role ?? "unknown"}, reportsTo=${m.reports_to ?? "unknown"}, writingStyle=${m.writing_style ?? "unknown"}, representativeExampleMessage=${m.representative_example_message ?? "unknown"}`,
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
        }),
      ),
    }),
    prompt: dedent`
      You are analyzing a Slack thread to extract organizational insights about participants.
      Only report findings you have genuine signal for from THIS thread. Do not guess.

      Existing org profiles:
      ${profilesContext}

      Thread messages:
      ${threadContent}

      For each participant where you have NEW signal, extract:

      1. role: Their job function or title. Look for signals like responsibilities mentioned,
         domain expertise shown, decisions they make. Only set if you see clear evidence.

      2. reportsTo: The slack_id of their apparent manager/lead. Look for signals like:
         asking for approval, being assigned work, deferring decisions, saying "my manager".
         Only set if there's clear evidence.

      3. writingStyle: How they communicate in 1-2 sentences. Note tone (formal/casual),
         message length, emoji usage, whether they ask questions or give directions, etc.
         ${existingMembers.some((m) => m.writing_style) ? "If there's an existing writingStyle, refine it with new observations rather than replacing entirely." : ""}

      4. representativeExampleMessage: Pick one actual message from this thread that best
         exemplifies this person's writing style. Copy it verbatim. This should capture their
         tone, casing, punctuation habits, emoji usage, etc. Only set when you also set or
         refine writingStyle.

      Rules:
      - Only include participants where you have genuine NEW signal from this thread
      - If a participant's existing profile already captures what you see, skip them
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

export function setupOrgAwareness(app: App) {
  app.event("message", async ({ event }) => {
    const msg = event as any;

    // skip bot messages, DMs, subtypes, non-allowed users
    if (msg.bot_id || msg.bot_profile) return;
    if (msg.channel_type === "im") return;
    if (msg.subtype) return;
    if (!(msg.user in ALLOWED_USERS)) return;

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

  console.log(`[org-awareness] Calling Gemini Flash for thread ${threadTs} (${replies.length} messages, ${participantIds.length} participants)`);
  const updates = await extractOrgSignals(threadContent, existingMembers);

  for (const update of updates) {
    if (!getOrgMemberBySlackId(update.slackId)) continue;

    const fields: Parameters<typeof updateOrgMember>[1] = {};
    if (update.role) fields.role = update.role;
    if (update.reportsTo) fields.reportsTo = update.reportsTo;
    if (update.writingStyle) fields.writingStyle = update.writingStyle;
    if (update.representativeExampleMessage) fields.representativeExampleMessage = update.representativeExampleMessage;

    if (Object.keys(fields).length > 0) {
      updateOrgMember(update.slackId, fields);
    }
  }
}
