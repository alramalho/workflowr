import { generateObject } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";

export async function hasExplicitConfirmation(conversationHistory: string, action: string): Promise<{ confirmed: boolean; reason: string }> {

  const lines = conversationHistory.split("\n");
  const capped = lines.slice(-15).join("\n");

  const result = await generateObject({
    model: "google/gemini-3-flash-preview",
    schema: z.object({
      confirmed: z.boolean(),
      reason: z.string(),
    }),
    prompt: dedent`
      You are a safety gate for destructive operations in a Slack bot.
      The bot is about to perform this action: ${action}

      Your job: determine if the user's intent in the conversation supports this operation.

      Return confirmed=true if ANY of these apply:
      - The user directly requested this action (e.g. "update the event", "delete the duplicate", "change the time to 3pm", "update the canvas with the meeting notes")
      - The user agreed to a bot suggestion (e.g. "yes", "do it", "go ahead", "sure", "yep")
      - The user's request clearly implies this action even if not word-for-word (e.g. "don't create a new one, update the existing one" implies update, "pull the notes and update the canvas" implies canvas edit)

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
