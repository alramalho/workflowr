import { stepCountIs } from "ai";
import { generateText, generateObject } from "../utils/ai.js";
import { z } from "zod";
import type { App } from "@slack/bolt";
import dedent from "dedent";
import { config } from "../config.js";
import { createOrchestratorTools } from "./subagents.js";
import { ArtifactStore } from "./artifacts.js";
import { checkBotConnection } from "../integrations/slack.js";
import * as sm from "../integrations/supermemory.js";
import { ALLOWED_USERS } from "../listeners/events.js";
import { findPersonBySlackId } from "../org/propagate.js";
import { getUserTasks, getTaskSteps } from "../db/tasks.js";
import { listSkills } from "../db/skills.js";
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

  *CONFIDENCE CHECK*
  You have a confidence_check tool. Use it when the request is ambiguous or spans multiple services.
  For simple/conversational messages (greetings, direct questions, single-service lookups), skip it and respond directly.
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

  *ANNOUNCEMENTS*
  Before calling a slow tool — only when you're confident the wait will be long enough that silence would leave the user wondering — call \`announce\` IN PARALLEL with a short heads-up in your own voice. Good triggers: finding a specific thread from a vague reference, multi-service investigations, deep explorations, dispatching claude_code to the daemon. Skip it for quick lookups (known IDs, direct reads, simple queries). One line, casual, no corporate fluff.

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
    schema: z.object({
      shouldRespond: z.boolean(),
      reason: z.string(),
    }),
    prompt: dedent`
      You are a gating mechanism for a Slack bot that was mentioned or is listening in a thread.
      Decide if the latest message requires a response from the bot.

      In thread context, "workflowr (you)" means the bot. Treat replies addressed to "you" after
      "workflowr (you)" has participated as potentially addressed to the bot, even without an @mention.

      Respond YES if:
      - the latest message is a question, request, correction, complaint, instruction, or task directed at the bot
      - the user tells the bot to change behavior, stop doing something, apologize, explain itself, retry, or fix a mistake
      - the latest message uses second-person wording ("you", "your", "will you", "can you") and the thread context makes the bot a plausible addressee

      Respond NO if:
      - the message is only an acknowledgment with no follow-up needed (e.g. "ok", "thanks", "got it", "lol")
      - the user is clearly talking to another human
      - the bot is only mentioned as attribution or credit (e.g. "powered by @bot")
      - there is nothing for the bot to answer or do

      Examples:
      - Context: "workflowr (you): my bad, I posted publicly"; Latest: "well dont do it again will you" => YES
      - Context: "workflowr (you): here is the report"; Latest: "thanks" => NO
      - Context: "<@U123>: can you take this?"; Latest: "yeah on it" => NO

      Thread context:
      ${threadContext}

      Latest message:
      ${latestMessage}
    `,
  });

  console.log(`[shouldRespond] ${result.object.shouldRespond ? "YES" : "NO"}: ${result.object.reason}`);
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
  onToolStep?: (step: { tools: { name: string; input: unknown; output: string }[] }) => void,
  externalAbortSignal?: AbortSignal,
): Promise<AgentResult> {
  const startTime = Date.now();

  const botConn = await checkBotConnection(app);
  if (!botConn.ok) {
    console.warn(`[agent] Slack bot disconnected (${botConn.reason}) — short-circuiting`);
    return {
      text: `Slack workspace not connected (\`${botConn.reason}\`). The bot token is invalid or the app was uninstalled — please reinstall the Slack app to reconnect.`,
      toolCalls: [],
      latencyMs: Date.now() - startTime,
    };
  }

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

  // point agent to org tree tools (don't inject full indexes — let it browse)
  if (teamId) {
    systemPrompt += `\n\nYou have org knowledge tools (org_ls, org_cat, org_grep) to browse the organization tree. The tree has: people/, people/external/, teams/, overview.mdx.
Every directory has an _index.mdx file with a summary table of all entries — use org_cat on _index.mdx files to get structured overviews instead of listing individual files.
Each person has a "confidence" field (high/medium/low). Low confidence means the person was seen in Slack but has no confirmed role or team — they may be inactive, a bot, or just not yet profiled. When answering questions about org size or team composition, distinguish between high-confidence confirmed members and low-confidence incomplete profiles.`;
  }

  // inject custom skills context
  if (teamId) {
    const skills = listSkills(teamId);
    if (skills.length > 0) {
      const skillLines = skills.map((s) => `• ${s.name}: ${s.description}`);
      systemPrompt += `\n\n*SKILLS*\nYou have team skills available. Use the \`use_skill\` tool to load the full instructions when a situation matches:\n${skillLines.join("\n")}`;
    }
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

  // resolve slack user IDs to names in context
  let resolvedContext = context;
  if (resolvedContext) {
    for (const [id, name] of Object.entries(ALLOWED_USERS)) {
      resolvedContext = resolvedContext.replaceAll(`<@${id}>`, name);
    }
    if (teamId) {
      const unresolvedIds = [...resolvedContext.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]);
      for (const id of unresolvedIds) {
        const person = findPersonBySlackId(teamId, id);
        if (person?.frontmatter.name) {
          resolvedContext = resolvedContext.replaceAll(`<@${id}>`, person.frontmatter.name);
        }
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
    abortSignal: externalAbortSignal
      ? AbortSignal.any([externalAbortSignal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
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
      if (onToolStep && toolCalls.length) {
        const steps = toolCalls.map((tc: any) => {
          const matching = toolResults.find((tr: any) => tr.toolCallId === tc.toolCallId);
          const raw = matching ? ((matching as any).output ?? (matching as any).result ?? "") : "";
          const output = typeof raw === "string" ? raw : JSON.stringify(raw);
          return { name: tc.toolName, input: (tc as any).input ?? (tc as any).args, output: output.slice(0, 500) };
        });
        onToolStep({ tools: steps });
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
