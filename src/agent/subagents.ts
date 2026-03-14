import { generateText, tool, stepCountIs } from "ai";
import { createHelicone } from "@helicone/ai-sdk-provider";
import { z } from "zod";
import dedent from "dedent";
import { config } from "../config.js";
import { execFile } from "child_process";
import { createLinearTools } from "./tools/linear.js";
import { createSlackTools } from "./tools/slack.js";
import { createGithubTools } from "./tools/github.js";
import { createGoogleCalendarTools } from "./tools/google-calendar.js";
import { createMemoryTools } from "./tools/memory.js";
import { createTaskTools } from "./tools/tasks.js";
import { createDatabaseTools } from "./tools/database.js";
import { createClaudeCodeTools } from "./tools/claude-code.js";
import * as sm from "../integrations/supermemory.js";
import { saveArtifact } from "../db/artifacts.js";
import type { SubagentContext } from "./tools/types.js";

function extractTag(text: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

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
    description: "Dedicated Slack agent. Handles channel history, threads, canvas operations (list, create, edit), and file uploads (CSV, JSON, text, etc., including artifacts from other agents via artifactId). For write operations, it will ask back if the request is underspecified.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in Slack") }),
    execute: async ({ instruction }) => {
      const tools = createSlackTools(ctx);
      const contextLines = [];
      if (ctx.channelId) contextLines.push(`Current channel ID: ${ctx.channelId}`);
      if (ctx.threadTs) contextLines.push(`Current thread timestamp: ${ctx.threadTs}`);
      const contextBlock = contextLines.length ? `\n\nConversation context:\n${contextLines.join("\n")}` : "";

      return runSubagent(dedent`
        You are a Slack management agent. Handle channel, thread, canvas, and file operations.

        For READ operations: execute immediately.
        For WRITE operations (create/edit canvases, upload files): If the request is underspecified, return what's missing. Examples:
        • "Create a canvas" → Missing: which channel (or standalone), title, content
        • "Edit the canvas" → Missing: which canvas, what changes to make
        • "Send a CSV" → Missing: what data to include, filename

        Before editing a canvas, always look up its sections first.
        Before creating a channel canvas, always list existing canvases first.
        When uploading files, you can either generate content directly OR reference an artifactId from another agent — the slack_upload_file tool accepts both.
        For file uploads, use the current channel/thread as default — do NOT ask the user for channel or thread IDs.${contextBlock}
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
    description: "Exploration agent. Use when the request is vague or needs investigation (e.g. mentions of 'that meeting', 'the ticket', 'our board', or any ambiguous reference). Searches across all services (Linear, Slack, GitHub, Calendar, database) in parallel. Returns findings with confidence assessment and open questions.",
    inputSchema: z.object({ instruction: z.string().describe("What to explore/investigate across the organization's tools") }),
    execute: async ({ instruction }) => {
      const tools: Record<string, any> = {
        linear_agent: createLinearAgentTool(ctx),
        slack_agent: createSlackAgentTool(ctx),
        github_agent: createGithubAgentTool(ctx),
        google_calendar_agent: createGoogleCalendarAgentTool(ctx),
        database_agent: createDatabaseAgentTool(ctx),
      };
      return runSubagent(dedent`
        You are an exploration agent. Your job is to investigate and gather information across the organization's tools.

        You have access to specialized agents:
        • linear_agent — search issues, projects, activity
        • slack_agent — read channels, threads
        • github_agent — search PRs, commits, repo activity
        • google_calendar_agent — search events, meeting notes
        • database_agent — query the org's database for data-driven answers

        ALWAYS call multiple agents in parallel when information might exist across services. Fan out aggressively — don't call them one by one.

        For example, if asked about "the standup", call google_calendar_agent to find the event AND slack_agent to find relevant channel messages AND linear_agent to find related issues — all at once.

        After gathering results, structure your response as:

        *FINDINGS*
        [Compiled findings from all agents — be specific with names, IDs, data]

        *CONFIDENCE*: high / medium / low
        [One line: why this confidence level — what did you find vs what's still unclear?]

        *OPEN QUESTIONS*
        [Questions you couldn't answer — things the user would need to clarify. Be specific about what would help resolve each. Only include if confidence is not high.]
      `, instruction, tools, 8);
    },
  });
}

function createDatabaseAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Read-only database agent. Queries internal data and returns structured results. Large datasets (>20 rows) are automatically stored as downloadable CSV artifacts — check the response for an artifactId you can pass to slack_agent for file upload.",
    inputSchema: z.object({ instruction: z.string().describe("What you want to know from the database, in plain language") }),
    execute: async ({ instruction }) => {
      const tools = createDatabaseTools(ctx.artifacts);

      ctx.artifacts?.popRecent();

      const text = await runSubagent(dedent`
        You are a read-only database query agent. You help answer questions by querying the PostgreSQL database.

        Your workflow:
        1. Call search_db_guidelines with a query relevant to the question (if available) — this surfaces known gotchas and tips from past queries.
        2. Call get_database_schema to understand the available tables and columns.
        3. Cross-reference any guidelines found in step 1 with the schema — they may warn you about misleading column names, correct join paths, etc.
        4. Build and execute your SQL query with execute_read_query.
        5. If the results look surprising or wrong, re-check your assumptions before returning.

        When results exceed 20 rows, the tool automatically stores the full data as a CSV artifact and returns an artifactId + preview. Reference the artifact in your answer.

        RESPONSE FORMAT — always structure your response as:
        <answer>
        [Your clear, human-readable answer here. If an artifact was created, mention it.]
        </answer>
        <learnings>
        [Optional: non-obvious schema discoveries worth remembering for future queries. One per line with "- " prefix. Only include genuinely useful gotchas — e.g. misleading column names, required join paths, enum mappings. Omit this section entirely if nothing new was learned.]
        </learnings>
        <internals>
        • Tables: [tables used]
        • Key fields: [fields that drove the result]
        • Logic: [1-2 sentence plain-English explanation of what the SQL did]
        • Guidelines used: [any guidelines that informed the query, or "none found"]
        </internals>

        The <internals> section helps technical users verify correctness. Keep it brief but specific — include actual table/field names and the filter values used.

        You can ONLY read data. If asked to modify, insert, update, or delete anything, refuse and explain that you are read-only.
      `, instruction, tools);

      const answer = extractTag(text, "answer") ?? text;
      const internals = extractTag(text, "internals");
      const learningsRaw = extractTag(text, "learnings");

      if (learningsRaw && config.ai.supermemoryApiKey) {
        const learnings = learningsRaw.split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean);
        for (const learning of learnings) {
          try { await sm.addMemory(learning, sm.dbSchemaTag()); } catch {}
        }
      }

      const newArtifactIds = ctx.artifacts?.popRecent() ?? [];
      const result: Record<string, any> = { answer };
      if (internals) result.internals = internals;

      if (newArtifactIds.length > 0 && ctx.artifacts) {
        const artifact = ctx.artifacts.get(newArtifactIds[0]);
        if (artifact) {
          result.artifactId = newArtifactIds[0];
          result.artifactFilename = artifact.filename;
          const csvLines = artifact.content.toString("utf-8").split("\n");
          result.snippet = csvLines.slice(0, 6).join("\n");

          if (ctx.channelId && ctx.threadTs) {
            const summary = answer.length > 200 ? answer.slice(0, 200) + "..." : answer;
            try {
              saveArtifact({
                id: newArtifactIds[0],
                channelId: ctx.channelId,
                threadTs: ctx.threadTs,
                filename: artifact.filename,
                mimeType: artifact.mimeType,
                summary,
                content: artifact.content,
              });
            } catch {}
          }
        }
      }

      return result;
    },
  });
}

const CODEBASE_WORKSPACES: Record<string, { path: string; description: string }> = {
  cx: {
    path: `${process.env.HOME}/workspace/chatarmin/cx`,
    description: "Main Chatarmin CX application — handles conversations, AI agents, workflows, contacts, organizations, billing, messaging (WhatsApp/SMS/email)",
  },
};

function createCodebaseExploreAgentTool(ctx: SubagentContext) {
  const workspaceNames = Object.keys(CODEBASE_WORKSPACES);
  const workspaceList = Object.entries(CODEBASE_WORKSPACES)
    .map(([name, ws]) => `• ${name}: ${ws.description}`)
    .join("\n");

  return tool({
    description: `Explore the product codebase to understand domain concepts, data models, business logic, or code structure. Read-only — no modifications. Use when domain knowledge is missing (e.g. 'what counts as a workflow', 'how is v3 defined'). Checks known codebase guidelines first, then explores code if needed. Heavyweight (runs Claude Code, ~1-3 min).\n\nAvailable codebases:\n${workspaceList}`,
    inputSchema: z.object({
      question: z.string().describe("What you want to understand about the codebase"),
      workspace: z.enum(workspaceNames as [string, ...string[]]).default("cx").describe(`Which codebase to explore. Options: ${workspaceNames.join(", ")}`),
    }),
    execute: async ({ question, workspace = "cx" }) => {
      let guidelines = "";
      if (config.ai.supermemoryApiKey) {
        try {
          const results = await sm.searchMemories(question, [sm.codebaseTag()], 5);
          if (results.length > 0) {
            guidelines = results.map(r => r.chunks?.map(c => c.content).join("\n") ?? r.summary).join("\n---\n");
          }
        } catch {}
      }

      const ws = CODEBASE_WORKSPACES[workspace];
      if (!ws) return { error: `Unknown workspace "${workspace}". Available: ${workspaceNames.join(", ")}` };

      const instruction = dedent`
        IMPORTANT: This is a READ-ONLY exploration. Do NOT modify any files, create branches, or run commands that change state.

        You are exploring the "${workspace}" codebase: ${ws.description}

        ${guidelines ? `Previously discovered guidelines about this codebase:\n${guidelines}\n` : ""}
        Question: ${question}

        Explore the codebase to answer this question. Search for relevant files, read code, understand data models and business logic. Be thorough but focused.

        Structure your response exactly as:
        <findings>
        [What you found — be specific about file paths, function names, data models, enum values, etc.]
        </findings>
        <learnings>
        [Non-obvious discoveries worth remembering for future questions. One per line with "- " prefix. Be specific: include file paths, table names, enum values, domain relationships. Only genuinely useful findings. Omit section entirely if nothing new.]
        </learnings>
        <open_questions>
        [Questions you couldn't answer from the code alone. One per line with "- " prefix. Omit section entirely if everything is answered.]
        </open_questions>
      `;

      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile("claude", ["-p", "--dangerously-skip-permissions", "--output-format", "text", instruction], {
            cwd: ws.path,
            timeout: 3 * 60 * 1000,
            maxBuffer: 5 * 1024 * 1024,
            env: { ...process.env },
          }, (err, stdout, stderr) => {
            if (err) reject(new Error(`Codebase exploration failed: ${err.message}`));
            else resolve(stdout);
          });
        });

        const learningsRaw = extractTag(stdout, "learnings");
        if (learningsRaw && config.ai.supermemoryApiKey) {
          const learnings = learningsRaw.split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean);
          for (const learning of learnings) {
            try { await sm.addMemory(learning, sm.codebaseTag()); } catch {}
          }
        }

        return {
          findings: extractTag(stdout, "findings") ?? stdout,
          open_questions: extractTag(stdout, "open_questions") ?? null,
          guidelines_used: guidelines || "none found",
          learnings_saved: !!learningsRaw,
        };
      } catch (err: any) {
        return { error: err.message, guidelines_found: guidelines || "none" };
      }
    },
  });
}

export function createOrchestratorTools(ctx: SubagentContext) {
  const base: Record<string, any> = {
    confidence_check: tool({
      description: "Assess your confidence that you can resolve the current request. Call this BEFORE taking action and AFTER receiving exploration results. Your confidence level gates what you do next: high → execute, medium → explore or dig deeper, low → ask the user.",
      inputSchema: z.object({
        confidence: z.enum(["low", "medium", "high"]).describe("How confident you are that you can fully resolve the request right now"),
        reasoning: z.string().describe("Why you have this confidence level. What do you know? What's missing?"),
        next_tools: z.array(z.string()).describe("Which tools you plan to call next based on your confidence"),
      }),
      execute: async ({ confidence, reasoning, next_tools }) => {
        const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
        const advisor = helicone(SUBAGENT_MODEL);

        const history = ctx.toolHistory ?? [];
        const historyBlock = history.length > 0
          ? history.map((h, i) => {
              const output = typeof h.output === "string" ? h.output : JSON.stringify(h.output);
              const truncated = output.length > 300 ? output.slice(0, 300) + "…" : output;
              return `${i + 1}. ${h.tool}(${JSON.stringify(h.input)}) → ${truncated}`;
            }).join("\n")
          : "(first action — nothing called yet)";

        try {
          const { text: secondOpinion } = await generateText({
            model: advisor,
            system: dedent`
              You are a gentle adviser reviewing a Slack bot's approach to a user request mid-execution.
              You see the full conversation, every tool call so far (with inputs and outputs), and the bot's current plan.

              Keep it to 1-2 sentences max. Be supportive — validate the approach if it's reasonable.
              Only mention alternatives if there's something genuinely worth considering. Examples of useful nudges:
              • "You've gathered a lot of context — might be worth saving key findings to memory before continuing"
              • "Looks good, the explore results cover what's needed"
              • "You might also check Slack for more context on this"
              • "The user's question is still ambiguous — consider asking before executing"

              Do NOT be forceful or directive. You're a second pair of eyes, not a boss.
              Never say "you should" or "you must". Prefer "you might consider" or "one thing to note".
            `,
            messages: [{ role: "user", content: dedent`
              Conversation context:
              ${ctx.conversationHistory ?? "(no prior context)"}

              Tool calls so far:
              ${historyBlock}

              Current assessment:
              • Confidence: ${confidence}
              • Reasoning: ${reasoning}
              • Planned next tools: ${next_tools.join(", ")}

              Any thoughts?
            ` }],
            abortSignal: AbortSignal.timeout(10_000),
          });
          return { confidence, reasoning, next_tools, secondOpinion };
        } catch {
          return { confidence, reasoning, next_tools, secondOpinion: null };
        }
      },
    }),
    explore: createExploreAgentTool(ctx),
    linear_agent: createLinearAgentTool(ctx),
    slack_agent: createSlackAgentTool(ctx),
    github_agent: createGithubAgentTool(ctx),
    google_calendar_agent: createGoogleCalendarAgentTool(ctx),
    database_agent: createDatabaseAgentTool(ctx),
    codebase_explore: createCodebaseExploreAgentTool(ctx),
  };
  const memory = createMemoryTools(ctx);
  for (const [k, v] of Object.entries(memory)) base[k] = v;
  const tasks = createTaskTools(ctx);
  for (const [k, v] of Object.entries(tasks)) base[k] = v;
  const claudeCode = createClaudeCodeTools(ctx);
  for (const [k, v] of Object.entries(claudeCode)) base[k] = v;
  return base;
}
