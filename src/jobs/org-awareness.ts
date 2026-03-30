import type { App } from "@slack/bolt";
import { generateObject } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";
import { withRetry } from "../utils/retry.js";
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
import { setMemberTeams, getTeamsForMember, getTeamsByOrgId, getMembersByTeam } from "../db/teams.js";

const MIN_MESSAGES = 3;

// Gemini 3 Flash Preview pricing ($/1M tokens)
const INPUT_PRICE_PER_M = 0.50;
const OUTPUT_PRICE_PER_M = 3.00;

function extractDomainName(urlOrDomain: string): string {
  // "chatarmin.com" → "chatarmin", "https://www.gnosis.io" → "gnosis"
  const cleaned = urlOrDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const parts = cleaned.split(".");
  // drop TLD (and co.uk style TLDs)
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

export async function ensureOrgMember(
  app: App,
  slackId: string,
  teamId?: string,
): Promise<OrgMember> {
  const existing = getOrgMemberBySlackId(slackId);
  if (existing) return existing;

  const { name, isGuest, email } = await resolveSlackUser(app, slackId);
  const member = createOrgMember(slackId, name, teamId);

  // determine external status from guest flag + email domain match
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

  if (isExternal) {
    updateOrgMember(slackId, { isExternal: true });
    return getOrgMemberBySlackId(slackId)!;
  }
  return member;
}

export async function enrichOrgFromUrl(
  url: string,
): Promise<{ name: string; description: string; industry: string; location: string }> {
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

  const result = await withRetry(() =>
    generateObject({
      model: "google/gemini-3-flash-preview",
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

export function buildOrgChart(slackTeamId: string): string {
  const org = getOrgByTeamId(slackTeamId);
  const members = getAllOrgMembers(slackTeamId).filter((m) => !m.is_external);
  if (members.length === 0) return "_No org members found yet._";

  const teams = org ? getTeamsByOrgId(org.id) : [];
  const memberById = new Map(members.map((m) => [m.slack_id, m]));

  const lines: string[] = [];

  if (teams.length > 0) {
    for (const team of teams) {
      const teamMemberIds = getMembersByTeam(team.id);
      const teamMembers = teamMemberIds
        .map((id) => members.find((m) => m.id === id))
        .filter((m): m is OrgMember => m !== undefined);

      if (teamMembers.length === 0) continue;

      // find the lead: whoever other team members report to
      const reportedToIds = new Set(
        teamMembers.map((m) => m.reports_to).filter((r): r is string => r !== null),
      );
      const lead = teamMembers.find((m) => reportedToIds.has(m.slack_id));

      const tools = team.tools ? JSON.parse(team.tools) as string[] : [];
      const toolsStr = tools.length > 0 ? ` [${tools.join(", ")}]` : "";
      lines.push(`*${team.name}*${toolsStr}`);
      if (lead) {
        const leadsManager = lead.reports_to ? memberById.get(lead.reports_to) : undefined;
        const reportsStr = leadsManager ? ` → reports to ${leadsManager.name}` : "";
        lines.push(`  Lead: ${lead.name}${lead.role ? ` — ${lead.role}` : ""}${reportsStr}`);
        if (lead.problem_to_solve) lines.push(`    solving: ${lead.problem_to_solve}`);
      }
      for (const m of teamMembers) {
        if (m === lead) continue;
        lines.push(`  • ${m.name}${m.role ? ` — ${m.role}` : ""}`);
        if (m.problem_to_solve) lines.push(`    solving: ${m.problem_to_solve}`);
      }
      lines.push("");
    }

    // members not in any team
    const teamedMemberIds = new Set(
      teams.flatMap((t) => getMembersByTeam(t.id)),
    );
    const unassigned = members.filter((m) => !teamedMemberIds.has(m.id));
    if (unassigned.length > 0) {
      lines.push("*Unassigned*");
      for (const m of unassigned) {
        lines.push(`  • ${m.name}${m.role ? ` — ${m.role}` : ""}`);
      }
    }
  } else {
    // no teams yet — flat list
    lines.push("*Team Members*");
    for (const m of members) {
      const manager = m.reports_to ? memberById.get(m.reports_to) : undefined;
      const reportsStr = manager ? ` → reports to ${manager.name}` : "";
      lines.push(`  • ${m.name}${m.role ? ` — ${m.role}` : ""}${reportsStr}`);
    }
  }

  return lines.join("\n");
}

export async function editOrgFromInstruction(
  org: Org,
  instruction: string,
): Promise<{ name: string; description: string; industry: string; location: string }> {
  const result = await withRetry(() =>
    generateObject({
      model: "google/gemini-3-flash-preview",
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
    teams?: string[];
  }>
> {
  const profilesContext =
    existingMembers.length > 0
      ? existingMembers
          .map(
            (m) => {
              const memberTeams = getTeamsForMember(m.id);
              const teamsStr = memberTeams.length > 0 ? memberTeams.map((t) => t.name).join(", ") : "unknown";
              const style = (m.writing_style ?? "unknown").slice(0, 200);
              const example = (m.representative_example_message ?? "unknown").slice(0, 200);
              return `• ${m.name} (${m.slack_id}): role=${m.role ?? "unknown"}, teams=${teamsStr}, reportsTo=${m.reports_to ?? "unknown"}, writingStyle=${style}, isExternal=${m.is_external ? "yes" : "no"}, representativeExampleMessage=${example}`;
            },
          )
          .join("\n")
      : "No existing profiles yet.";

  const existingTeams = org
    ? getTeamsByOrgId(org.id).map((t) => t.name)
    : [];
  const teamsContext = existingTeams.length > 0
    ? `\nKnown teams: ${existingTeams.join(", ")}`
    : "";

  const result = await withRetry(() =>
    generateObject({
      model: "google/gemini-3-flash-preview",
      schema: z.object({
        members: z.array(
          z.object({
            slackId: z.string(),
            role: z.string().optional(),
            reportsTo: z.string().optional(),
            writingStyle: z.string().optional(),
            representativeExampleMessage: z.string().optional(),
            isExternal: z.boolean().optional(),
            teams: z.array(z.string()).optional(),
          }),
        ),
      }),
      prompt: dedent`
      You are incrementally building organizational profiles from Slack threads.
      Your job is to REFINE and ADD to existing profiles, not replace them.
      Only report findings you have genuine signal for from THIS thread. Do not guess.

      ${org ? `Organization: ${org.name}${org.description ? ` — ${org.description}` : ""}${org.industry ? ` (${org.industry})` : ""}${org.location ? `, based in ${org.location}` : ""}` : "Organization: Unknown"}

      Existing org profiles:
      ${profilesContext}${teamsContext}

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

      4. isExternal: Whether this person is external to the organization.
         This is mostly determined automatically from Slack guest status, so only set this if you have
         strong evidence that contradicts the current value (e.g. someone marked as internal who clearly
         works for a different company). In most cases, skip this field entirely.

      5. teams: Which internal team(s) this person belongs to (e.g. ["AI", "Engineering"], ["Success"]).
         Look for signals like: the domain they work on, channels they're active in, projects they reference.
         Use existing known teams when possible. Only create a new team name if there's clear evidence of one not yet tracked.
         If teams are already assigned and still accurate, don't include this field.

      6. representativeExampleMessage: Pick one actual message from this thread that best
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
    }),
  );

  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const reasoningTokens = (result.usage as any).outputTokenDetails?.reasoningTokens ?? (result.usage as any).reasoningTokens ?? 0;
  const textTokens = outputTokens - reasoningTokens;
  const cost =
    (inputTokens * INPUT_PRICE_PER_M + outputTokens * OUTPUT_PRICE_PER_M) /
    1_000_000;
  console.log(
    `[org-awareness] Gemini Flash: ${inputTokens} in / ${textTokens} text out + ${reasoningTokens} thinking out (${outputTokens} total out) — $${cost.toFixed(5)}`,
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
              await delay(2000);
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
      await delay(1000);
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
      await delay(2000);
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
    const member = getOrgMemberBySlackId(update.slackId);
    if (!member) continue;

    const fields: Parameters<typeof updateOrgMember>[1] = {};
    const overrides: Record<string, boolean> = member.user_overrides ? JSON.parse(member.user_overrides) : {};

    if (update.role && !overrides.role) fields.role = update.role;
    if (update.reportsTo && !overrides.reports_to) fields.reportsTo = update.reportsTo;
    if (update.writingStyle) fields.writingStyle = update.writingStyle.slice(0, 750);
    if (update.representativeExampleMessage) fields.representativeExampleMessage = update.representativeExampleMessage.slice(0, 300);
    if (update.isExternal !== undefined) fields.isExternal = update.isExternal;

    if (Object.keys(fields).length > 0) {
      updateOrgMember(update.slackId, fields);
    }

    if (update.teams && update.teams.length > 0 && org && !overrides.teams) {
      setMemberTeams(member.id, org.id, update.teams);
    }
  }
}
