import { tool } from "ai";
import { z } from "zod";
import { listSkills, parseAction, parseTrigger } from "../../db/skills.js";
import { getSecret } from "../../db/secrets.js";
import { resolveSecrets } from "./http-request.js";
import type { SubagentContext } from "./types.js";

export function createSkillTools(ctx: SubagentContext): Record<string, any> {
  if (!ctx.teamId) return {};

  const skills = listSkills(ctx.teamId);
  const result: Record<string, any> = {};

  for (const skill of skills) {
    const trigger = parseTrigger(skill);
    const action = parseAction(skill);
    const toolName = `skill_${skill.name}`;

    if (action.type === "http_request") {
      result[toolName] = tool({
        description: `Custom skill: ${skill.description}. Trigger: ${trigger.value}`,
        inputSchema: z.object({
          parameters: z.record(z.string(), z.any())
            .optional()
            .describe("Optional parameters to fill into the request body/URL template"),
        }),
        execute: async ({ parameters }) => {
          const { url, method, headers: configHeaders, body_template, auth_secret } = action.config;

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(configHeaders ?? {}),
          };

          if (auth_secret) {
            const token = getSecret(ctx.teamId!, auth_secret);
            if (!token) return { error: `Secret "${auth_secret}" not found. Set it with /set-secret ${auth_secret} <value>` };
            headers["Authorization"] = `Bearer ${token}`;
          }

          for (const [k, v] of Object.entries(headers)) {
            headers[k] = resolveSecrets(v, ctx.teamId!);
          }

          let body: string | undefined;
          if (body_template) {
            body = body_template;
            if (parameters) {
              for (const [key, val] of Object.entries(parameters)) {
                body = body.replaceAll(`{{${key}}}`, typeof val === "string" ? val : JSON.stringify(val));
              }
            }
            body = resolveSecrets(body, ctx.teamId!);
          }

          try {
            const res = await fetch(url, {
              method: method ?? "POST",
              headers,
              body: body ?? undefined,
              signal: AbortSignal.timeout(30_000),
            });

            const contentType = res.headers.get("content-type") ?? "";
            const responseBody = contentType.includes("application/json")
              ? await res.json()
              : await res.text();

            return { status: res.status, ok: res.ok, body: responseBody };
          } catch (err: any) {
            return { error: err.message };
          }
        },
      });
    }
  }

  return result;
}
