import { generateObject } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";

const PARSER_MODEL = "google/gemini-3-flash-preview";

const skillSchema = z.object({
  name: z.string().describe("Short snake_case identifier for the skill (e.g. ticket_lookup)"),
  description: z.string().describe("One-line summary of what the skill does and when to use it"),
  content: z.string().describe("Full instructions for the agent — step-by-step playbook of what to do when this skill applies. Written as clear directives."),
});

export type ParsedSkill = z.infer<typeof skillSchema>;

export async function parseSkillDescription(description: string, correction?: { previous: ParsedSkill; feedback: string }): Promise<ParsedSkill> {
  const correctionBlock = correction ? dedent`

    PREVIOUS ATTEMPT (user wants corrections):
    ${JSON.stringify(correction.previous, null, 2)}

    USER FEEDBACK:
    ${correction.feedback}

    Apply the user's corrections to the previous result. Keep everything the user didn't mention unchanged.
  ` : "";

  const result = await generateObject({
    model: PARSER_MODEL,
    schema: skillSchema,
    prompt: dedent`
      Parse the following natural language skill description into a structured skill definition.

      A skill is a playbook for an AI agent — it tells the agent what to do in a specific situation.
      - "name" is a short snake_case identifier
      - "description" is a one-line summary (shown in an index so the agent knows when to load the full skill)
      - "content" is the full step-by-step instructions the agent should follow when the skill applies

      The content should be written as clear directives to the agent, preserving all specifics from the user's description (tool names, script names, parameters, etc).

      User description:
      ${description}
      ${correctionBlock}
    `,
    abortSignal: AbortSignal.timeout(15_000),
  });

  return result.object;
}
