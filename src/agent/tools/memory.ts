import { tool } from "ai";
import { z } from "zod";
import * as sm from "../../integrations/supermemory.js";
import { config } from "../../config.js";
import type { SubagentContext } from "./types.js";

export function createMemoryTools(ctx: SubagentContext) {
  const { slackUserId, teamId } = ctx;
  if (!config.ai.supermemoryApiKey || !slackUserId) return {};

  return {
    memory_search: tool({
      description: "Search saved memories for preferences, past decisions, or stored context",
      inputSchema: z.object({
        query: z.string().describe("What to search for in memories"),
      }),
      execute: async ({ query }) => {
        const tags = [sm.userTag(slackUserId)];
        if (teamId) tags.push(sm.orgTag(teamId));
        const results = await sm.searchMemories(query, tags, 5);
        return results.map((r) => ({
          title: r.title,
          content: r.chunks?.map((c) => c.content).join("\n") ?? r.summary,
          score: r.score,
        }));
      },
    }),
    memory_add: tool({
      description: "Save a new memory when the user asks to remember something or shares a clear preference/decision",
      inputSchema: z.object({
        content: z.string().describe("The memory content to save"),
        scope: z.enum(["user", "org"]).describe("'user' for personal, 'org' for team-wide"),
      }),
      execute: async ({ content, scope }) => {
        const tag = scope === "user" ? sm.userTag(slackUserId) : teamId ? sm.orgTag(teamId) : sm.userTag(slackUserId);
        return sm.addMemory(content, tag);
      },
    }),
  };
}
