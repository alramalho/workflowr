import crypto from "node:crypto";
import dedent from "dedent";
import { z } from "zod";
import { generateObject } from "./ai.js";
import { ensureSchema, prisma } from "./db.js";
import { allFilesInDir, writeFile } from "./store.js";
import {
  findPersonBySlackId,
  initializeTree,
  propagatePerson,
  type OrgInfo,
  type PersonSignal,
} from "./propagate.js";

const MAX_TEAM_NAME_LENGTH = 30;
const TEAM_NAME_RE = /^[A-Za-z][A-Za-z0-9 &\-/]+$/;

export interface SlackThreadParticipant {
  slackId: string;
  name: string;
  email?: string;
  isExternal?: boolean;
}

export interface SlackThreadMessage {
  slackId: string;
  name: string;
  text: string;
  ts?: string;
}

export interface SlackThreadIngestInput {
  teamId: string;
  channelId: string;
  threadTs: string;
  org?: OrgInfo;
  participants: SlackThreadParticipant[];
  messages: SlackThreadMessage[];
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

function isValidTeamName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEAM_NAME_LENGTH) return false;
  if (!TEAM_NAME_RE.test(trimmed)) return false;
  if (/^(slackId|role|teams|reportsTo|writingStyle|isExternal|representativeExampleMessage|unknown)/i.test(trimmed)) {
    return false;
  }
  return true;
}

