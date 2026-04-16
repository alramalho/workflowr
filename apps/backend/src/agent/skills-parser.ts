import { generateObject } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";
import type { SkillTrigger, SkillAction } from "../db/skills.js";

const PARSER_MODEL = "google/gemini-3-flash-preview";

const skillSchema = z.object({
  name: z.string().describe("Short snake_case identifier for the skill (e.g. trigger_ai_evals)"),
  description: z.string().describe("One-line human-readable description of what the skill does"),
  trigger: z.object({
    type: z.enum(["keyword", "intent"]).describe("'keyword' for explicit word matches, 'intent' for semantic matching"),
    value: z.string().describe("For keyword: comma-separated trigger words. For intent: natural language description of when to trigger"),
  }),
  action: z.object({
    type: z.literal("http_request"),
    config: z.object({
      url: z.string().describe("Full URL to call"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra headers (do NOT put auth here, use auth_secret)"),
      body_template: z.string().optional().describe("JSON body template — use {{param_name}} for dynamic parameters"),
      auth_secret: z.string().optional().describe("Name of the secret to use as Bearer token (just the name, NOT the value)"),
    }),
  }),
  secrets: z.array(z.object({
    name: z.string().describe("Secret name to store (snake_case, e.g. eval_api_key)"),
    value: z.string().describe("The actual secret value extracted from the user's description"),
  })).describe("Secrets extracted from the description — these get stored separately, NEVER in the skill definition"),
});

export type ParsedSkill = z.infer<typeof skillSchema>;

export async function parseSkillDescription(description: string): Promise<ParsedSkill> {
  const result = await generateObject({
    model: PARSER_MODEL,
    schema: skillSchema,
    prompt: dedent`
      Parse the following natural language skill description into a structured skill definition.

      CRITICAL SECURITY RULES:
      1. Extract ALL sensitive values (API keys, tokens, passwords, credentials) into the "secrets" array.
      2. In the action config, reference secrets by NAME only via "auth_secret" — NEVER put actual secret values in url, headers, or body_template.
      3. If the user mentions an API key or token for authentication, set "auth_secret" to a descriptive snake_case name and add the actual value to "secrets".

      PARSING RULES:
      - Generate a concise snake_case name for the skill
      - Determine if the trigger is keyword-based (explicit words) or intent-based (semantic description)
      - For intent triggers, write a clear description of WHEN the agent should use this skill
      - Default to POST method for API triggers unless specified otherwise
      - If no body is needed, omit body_template

      User description:
      ${description}
    `,
    abortSignal: AbortSignal.timeout(15_000),
  });

  return result.object;
}
