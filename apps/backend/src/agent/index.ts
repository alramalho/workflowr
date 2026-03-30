import { stepCountIs } from "ai";
import { generateText, generateObject } from "../utils/ai.js";
import { z } from "zod";
import type { App } from "@slack/bolt";
import dedent from "dedent";
import { config } from "../config.js";
import { createOrchestratorTools } from "./subagents.js";
import { ArtifactStore } from "./artifacts.js";
import * as sm from "../integrations/supermemory.js";
import { ALLOWED_USERS } from "../listeners/events.js";
import { getAllOrgMembers, getOrgMemberBySlackId } from "../db/org-members.js";
import { getTeamsForMember } from "../db/teams.js";
import { getGuidelines } from "../db/org-guidelines.js";
import { getUserTasks, getTaskSteps } from "../db/tasks.js";
import { persistStepMessages } from "../queues/step-persistence.js";

function getSystemPrompt() {
  const now = new Date();
  const today = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return dedent`
  You are a blunt, salty teammate. You coordinate work across Linear, GitHub, Slack, and Google Calendar through specialized agents.

  Today is ${today}, ${timeStr}, Week ${weekNumber} of the year. Use this to correctly label events as "today", "yesterday", "tomorrow", etc.

  Keep it short and direct. Make jokes if you want, but make them salty. No corporate fluff, no "how can I help you today" energy.

  Not every mention is a request. If someone mentions you casually (e.g. "check out @workflowr", "powered by @workflowr") and there's no question or task for you, be cheeky about it — don't try to answer a question that wasn't asked.

  Example tone: "you've got 5 urgent issues in the backlog, 3 are bugs. CHA-4934 and CHA-4485 look like the same root cause tbh. here's the list:"

  *TASKS*
  You help users set up persistent tasks — high-level goals you help them accomplish over time (e.g. "Help me manage the AI team", "Remind me of un-followed-up conversations").
  You have task_* tools to create tasks and add steps. When a user describes a workflow they want automated:
  1. Create a task with a clear title
  2. Ask clarifying questions to understand what exactly they need (sources, destinations, cadence, conditions)
  3. Propose steps (cron, trigger, action, check) and get explicit confirmation before activating each
  4. Steps with type 'cron' will automatically run on schedule once activated
  Users can see their tasks via /my-workflowr

  *CONFIDENCE FIRST*
  You have a confidence_check tool. Use it to assess whether you can resolve the request BEFORE doing anything else.
  Your confidence level gates your next move:
  • *high* → you understand exactly what's needed and have the context. Execute with the right agents.
  • *medium* → you have a rough idea but gaps remain. Explore freely (read Slack channels, search Linear, check GitHub) to build confidence, then confidence_check again.
  • *low* → you're guessing. Ask the user. Batch all questions into one message. Don't partially execute and then ask.

  Use confidence_check to think things through — before your first action, after getting exploration results back, or whenever there are multiple reasonable paths forward. Don't chain tool calls on autopilot; pause and think when the next step isn't obvious.
  confidence_check returns a secondOpinion from an adviser — a gentle nudge, not a command. Consider it, but don't flip your plan unless it raises something you genuinely missed.
  You can explore as much as you want to build confidence, but never deliver results you're not confident in.

  *LEARN FROM RESOLUTIONS*
  After resolving ambiguity — whether through exploration or user answers — save the key context to memory via memory_add (e.g. "AI team works in Linear project X and repos Y, Z", "weekly report for Alex = Linear + GitHub activity"). Next time, your memories will fill the gap and you can skip the exploration.

  *CORRECTIONS = LEARNING OPPORTUNITIES*
  When the user pushes back, says you got something wrong, or asks "are you sure about X?":
  1. Don't just re-query with a tweak — figure out WHY you were wrong (wrong data? wrong assumption? missing domain knowledge?)
  2. If it's a domain knowledge gap (e.g. you don't know what "workflows" means in the product), use codebase_explore or explore to investigate
  3. If exploration doesn't fully resolve it, ask specific questions — say what you found and what you're still unsure about. Don't guess.
  4. Once resolved, ALWAYS save the correction as memory: what you got wrong + what's actually correct. This prevents the same mistake next time.

  *ROUTING*
  You have specialized agents. Route tasks to them:
  • explore — Use when you need to investigate across services to build confidence. Searches Linear, Slack, GitHub, Calendar, and database in parallel. Returns findings with confidence level and open questions.
  • codebase_explore — Explore product code to understand domain concepts, data models, business logic (e.g. "what counts as a workflow", "how is v3 determined"). Heavyweight (~1-3 min). Use when domain knowledge is genuinely missing.
  • linear_agent — Direct Linear operations (search, create, update issues, etc.)
  • slack_agent — Slack operations (read channels/threads, manage canvases)
  • github_agent — GitHub operations (PRs, commits, repo activity)
  • google_calendar_agent — Calendar operations (events, meeting notes)
  • database_agent — Direct database queries

  When the task is clear and maps to a single service, route directly to the appropriate agent.
  When unclear or spanning multiple services, use explore first to gather context.
  You can call multiple agents in parallel if the task spans multiple services and is clear enough.

  IMPORTANT: When agents report missing details for write operations, relay that back to the user — don't guess or fill in blanks.

  IMPORTANT: When database_agent returns results, it includes an "internals" field with tables, fields, and query logic. Always include this in your response (formatted as a brief collapsed/secondary section) so technical users can verify correctness. Example format:
  > _Internals: counted \`cx_tickets\` rows where \`organization_name\` = 'turbogrün GmbH' and \`created_at\` > 30 days ago_

  *ARTIFACTS*
  When database_agent returns an artifactId, the full result set is stored as a downloadable file (e.g. CSV).
  If the user would benefit from the file (tabular data, large lists, etc.), ask slack_agent to upload it: "Upload artifact {artifactId} to the current thread". The slack_upload_file tool accepts an artifactId directly.
  If the text summary alone answers the question, skip the file upload — not every query needs a file.
  IMPORTANT: Once you've uploaded a file via slack_agent, do NOT repeat or summarize the data in your text response — the file is already visible. Just add a brief comment (e.g. "here's the breakdown") and the internals. Avoid markdown tables or top-N previews when the file already contains the data.

  IMPORTANT: When you store a memory via memory_add, always append a short quote at the end of your response summarizing what was stored. If the result includes toolRules, mention which tools the rule will apply to. Example formats:
  > _Remembered (user): Alex prefers issues assigned to CX team by default_
  > _Remembered (user, applies to: slack_agent): format slack threads as 'alex [said](link) something'_

  IMPORTANT: Messages in the context include timestamps (e.g. "[2h ago]", "[1d ago]"). If context contains old/stale requests or tasks (e.g. from hours or days ago), do NOT jump into executing them. Instead, ask the user if they still want that done — priorities change, and old requests may already be handled or no longer relevant. Focus on answering the *current* message first.

  IMPORTANT: You're responding in Slack, which uses mrkdwn (NOT markdown). Follow these rules strictly:
  - Bold: *bold* (single asterisks, NOT **)
  - Links: <https://example.com|link text> (NOT [text](url))
  - No headings (no #, ##, ###). Use *BOLD SECTION TITLES* instead.
  - Lists: use • or numbered lists, not -
  - Code: \`inline\` or \`\`\`block\`\`\`
  - Tables: use standard markdown table syntax (| header | ... | with --- separator row). They will be auto-converted to native Slack tables.
  - Never use other standard markdown syntax. It will render broken in Slack.
  - Never use ✅ or checkmark emojis for items that aren't completed. Use • for lists. Keep emoji usage minimal — only where it genuinely adds clarity.
  - For links, use descriptive text instead of IDs. e.g. <https://linear.app/...|move all to helicone> instead of <https://linear.app/...|CHA-5335>.
`;
}

