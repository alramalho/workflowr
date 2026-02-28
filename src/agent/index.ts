import { generateText, generateObject, stepCountIs } from "ai";
import { z } from "zod";
import { createHelicone } from "@helicone/ai-sdk-provider";
import type { App } from "@slack/bolt";
import dedent from "dedent";
import { supermemoryTools } from "@supermemory/tools/ai-sdk";
import { config } from "../config.js";
import { createTools } from "./tools.js";

const SYSTEM_PROMPT = dedent`
  You are a blunt, salty teammate. You have access to Linear, GitHub, and Slack tools — use them when there's actual work to do. Otherwise just chat like a normal person.

  Keep it short and direct. Make jokes if you want, but make them salty. No corporate fluff, no "how can I help you today" energy.

  Example tone: "you've got 5 urgent issues in the backlog, 3 are bugs. CHA-4934 and CHA-4485 look like the same root cause tbh. here's the list:"

  IMPORTANT: You're responding in Slack, which uses mrkdwn (NOT markdown). Follow these rules strictly:
  - Bold: *bold* (single asterisks, NOT **)
  - Links: <https://example.com|link text> (NOT [text](url))
  - No headings (no #, ##, ###). Use *BOLD SECTION TITLES* instead.
  - Lists: use • or numbered lists, not -
  - Code: \`inline\` or \`\`\`block\`\`\`
  - Never use standard markdown syntax. It will render broken in Slack.
`;

export async function shouldRespond(threadContext: string, latestMessage: string): Promise<boolean> {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey });
  const model = helicone("gemini-3-flash-preview");

  const result = await generateObject({
    model,
    schema: z.object({ shouldRespond: z.boolean() }),
    prompt: dedent`
      You are a gating mechanism for a Slack bot in an active thread.
      The bot was previously mentioned and is now listening to the thread.
      Decide if the latest message requires a response from the bot.

      Respond YES if: the message is a question, request, or task directed at the bot.
      Respond NO if: the message is an acknowledgment (e.g. "ok", "thanks", "got it"), the user is talking to someone else, or there's nothing actionable for the bot.

      Thread context:
      ${threadContext}

      Latest message:
      ${latestMessage}
    `,
  });

  return result.object.shouldRespond;
}

export async function runAgent(app: App, prompt: string, context?: string) {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey });
  const model = helicone(config.ai.model);
  const tools = {
    ...createTools(app),
    ...(config.ai.supermemoryApiKey ? supermemoryTools(config.ai.supermemoryApiKey) as Record<string, any> : {}),
  };

  const fullPrompt = context ? `${context}\n\nUser message: ${prompt}` : prompt;

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: fullPrompt,
    tools,
    stopWhen: stepCountIs(15),
  });

  return result.text;
}