function threadHash(input: SlackThreadIngestInput): string {
  const raw = JSON.stringify({
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    messages: input.messages.map((message) => ({
      slackId: message.slackId,
      text: message.text,
      ts: message.ts,
    })),
  });
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

async function getExistingProfiles(teamId: string): Promise<ExistingProfile[]> {
  const people = (await allFilesInDir(teamId, "people")).filter((file) => file.name !== "_index.mdx");
  return people.map((person) => ({
    slackId: person.frontmatter.slack_id,
    name: person.frontmatter.name,
    role: person.frontmatter.role,
    reportsTo: person.frontmatter.reports_to,
    writingStyle: person.frontmatter.writing_style,
    representativeExampleMessage: person.frontmatter.representative_example_message,
    isExternal: !!person.frontmatter.is_external,
    teams: (person.frontmatter.teams as string[] | undefined) ?? [],
  }));
}

async function extractOrgSignals(
  teamId: string,
  threadContent: string,
  existingMembers: ExistingProfile[],
  org?: OrgInfo,
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
          .map((member) => {
            const teamsStr = member.teams.length > 0 ? member.teams.join(", ") : "unknown";
            const style = (member.writingStyle ?? "unknown").slice(0, 200);
            const example = (member.representativeExampleMessage ?? "unknown").slice(0, 200);
            return `- ${member.name} (${member.slackId}): role=${member.role ?? "unknown"}, teams=${teamsStr}, reportsTo=${member.reportsTo ?? "unknown"}, writingStyle=${style}, isExternal=${member.isExternal ? "yes" : "no"}, representativeExampleMessage=${example}`;
          })
          .join("\n")
      : "No existing profiles yet.";

  const existingTeams = (await allFilesInDir(teamId, "teams"))
    .filter((file) => file.name !== "_index.mdx")
    .map((team) => team.frontmatter.name as string);
  const teamsContext = existingTeams.length > 0 ? `\nKnown teams: ${existingTeams.join(", ")}` : "";

  const result = await generateObject({
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

      ${org ? `Organization: ${org.name}${org.description ? ` - ${org.description}` : ""}${org.industry ? ` (${org.industry})` : ""}${org.location ? `, based in ${org.location}` : ""}` : "Organization: Unknown"}

      Existing org profiles:
      ${profilesContext}${teamsContext}

      Thread messages:
      ${threadContent}

      For each participant where you have NEW signal, extract:
      1. role: Their job function or title. Keep existing roles unless this thread adds meaningful detail or corrects them.
      2. reportsTo: The slack_id of their apparent manager/lead. Only set with clear evidence.
      3. writingStyle: How they communicate in 1-2 sentences.
      4. isExternal: Only set if the thread strongly contradicts the current value.
      5. teams: Internal team(s), reusing known team names where possible.
      6. representativeExampleMessage: A verbatim message that exemplifies their writing style.

      Rules:
      - Only include participants where this thread adds genuine new signal.
      - Never replace a field value with a mere rephrasing.
      - For reportsTo, use the slack_id, not the name.
      - Return an empty members array if no new insights were found.
    `,
  });

  return result.object.members.map((member) => ({
    slackId: member.slackId,
    role: member.role ?? undefined,
    reportsTo: member.reportsTo ?? undefined,
    writingStyle: member.writingStyle ?? undefined,
    representativeExampleMessage: member.representativeExampleMessage ?? undefined,
    isExternal: member.isExternal ?? undefined,
    teams: member.teams ?? undefined,
  }));
}

function formatCommunicationPage(input: SlackThreadIngestInput): string {
  return input.messages
    .filter((message) => message.text.trim())
    .slice(0, 80)
    .map((message) => {
      const ts = message.ts ? ` [${message.ts}]` : "";
      return `${message.name} (${message.slackId})${ts}: ${message.text}`;
    })
    .join("\n");
}

export async function ingestSlackThread(input: SlackThreadIngestInput): Promise<{ updatedMembers: number }> {
  await ensureSchema();
  await initializeTree(input.teamId);

  for (const participant of input.participants) {
    await propagatePerson(input.teamId, {
      slackId: participant.slackId,
      name: participant.name,
      email: participant.email,
      isExternal: participant.isExternal,
    });
  }

  const hash = threadHash(input);
  await prisma.contextCommunication.upsert({
    where: { teamId_hash: { teamId: input.teamId, hash } },
    create: {
      teamId: input.teamId,
      hash,
      channelId: input.channelId,
      threadTs: input.threadTs,
      commType: "slack_thread",
      payload: JSON.stringify(input),
    },
    update: {
      channelId: input.channelId,
      threadTs: input.threadTs,
      payload: JSON.stringify(input),
    },
  });

  await writeFile(
    input.teamId,
    `communications/slack/${input.channelId}-${input.threadTs}.mdx`,
    {
      type: "slack_thread",
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      message_count: input.messages.length,
    },
    formatCommunicationPage(input),
    { entityType: "Communication", source: "slack" },
  );

  const threadContent = input.messages
    .filter((message) => message.text.trim())
    .slice(0, 30)
    .map((message) => `${message.name} (${message.slackId}): ${message.text}`)
    .join("\n");

  if (!threadContent) return { updatedMembers: 0 };

  const updates = await extractOrgSignals(
    input.teamId,
    threadContent,
    await getExistingProfiles(input.teamId),
    input.org,
  );

  let updatedMembers = 0;
  for (const update of updates) {
    const existing = await findPersonBySlackId(input.teamId, update.slackId);
    if (!existing) continue;

    const overrides: Record<string, boolean> = existing.frontmatter.user_overrides ?? {};
    const signal: PersonSignal = {
      slackId: update.slackId,
      name: existing.frontmatter.name,
    };

    if (update.role && !overrides.role) signal.role = update.role;
    if (update.reportsTo && !overrides.reports_to) signal.reportsTo = update.reportsTo;
    if (update.writingStyle) signal.writingStyle = update.writingStyle.slice(0, 750);
    if (update.representativeExampleMessage) {
      signal.representativeExampleMessage = update.representativeExampleMessage.slice(0, 300);
    }
    if (update.isExternal !== undefined) signal.isExternal = update.isExternal;

    if (update.teams && update.teams.length > 0 && !overrides.teams) {
      const validTeams = update.teams.filter(isValidTeamName);
      if (validTeams.length > 0) signal.teams = validTeams;
    }

    await propagatePerson(input.teamId, signal);
    updatedMembers++;
  }

  return { updatedMembers };
}