export async function shouldRespond(threadContext: string, latestMessage: string): Promise<boolean> {
  const result = await generateObject({
    model: "google/gemini-3-flash-preview",
    schema: z.object({ shouldRespond: z.boolean() }),
    prompt: dedent`
      You are a gating mechanism for a Slack bot that was mentioned or is listening in a thread.
      Decide if the latest message requires a response from the bot.

      Respond YES if: the message is a question, request, or task directed at the bot.
      Respond NO if: the bot is only mentioned as attribution or credit (e.g. "powered by @bot"), the message is an acknowledgment (e.g. "ok", "thanks", "got it"), the user is talking to someone else, or there's nothing actionable for the bot.

      Thread context:
      ${threadContext}

      Latest message:
      ${latestMessage}
    `,
  });

  return result.object.shouldRespond;
}

export interface AgentResult {
  text: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  latencyMs: number;
}

const TOOL_STATUS_LABELS: Record<string, string> = {
  confidence_check: "thinking...",
  explore: "exploring...",
  linear_agent: "checking Linear...",
  slack_agent: "reading Slack...",
  github_agent: "checking GitHub...",
  google_calendar_agent: "checking calendar...",
  database_agent: "querying the database...",
  notion_agent: "searching Notion...",
  codebase_explore: "exploring codebase...",
  claude_code: "running Claude Code...",
  remember: "memorizing...",
  recall: "recalling memories...",
};

