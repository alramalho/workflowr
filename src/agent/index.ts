import { generateText, generateObject, stepCountIs } from "ai";
import { z } from "zod";
import { createHelicone } from "@helicone/ai-sdk-provider";
import type { App } from "@slack/bolt";
import dedent from "dedent";
import { config } from "../config.js";
import { createTools } from "./tools.js";
import * as sm from "../integrations/supermemory.js";
import { ALLOWED_USERS } from "../listeners/events.js";

function getSystemPrompt() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return dedent`
  You are a blunt, salty teammate. You have access to Linear, GitHub, Slack, and Google Calendar tools — use them when there's actual work to do. Otherwise just chat like a normal person.

  Today is ${today}. Use this to correctly label events as "today", "yesterday", "tomorrow", etc.

  Keep it short and direct. Make jokes if you want, but make them salty. No corporate fluff, no "how can I help you today" energy.

  Not every mention is a request. If someone mentions you casually (e.g. "check out @workflowr", "powered by @workflowr") and there's no question or task for you, be cheeky about it — don't try to answer a question that wasn't asked.

  Example tone: "you've got 5 urgent issues in the backlog, 3 are bugs. CHA-4934 and CHA-4485 look like the same root cause tbh. here's the list:"

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

export async function hasExplicitConfirmation(conversationHistory: string, action: string): Promise<{ confirmed: boolean; reason: string }> {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone("gemini-3-flash-preview");

  // cap to last 15 messages
  const lines = conversationHistory.split("\n");
  const capped = lines.slice(-15).join("\n");

  const result = await generateObject({
    model,
    schema: z.object({
      confirmed: z.boolean(),
      reason: z.string(),
    }),
    prompt: dedent`
      You are a safety gate for destructive calendar operations in a Slack bot.
      The bot is about to perform this action: ${action}

      Your job: determine if the user's intent in the conversation supports this operation.

      Return confirmed=true if ANY of these apply:
      - The user directly requested this action (e.g. "update the event", "delete the duplicate", "change the time to 3pm")
      - The user agreed to a bot suggestion (e.g. "yes", "do it", "go ahead", "sure", "yep")
      - The user's request clearly implies this action even if not word-for-word (e.g. "don't create a new one, update the existing one" implies update)

      Return confirmed=false ONLY if:
      - The user never asked for or agreed to this kind of operation
      - The action is completely unrelated to what the user discussed

      Err on the side of disallowing the action. If it's ambiguous, disallow it.

      Conversation history (last messages):
      ${capped}

      Return a short reason explaining your decision.
    `,
  });

  return result.object;
}

export async function runAgent(
  app: App,
  prompt: string,
  context?: string,
  slackUserId?: string,
  teamId?: string,
  senderName?: string,
) {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone(config.ai.model);
  const tools = createTools(app, slackUserId, teamId, context);

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

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: fullPrompt,
    tools,
    stopWhen: stepCountIs(15),
  });

  return result.text;
}
