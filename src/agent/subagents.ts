import { generateText, tool, stepCountIs } from "ai";
import { createHelicone } from "@helicone/ai-sdk-provider";
import { z } from "zod";
import dedent from "dedent";
import { config } from "../config.js";
import { createLinearTools } from "./tools/linear.js";
import { createSlackTools } from "./tools/slack.js";
import { createGithubTools } from "./tools/github.js";
import { createGoogleCalendarTools } from "./tools/google-calendar.js";
import { createMemoryTools } from "./tools/memory.js";
import type { SubagentContext } from "./tools/types.js";

const SUBAGENT_MODEL = "gemini-3-flash-preview";

async function runSubagent(systemPrompt: string, instruction: string, tools: Record<string, any>, stepLimit = 10) {
  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone(SUBAGENT_MODEL);

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: [{ role: "user", content: instruction }],
    tools,
    stopWhen: stepCountIs(stepLimit),
    abortSignal: AbortSignal.timeout(60_000),
  });

  return result.text;
}

function createLinearAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated Linear agent. Handles issue search, listing, creation, updates, comments, labels, projects, teams. For write operations, it will ask back if the request is underspecified (missing assignee, priority, team, etc).",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in Linear") }),
    execute: async ({ instruction }) => {
      const tools = createLinearTools(ctx);
      return runSubagent(dedent`
        You are a Linear issue management agent. Execute Linear operations as instructed.

        For READ operations: execute immediately and return results.
        For WRITE operations (create, update, comment): If the request is underspecified, return a message listing what information is missing instead of guessing. Examples of underspecified requests:
        • "Create a ticket about AI debugging" → Missing: assignee, priority, team, description of the actual problem
        • "Update the issue" → Missing: which issue, what fields to change
        • "Assign it to someone" → Missing: who specifically

        Only execute write operations when you have all necessary details.
      `, instruction, tools);
    },
  });
}

function createSlackAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated Slack agent. Handles channel history, threads, and canvas operations (list, create, edit). For write operations, it will ask back if the request is underspecified.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in Slack") }),
    execute: async ({ instruction }) => {
      const tools = createSlackTools(ctx);
      return runSubagent(dedent`
        You are a Slack management agent. Handle channel, thread, and canvas operations.

        For READ operations: execute immediately.
        For WRITE operations (create/edit canvases): If the request is underspecified, return what's missing. Examples:
        • "Create a canvas" → Missing: which channel (or standalone), title, content
        • "Edit the canvas" → Missing: which canvas, what changes to make

        Before editing a canvas, always look up its sections first.
        Before creating a channel canvas, always list existing canvases first.
      `, instruction, tools);
    },
  });
}

function createGithubAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated GitHub agent. Handles repo activity, PRs, commits. For write operations, it will ask back if the request is underspecified.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in GitHub") }),
    execute: async ({ instruction }) => {
      const tools = createGithubTools(ctx);
      return runSubagent(dedent`
        You are a GitHub management agent. Handle repository, PR, and commit operations.

        For READ operations: execute immediately.
        For WRITE operations (create PRs): If the request is underspecified, return what's missing. Examples:
        • "Create a PR" → Missing: which repo (owner/repo), which branches, title
        • "Check the PRs" → Missing: which repo (specify owner and repo name)
      `, instruction, tools);
    },
  });
}

function createGoogleCalendarAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated Google Calendar agent. Handles event search, creation, updates, deletion, and meeting notes. For write operations, it will ask back if the request is underspecified.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in Google Calendar") }),
    execute: async ({ instruction }) => {
      const tools = createGoogleCalendarTools(ctx);
      if (Object.keys(tools).length === 0) return "Google Calendar not available (no user context).";
      return runSubagent(dedent`
        You are a Google Calendar agent. Handle event search, creation, updates, and deletion.

        For READ operations: execute immediately.
        For WRITE operations (create/update/delete events): If the request is underspecified, return what's missing. Examples:
        • "Schedule a meeting" → Missing: when, how long, with whom, title
        • "Delete the meeting" → Missing: which meeting specifically (search first)
        • "Move the meeting" → Missing: which meeting, to when
      `, instruction, tools);
    },
  });
}

function createExploreAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Exploration agent. Use when the request is vague or needs investigation (e.g. mentions of 'that meeting', 'the ticket', 'our board', or any ambiguous reference). Searches across all services in parallel to gather context.",
    inputSchema: z.object({ instruction: z.string().describe("What to explore/investigate across the organization's tools") }),
    execute: async ({ instruction }) => {
      const tools = {
        linear_agent: createLinearAgentTool(ctx),
        slack_agent: createSlackAgentTool(ctx),
        github_agent: createGithubAgentTool(ctx),
        google_calendar_agent: createGoogleCalendarAgentTool(ctx),
      };
      return runSubagent(dedent`
        You are an exploration agent. Your job is to investigate and gather information across the organization's tools (Linear, Slack, GitHub, Google Calendar).

        You have access to 4 specialized agents. ALWAYS call multiple agents in parallel when information might exist across services. Do not call them one by one — fan out simultaneously.

        For example, if asked about "the standup", call google_calendar_agent to find the event AND slack_agent to find relevant channel messages AND linear_agent to find related issues — all at once.

        You are for exploration and information gathering only. Compile findings into a clear summary.
      `, instruction, tools, 8);
    },
  });
}

export function createOrchestratorTools(ctx: SubagentContext) {
  const base: Record<string, any> = {
    explore: createExploreAgentTool(ctx),
    linear_agent: createLinearAgentTool(ctx),
    slack_agent: createSlackAgentTool(ctx),
    github_agent: createGithubAgentTool(ctx),
    google_calendar_agent: createGoogleCalendarAgentTool(ctx),
  };
  const memory = createMemoryTools(ctx);
  for (const [k, v] of Object.entries(memory)) base[k] = v;
  return base;
}
