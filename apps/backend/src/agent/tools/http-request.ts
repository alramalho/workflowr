import { tool } from "ai";
import { z } from "zod";
import { getSecret } from "../../db/secrets.js";
import type { SubagentContext } from "./types.js";

export function resolveSecrets(text: string, teamId: string): string {
  return text.replace(/\{\{secrets\.(\w+)\}\}/g, (_, name) => {
    const value = getSecret(teamId, name);
    if (!value) throw new Error(`Secret "${name}" not found. Set it with /set-secret ${name} <value>`);
    return value;
  });
}

export function createHttpRequestTools(ctx: SubagentContext) {
  return {
    http_request: tool({
      description: "Make an HTTP request to an external API. Supports authenticated requests using team secrets.",
      inputSchema: z.object({
        url: z.string().describe("Full URL to request"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default: GET)"),
        headers: z.record(z.string(), z.string()).optional().describe("Additional headers"),
        body: z.string().optional().describe("Request body (JSON string)"),
        auth_secret: z.string().optional().describe("Name of the secret to use as Bearer token (e.g. 'chatarmin_api_key')"),
      }),
      execute: async ({ url, method, headers: extraHeaders, body, auth_secret }) => {
        if (!ctx.teamId) return { error: "No team context available" };

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...extraHeaders,
        };

        if (auth_secret) {
          const token = getSecret(ctx.teamId, auth_secret);
          if (!token) return { error: `Secret "${auth_secret}" not found. Set it with /set-secret ${auth_secret} <value>` };
          headers["Authorization"] = `Bearer ${token}`;
        }

        try {
          const res = await fetch(url, {
            method: method ?? "GET",
            headers,
            body: body ?? undefined,
            signal: AbortSignal.timeout(30_000),
          });

          const contentType = res.headers.get("content-type") ?? "";
          const responseBody = contentType.includes("application/json")
            ? await res.json()
            : await res.text();

          return {
            status: res.status,
            ok: res.ok,
            body: responseBody,
          };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
  };
}
