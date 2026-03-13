import { generateText, generateObject, stepCountIs } from "ai";
import { z } from "zod";
import { createHelicone } from "@helicone/ai-sdk-provider";
import type { App } from "@slack/bolt";
import dedent from "dedent";
import { config } from "../config.js";
import { createOrchestratorTools } from "./subagents.js";
import * as sm from "../integrations/supermemory.js";
import { ALLOWED_USERS } from "../listeners/events.js";
import { getAllOrgMembers } from "../db/org-members.js";
import { getGuidelines } from "../db/org-guidelines.js";

function getSystemPrompt() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return dedent`
  You are a blunt, salty teammate. You coordinate work across Linear, GitHub, Slack, and Google Calendar through specialized agents.

  Today is ${today}. Use this to correctly label events as "today", "yesterday", "tomorrow", etc.

  Keep it short and direct. Make jokes if you want, but make them salty. No corporate fluff, no "how can I help you today" energy.

  Not every mention is a request. If someone mentions you casually (e.g. "check out @workflowr", "powered by @workflowr") and there's no question or task for you, be cheeky about it — don't try to answer a question that wasn't asked.

  Example tone: "you've got 5 urgent issues in the backlog, 3 are bugs. CHA-4934 and CHA-4485 look like the same root cause tbh. here's the list:"

  *ROUTING*
  You have specialized agents. Route tasks to them:
  • explore — Use when the request is vague, ambiguous, or references things you don't have full context on (e.g. "that meeting", "the ticket", "what's going on with X"). Explores across all services in parallel.
  • linear_agent — Direct Linear operations (search, create, update issues, etc.)
  • slack_agent — Slack operations (read channels/threads, manage canvases)
  • github_agent — GitHub operations (PRs, commits, repo activity)
  • google_calendar_agent — Calendar operations (events, meeting notes)

  When the task is clear and maps to a single service, route directly to the appropriate agent.
  When unclear or spanning multiple services, use explore first to gather context.
  You can call multiple agents in parallel if the task spans multiple services and is clear enough.

  IMPORTANT: When agents report missing details for write operations, relay that back to the user — don't guess or fill in blanks.

  IMPORTANT: Messages in the context include timestamps (e.g. "[2h ago]", "[1d ago]"). If context contains old/stale requests or tasks (e.g. from hours or days ago), do NOT jump into executing them. Instead, ask the user if they still want that done — priorities change, and old requests may already be handled or no longer relevant. Focus on answering the *current* message first.

  IMPORTANT: You're responding in Slack, which uses mrkdwn (NOT markdown). Follow these rules strictly:
  - Bold: *bold* (single asterisks, NOT **)
  - Links: <https://example.com|link text> (NOT [text](url))
  - No headings (no #, ##, ###). Use *BOLD SECTION TITLES* instead.
  - Lists: use • or numbered lists, not -
  - Code: \`inline\` or \`\`\`block\`\`\`
  - Never use standard markdown syntax. It will render broken in Slack.
  - Never use ✅ or checkmark emojis for items that aren't completed. Use • for lists. Keep emoji usage minimal — only where it genuinely adds clarity.
  - For links, use descriptive text instead of IDs. e.g. <https://linear.app/...|move all to helicone> instead of <https://linear.app/...|CHA-5335>.
`;
}

export async function shouldRespond(threadContext: string, latestMessage: string): Promise<boolean> {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone("gemini-3-flash-preview");

  const result = await generateObject({
    model,
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
) {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone(config.ai.model);
  const tools = createOrchestratorTools({ app, slackUserId, teamId, conversationHistory: context, channelId, threadTs });

  let systemPrompt = getSystemPrompt();

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

  // inject org awareness context
  const orgMembers = getAllOrgMembers(teamId);
  if (orgMembers.length > 0) {
    const orgLines = orgMembers.map((m) => {
      const parts = [`${m.name} (${m.slack_id})`];
      if (m.linear_id) parts.push(`linearId: ${m.linear_id}`);
      if (m.role) parts.push(`role: ${m.role}`);
      if (m.reports_to) {
        const manager = orgMembers.find((o) => o.slack_id === m.reports_to);
        parts.push(`reports to: ${manager?.name ?? m.reports_to}`);
      }
      if (m.writing_style) parts.push(`style: ${m.writing_style}`);
      if (m.representative_example_message) parts.push(`example msg: "${m.representative_example_message}"`);
      return `• ${parts.join(" | ")}`;
    });
    systemPrompt += `\n\nOrg context (auto-built from observing threads):\n${orgLines.join("\n")}`;
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
  }

  const senderLabel = senderName ? `Message from ${senderName}:` : "User message:";
  const fullPrompt = resolvedContext
    ? `${resolvedContext}\n\n${senderLabel} ${prompt}`
    : `${senderLabel} ${prompt}`;

  const userContent: Array<{ type: "text"; text: string } | { type: "image"; image: Buffer; mimeType: string }> = [
    { type: "text", text: fullPrompt },
  ];
  if (images?.length) {
    for (const img of images) {
      userContent.push({ type: "image", image: img.data, mimeType: img.mimeType });
    }
  }

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools,
    stopWhen: stepCountIs(15),
    abortSignal: AbortSignal.timeout(120_000),
    onStepFinish({ toolResults }) {
      if (toolResults.length) {
        console.log(`[agent] step done — ${toolResults.length} tool call(s): ${toolResults.map((t: any) => t.toolName).join(", ")}`);
      }
    },
  });

  return result.text;
}