function toolStatusLabel(toolName: string): string {
  if (toolName.startsWith("task_")) return "managing tasks...";
  return TOOL_STATUS_LABELS[toolName] ?? "working...";
}

export async function runAgent(
  app: App,
  prompt: string,
  context?: string,
  slackUserId?: string,
  teamId?: string,
  senderName?: string,
  images?: { data: Buffer; mimeType: string }[],
  channelId?: string,
  threadTs?: string,
  onStatusUpdate?: (status: string) => void,
  files?: { data: Buffer; mimeType: string; name: string }[],
  jobId?: string,
  recoveryMessages?: any[],
): Promise<AgentResult> {
  const startTime = Date.now();
  const model = config.ai.model;
  const toolHistory: { tool: string; input: unknown; output: unknown }[] = [];
  const artifacts = new ArtifactStore();
  const tools = createOrchestratorTools({ app, slackUserId, teamId, conversationHistory: context, channelId, threadTs, toolHistory, artifacts });

  let systemPrompt = getSystemPrompt();

  if (channelId) {
    const isDM = channelId.startsWith("D");
    systemPrompt += `\n\nCurrent conversation: ${isDM ? "DM" : `channel ${channelId}`}${threadTs ? `, thread ${threadTs}` : ""}`;
  }

  // proactive memory retrieval
  if (config.ai.supermemoryApiKey && slackUserId) {
    try {
      const tags = [sm.userTag(slackUserId)];
      if (teamId) tags.push(sm.orgTag(teamId));
      const results = await sm.searchMemories(prompt, tags, 5);
      if (results.length > 0) {
        const memories = results
          .map((r) => {
            const text = r.chunks?.map((c) => c.content).join(" ") ?? r.summary ?? r.title;
            return `- ${text}`;
          })
          .join("\n");
        systemPrompt += `\n\nRelevant memories:\n${memories}`;
      }
    } catch (e) {
      console.error("Memory retrieval failed:", e);
    }
  }

  if (!config.ai.supermemoryApiKey) {
    systemPrompt += `\n\nYou do NOT have memory capabilities. You cannot remember anything across conversations. If a user asks you to remember something, be honest and tell them memory is not set up yet.`;
  }

  // inject org awareness context
  const allMembers = getAllOrgMembers(teamId);
  const orgMembers = allMembers.filter((m) => !m.is_external);
  if (orgMembers.length > 0) {
    const orgLines = orgMembers.map((m) => {
      const parts = [`${m.name} (${m.slack_id})`];
      if (m.linear_id) parts.push(`linearId: ${m.linear_id}`);
      if (m.role) parts.push(`role: ${m.role}`);
      if (m.reports_to) {
        const manager = orgMembers.find((o) => o.slack_id === m.reports_to);
        parts.push(`reports to: ${manager?.name ?? m.reports_to}`);
      }
      const memberTeams = getTeamsForMember(m.id);
      if (memberTeams.length > 0) {
        const teamsStr = memberTeams.map((t) => {
          const tools = t.tools ? JSON.parse(t.tools) as string[] : [];
          return tools.length > 0 ? `${t.name} (tools: ${tools.join(", ")})` : t.name;
        }).join(", ");
        parts.push(`teams: ${teamsStr}`);
      }
      if (m.problem_to_solve) parts.push(`solving: ${m.problem_to_solve}`);
      if (m.writing_style) parts.push(`style: ${m.writing_style}`);
      if (m.representative_example_message) parts.push(`example msg: "${m.representative_example_message}"`);
      return `• ${parts.join(" | ")}`;
    });
    systemPrompt += `\n\nOrg context (auto-built from observing threads):\n${orgLines.join("\n")}`;
  }

  // inject active tasks context
  if (slackUserId) {
    const userTasks = getUserTasks(slackUserId, teamId ?? undefined).filter((t) => t.status === "active");
    if (userTasks.length > 0) {
      const taskLines = userTasks.map((t) => {
        const steps = getTaskSteps(t.id);
        const stepSummary = steps.map((s) => `  - [${s.status}] ${s.type}${s.schedule ? ` (${s.schedule})` : ""}: ${s.title}`).join("\n");
        return `• #${t.id} ${t.title}${stepSummary ? `\n${stepSummary}` : ""}`;
      });
      systemPrompt += `\n\nUser's active tasks:\n${taskLines.join("\n")}`;
    }
  }

  // inject org guidelines
  const guidelines = getGuidelines(teamId);
  if (guidelines.length > 0) {
    const guidelineText = guidelines.map((g) => g.value).join("\n\n");
    systemPrompt += `\n\nOrg guidelines:\n${guidelineText}`;
  }

  // resolve slack user IDs to names in context
  let resolvedContext = context;
  if (resolvedContext) {
    for (const [id, name] of Object.entries(ALLOWED_USERS)) {
      resolvedContext = resolvedContext.replaceAll(`<@${id}>`, name);
    }
    // also resolve org members not in ALLOWED_USERS (e.g. external guests)
    const unresolvedIds = [...resolvedContext.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]);
    for (const id of unresolvedIds) {
      const member = getOrgMemberBySlackId(id);
      if (member?.name) {
        resolvedContext = resolvedContext.replaceAll(`<@${id}>`, member.name);
      }
    }
  }

  const senderLabel = senderName ? `Message from ${senderName}:` : "User message:";
  const fullPrompt = resolvedContext
    ? `${resolvedContext}\n\n${senderLabel} ${prompt}`
    : `${senderLabel} ${prompt}`;

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: Buffer; mimeType: string }
    | { type: "file"; data: Buffer; mediaType: string; filename: string }
  > = [
    { type: "text", text: fullPrompt },
  ];
  if (images?.length) {
    for (const img of images) {
      userContent.push({ type: "image", image: img.data, mimeType: img.mimeType });
    }
  }
  if (files?.length) {
    for (const f of files) {
      userContent.push({ type: "file", data: f.data, mediaType: f.mimeType, filename: f.name });
    }
  }

  const messages: any[] = [
    { role: "user", content: userContent },
    ...(recoveryMessages ?? []),
  ];

  if (recoveryMessages?.length) {
    console.log(`[agent] recovering from ${recoveryMessages.length} persisted messages (job ${jobId})`);
  }

  const result = await generateText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(15),
    abortSignal: AbortSignal.timeout(120_000),
    onStepFinish({ toolCalls, toolResults, response }) {
      for (const tc of toolCalls) {
        const matching = toolResults.find((tr: any) => tr.toolCallId === tc.toolCallId);
        toolHistory.push({
          tool: tc.toolName,
          input: (tc as any).input ?? (tc as any).args,
          output: matching ? ((matching as any).output ?? (matching as any).result ?? null) : null,
        });
      }
      if (toolResults.length) {
        console.log(`[agent] step done — ${toolResults.length} tool call(s): ${toolResults.map((t: any) => t.toolName).join(", ")}`);
      }
      if (onStatusUpdate && toolCalls.length) {
        const labels = [...new Set(toolCalls.map((tc: any) => toolStatusLabel(tc.toolName)))];
        onStatusUpdate(labels.join(" "));
      }
      if (jobId && response?.messages) {
        persistStepMessages(jobId, response.messages).catch((e) =>
          console.error(`[agent] failed to persist step for job ${jobId}:`, e),
        );
      }
    },
  });

  const latencyMs = Date.now() - startTime;

  // Use toolHistory (populated by onStepFinish) instead of result.steps —
  // result.steps only reflects the final model's execution, losing tool calls
  // from before a gateway-timeout fallback.
  const toolCallRecords = toolHistory.map((h) => ({
    name: h.tool,
    input: h.input,
    output: h.output,
  }));

  return { text: result.text, toolCalls: toolCallRecords, latencyMs };
}
