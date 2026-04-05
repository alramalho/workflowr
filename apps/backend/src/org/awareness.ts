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
  type PersonSignal,
} from "./propagate.js";
import { allFilesInDir } from "./tree.js";

const MIN_MESSAGES = 3;
const MAX_TEAM_NAME_LENGTH = 30;
const TEAM_NAME_RE = /^[A-Za-z][A-Za-z0-9 &\-/]+$/;

function isValidTeamName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEAM_NAME_LENGTH) return false;
  if (!TEAM_NAME_RE.test(trimmed)) return false;
  if (/^(slackId|role|teams|reportsTo|writingStyle|isExternal|representativeExampleMessage|unknown)/i.test(trimmed)) return false;
  return true;
}

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
    const existing = findPersonBySlackId(teamId, slackId);
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
    initializeTree(teamId);
    propagatePerson(teamId, { slackId, name, isExternal, email });
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

interface ExistingProfile {
  slackId: string;
  name: string;
  role?: string;
  reportsTo?: string;
  writingStyle?: string;
  representativeExampleMessage?: string;
  isExternal: boolean;
  teams: string[];
}

function getExistingProfiles(teamId: string): ExistingProfile[] {
  const people = allFilesInDir(teamId, "people").filter((f) => f.name !== "_index.mdx");
  return people.map((p) => ({
    slackId: p.frontmatter.slack_id,
    name: p.frontmatter.name,
    role: p.frontmatter.role,
    reportsTo: p.frontmatter.reports_to,
    writingStyle: p.frontmatter.writing_style,
    representativeExampleMessage: p.frontmatter.representative_example_message,
    isExternal: !!p.frontmatter.is_external,
    teams: (p.frontmatter.teams as string[] | undefined) ?? [],
  }));
}

async function extractOrgSignals(
  threadContent: string,
  existingMembers: ExistingProfile[],
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
          .map((m) => {
            const teamsStr = m.teams.length > 0 ? m.teams.join(", ") : "unknown";
            const style = (m.writingStyle ?? "unknown").slice(0, 200);
            const example = (m.representativeExampleMessage ?? "unknown").slice(0, 200);
            return `• ${m.name} (${m.slackId}): role=${m.role ?? "unknown"}, teams=${teamsStr}, reportsTo=${m.reportsTo ?? "unknown"}, writingStyle=${style}, isExternal=${m.isExternal ? "yes" : "no"}, representativeExampleMessage=${example}`;
          })
          .join("\n")
      : "No existing profiles yet.";

  const existingTeams = allFilesInDir(org ? String(org.team_id) : "", "teams")
    .filter((f) => f.name !== "_index.mdx")
    .map((t) => t.frontmatter.name as string);
  const teamsContext = existingTeams.length > 0
    ? `\nKnown teams: ${existingTeams.join(", ")}`
    : "";

  const result = await withRetry(() =>
    generateObject({
      model: "openai/gpt-5.4-mini",
      abortSignal: AbortSignal.timeout(30_000),
      schema: z.object({
        members: z.array(
          z.object({
            slackId: z.string(),
            role: z.string().nullable(),
            reportsTo: z.string().nullable(),
            writingStyle: z.string().nullable(),
            representativeExampleMessage: z.string().nullable(),
            isExternal: z.boolean().nullable(),
            teams: z.array(z.string()).nullable(),
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
  console.log(`[org-awareness] ${inputTokens} in / ${outputTokens} out tokens`);

  // coerce nulls to undefined for downstream consumers
  return result.object.members.map((m) => ({
    slackId: m.slackId,
    role: m.role ?? undefined,
    reportsTo: m.reportsTo ?? undefined,
    writingStyle: m.writingStyle ?? undefined,
    representativeExampleMessage: m.representativeExampleMessage ?? undefined,
    isExternal: m.isExternal ?? undefined,
    teams: m.teams ?? undefined,
  }));
}

async function runBatched<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(fn));
  }
}

export async function bootstrapOrgAwareness(app: App, teamId: string): Promise<number> {
  console.log(`[org-awareness] Bootstrapping org awareness for team ${teamId}`);

  initializeTree(teamId);

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
    allFilesInDir(teamId, "people")
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
  const personMap = new Map<string, { name: string; slackId: string }>();
  for (const id of participantIds) {
    const person = await ensureOrgPerson(app, id, teamId);
    personMap.set(id, person);
  }

  const threadContent = replies
    .filter((r: any) => r.text)
    .slice(0, 30) // cap at 30 messages to keep payload reasonable
    .map((r: any) => {
      const person = personMap.get(r.user);
      const name = person?.name ?? r.user;
      return `${name} (${r.user}): ${r.text}`;
    })
    .join("\n");

  const existingMembers = teamId ? getExistingProfiles(teamId) : [];
  const org = teamId ? getOrgByTeamId(teamId) : undefined;

  console.log(`[org-awareness] Extracting signals for thread ${threadTs} (${replies.length} messages, ${participantIds.length} participants)`);
  const updates = await extractOrgSignals(threadContent, existingMembers, org);

  if (!teamId) return;

  for (const update of updates) {
    const existing = findPersonBySlackId(teamId, update.slackId);
    if (!existing) continue;

    const overrides: Record<string, boolean> = existing.frontmatter.user_overrides ?? {};
    const signal: PersonSignal = {
      slackId: update.slackId,
      name: existing.frontmatter.name,
    };

    if (update.role && !overrides.role) signal.role = update.role;
    if (update.reportsTo && !overrides.reports_to) signal.reportsTo = update.reportsTo;
    if (update.writingStyle) signal.writingStyle = update.writingStyle.slice(0, 750);
    if (update.representativeExampleMessage) signal.representativeExampleMessage = update.representativeExampleMessage.slice(0, 300);
    if (update.isExternal !== undefined) signal.isExternal = update.isExternal;

    if (update.teams && update.teams.length > 0 && !overrides.teams) {
      const validTeams = update.teams.filter(isValidTeamName);
      if (validTeams.length > 0) signal.teams = validTeams;
    }

    propagatePerson(teamId, signal);
  }
}
