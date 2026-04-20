import { tool, generateObject } from "ai";
import { z } from "zod";
import * as sm from "../../integrations/supermemory.js";
import { config } from "../../config.js";
import { addToolRule } from "../../db/tool-rules.js";
import type { SubagentContext } from "./types.js";

const TOOL_RULE_CANDIDATES = [
  "slack_agent",
  "linear_agent",
  "github_agent",
  "google_calendar_agent",
  "codebase_explore",
] as const;

async function classifyToolRules(content: string): Promise<string[]> {
  try {
    const result = await generateObject({
      model: "google/gemini-3-flash-preview",
      schema: z.object({
        tools: z.array(z.enum(TOOL_RULE_CANDIDATES)).describe(
          "Tools this rule/preference should always apply to. Empty if general knowledge.",
        ),
      }),
      prompt: `Does this memory represent a rule or preference that should always be applied when using specific tools?

Memory: ${content}

Tools:
- slack_agent: Slack operations (channels, threads, messages, canvases, formatting, quoting content)
- linear_agent: Linear issue management (creating, updating, commenting on issues)
- github_agent: GitHub operations (PRs, commits, repos)
- google_calendar_agent: Calendar operations (events, scheduling)
- codebase_explore: Local/runner codebase exploration via daemon (which workspaces are relevant, where domain concepts live, how to explore product source)

Return the tools this rule applies to. Return empty array if it's general knowledge or a fact (not a behavioral rule).`,
    });
    return result.object.tools;
  } catch {
    return [];
  }
}

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
        try {
          const tags = [sm.userTag(slackUserId)];
          if (teamId) tags.push(sm.orgTag(teamId));
          const results = await sm.searchMemories(query, tags, 5);
          return results.map((r) => ({
            id: r.documentId,
            title: r.title,
            content: r.chunks?.map((c) => c.content).join("\n") ?? r.summary,
            score: r.score,
          }));
        } catch (e: any) {
          console.error("[memory_search] failed:", e);
          return { error: e.message ?? "search failed" };
        }
      },
    }),
    memory_add: tool({
      description: "Save a new memory when the user asks to remember something or shares a clear preference/decision. Automatically reconciles with existing memories (merges/replaces if overlap detected).",
      inputSchema: z.object({
        content: z.string().describe("The memory content to save"),
        scope: z.enum(["user", "org"]).describe("'user' for personal, 'org' for team-wide"),
      }),
      execute: async ({ content, scope }) => {
        try {
          const tag = scope === "user" ? sm.userTag(slackUserId) : teamId ? sm.orgTag(teamId) : sm.userTag(slackUserId);
          const rephrased = await sm.rephraseMemory(content, teamId);

          const existing = await sm.searchMemories(rephrased, [tag], 3);
          const candidates = existing
            .map((r) => ({
              id: r.documentId,
              text: r.chunks?.map((c: any) => c.content).join(" ") ?? r.summary ?? r.title ?? "",
            }))
            .filter((c) => c.text);

          const { action, memories, deleteIds } = await sm.reconcileMemories(rephrased, candidates);

          if (action === "skip") {
            return { stored: false, reason: "duplicate", content: rephrased };
          }

          if (action === "reconcile" && memories?.length) {
            for (const id of deleteIds ?? []) {
              await sm.deleteMemory(id);
            }
            for (const mem of memories) {
              await sm.addMemory(mem, tag);
            }
          } else {
            await sm.addMemory(rephrased, tag);
          }

          // classify and store tool-bound rules
          const finalMemories = (action === "reconcile" && memories?.length) ? memories : [rephrased];
          const boundTools: string[] = [];
          for (const mem of finalMemories) {
            const tools = await classifyToolRules(mem);
            for (const t of tools) {
              addToolRule(t, mem, slackUserId, teamId);
              if (!boundTools.includes(t)) boundTools.push(t);
            }
          }

          const base = action === "reconcile"
            ? { stored: true, scope, reconciled: true, memoriesCount: memories!.length }
            : { stored: true, scope };

          return boundTools.length > 0
            ? { ...base, toolRules: boundTools }
            : base;
        } catch (e: any) {
          console.error("[memory_add] failed:", e);
          return { stored: false, error: e.message ?? "unknown error" };
        }
      },
    }),
    memory_delete: tool({
      description: "Delete a memory by its ID. Always use memory_search first to find the correct ID before deleting.",
      inputSchema: z.object({
        id: z.string().describe("The memory ID obtained from memory_search"),
      }),
      execute: async ({ id }) => {
        try {
          await sm.deleteMemory(id);
          return { deleted: true, id };
        } catch (e: any) {
          console.error("[memory_delete] failed:", e);
          return { deleted: false, error: e.message ?? "unknown error" };
        }
      },
    }),
  };
}
