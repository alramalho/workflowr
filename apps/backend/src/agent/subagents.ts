import { tool, stepCountIs } from "ai";
import { generateText } from "../utils/ai.js";
import { z } from "zod";
import dedent from "dedent";
import { config } from "../config.js";
import { execFile } from "child_process";
import { isRunnerConnected, sendTaskToRunner, getConnectedRunnerDirectories } from "../runner/server.js";
import { createLinearTools } from "./tools/linear.js";
import { createSlackTools } from "./tools/slack.js";
import { createGithubTools } from "./tools/github.js";
import { createGoogleCalendarTools } from "./tools/google-calendar.js";
import { createMemoryTools } from "./tools/memory.js";
import { createTaskTools } from "./tools/tasks.js";
import { createDatabaseTools } from "./tools/database.js";
import { createClaudeCodeTools } from "./tools/claude-code.js";
import { createNotionTools } from "./tools/notion.js";
import { createOrgTools } from "./tools/org.js";
import { createHttpRequestTools } from "./tools/http-request.js";
import { createSkillTools } from "./tools/skills.js";
import { buildNotionTreeText } from "../db/notion-pages.js";
import * as sm from "../integrations/supermemory.js";
import { saveArtifact } from "../db/artifacts.js";
import { getToolRules } from "../db/tool-rules.js";
import { getOrgByTeamId } from "../db/orgs.js";
import type { SubagentContext } from "./tools/types.js";

function fetchToolRules(toolName: string, ctx: SubagentContext): string | null {
  if (!ctx.slackUserId) return null;
  const rules = getToolRules(toolName, ctx.slackUserId);
  if (rules.length === 0) return null;
  return `\n\nUser rules for this tool (always apply these):\n${rules.map((r) => `- ${r.memory_text}`).join("\n")}`;
}

function extractTag(text: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

const SUBAGENT_MODEL = "google/gemini-3-flash-preview";

interface SubagentResult {
  text: string;
  internals: { tool: string; args: unknown }[];
}

async function runSubagent(systemPrompt: string, instruction: string, tools: Record<string, any>, stepLimit = 10): Promise<SubagentResult> {
  const internals: { tool: string; args: unknown }[] = [];

  try {
    const result = await generateText({
      model: SUBAGENT_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: instruction }],
      tools,
      stopWhen: stepCountIs(stepLimit),
      abortSignal: AbortSignal.timeout(60_000),
      onStepFinish({ toolCalls }) {
        for (const tc of toolCalls) {
          internals.push({ tool: tc.toolName, args: (tc as any).input ?? (tc as any).args });
        }
      },
    });

    return { text: result.text, internals };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError") {
      console.warn(`[subagent] execution aborted (timeout) — instruction: ${instruction.slice(0, 100)}`);
    }
    throw error;
  }
}

function createLinearAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated Linear agent. Handles issue search, listing, creation, updates, comments, labels, projects, teams. For write operations, it will ask back if the request is underspecified (missing assignee, priority, team, etc).",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in Linear") }),
    execute: async ({ instruction }) => {
      const tools = createLinearTools(ctx);
      const rules = fetchToolRules("linear_agent", ctx);
      const { text, internals } = await runSubagent(dedent`
        You are a Linear issue management agent. Execute Linear operations as instructed.

        For READ operations: execute immediately and return results.
        For WRITE operations (create, update, comment): If the request is underspecified, return a message listing what information is missing instead of guessing. Examples of underspecified requests:
        • "Create a ticket about AI debugging" → Missing: assignee, priority, team, description of the actual problem
        • "Update the issue" → Missing: which issue, what fields to change
        • "Assign it to someone" → Missing: who specifically

        Only execute write operations when you have all necessary details.
      `, instruction, tools);
      const answer = rules ? text + rules : text;
      return { answer, internals };
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
      if (ctx.teamId) {
        const org = getOrgByTeamId(ctx.teamId);
        if (org?.slack_domain) contextLines.push(`Slack workspace domain: ${org.slack_domain} (use for constructing message links: https://${org.slack_domain}.slack.com/archives/{channelId}/p{ts})`);
      }
      const contextBlock = contextLines.length ? `\n\nConversation context:\n${contextLines.join("\n")}` : "";

      const rules = fetchToolRules("slack_agent", ctx);
      const { text, internals } = await runSubagent(dedent`
        You are a Slack management agent. Handle channel, thread, canvas, and file operations.

        For READ operations: execute immediately.
        For WRITE operations (create/edit canvases, upload files): If the request is underspecified, return what's missing. Examples:
        • "Create a canvas" → Missing: which channel (or standalone), title, content
        • "Edit the canvas" → Missing: which canvas, what changes to make
        • "Send a CSV" → Missing: what data to include, filename

        Before editing a canvas, always look up its sections first.
        Before creating a channel canvas, always list existing canvases first.
        When looking for canvases in a channel, always call slack_list_channel_canvases first — tab/bookmarked canvases (source: "bookmark") are the most important as they are the team's primary working documents. Prioritize those over canvases found via files_list.
        When uploading files, you can either generate content directly OR reference an artifactId from another agent — the slack_upload_file tool accepts both.
        For file uploads, use the current channel/thread as default — do NOT ask the user for channel or thread IDs.${contextBlock}
      `, instruction, tools);
      const answer = rules ? text + rules : text;
      return { answer, internals };
    },
  });
}

function createGithubAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated GitHub agent. Handles repo activity, PRs, commits. For write operations, it will ask back if the request is underspecified.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to do in GitHub") }),
    execute: async ({ instruction }) => {
      const tools = createGithubTools(ctx);
      const rules = fetchToolRules("github_agent", ctx);
      const { text, internals } = await runSubagent(dedent`
        You are a GitHub management agent. Handle repository, PR, and commit operations.

        For READ operations: execute immediately.
        For WRITE operations (create PRs): If the request is underspecified, return what's missing. Examples:
        • "Create a PR" → Missing: which repo (owner/repo), which branches, title
        • "Check the PRs" → Missing: which repo (specify owner and repo name)
      `, instruction, tools);
      const answer = rules ? text + rules : text;
      return { answer, internals };
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
      const rules = fetchToolRules("google_calendar_agent", ctx);
      const { text, internals } = await runSubagent(dedent`
        You are a Google Calendar agent. Handle event search, creation, updates, and deletion.

        For READ operations: execute immediately.
        For WRITE operations (create/update/delete events): If the request is underspecified, return what's missing. Examples:
        • "Schedule a meeting" → Missing: when, how long, with whom, title
        • "Delete the meeting" → Missing: which meeting specifically (search first)
        • "Move the meeting" → Missing: which meeting, to when
      `, instruction, tools);
      const answer = rules ? text + rules : text;
      return { answer, internals };
    },
  });
}

function createNotionAgentTool(ctx: SubagentContext) {
  return tool({
    description: "Dedicated Notion agent. Searches pages and databases, reads page content and properties. Read-only.",
    inputSchema: z.object({ instruction: z.string().describe("Clear instruction for what to look up in Notion") }),
    execute: async ({ instruction }) => {
      const tools = createNotionTools(ctx);
      const tree = ctx.teamId ? buildNotionTreeText(ctx.teamId) : null;
      const treeBlock = tree
        ? `\n\nPreviously discovered Notion structure (use IDs to navigate directly instead of searching):\n${tree}\nNote: this tree is incomplete — only pages accessed before are shown. Search if you need something not listed.`
        : "";

      const { text, internals } = await runSubagent(dedent`
        You are a Notion read-only agent. You help find and read information from Notion pages and databases.

        Your workflow:
        1. Check the known structure below — if the page/database you need is listed, use its ID directly.
        2. Otherwise, search for pages or databases matching the request.
        3. Read page content or query databases as needed.
        4. For databases, check the schema first with notion_get_database_schema before querying.

        Return clear, structured results. Include page URLs so the user can navigate to them.${treeBlock}
      `, instruction, tools);
      return { answer: text, internals };
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
        notion_agent: createNotionAgentTool(ctx),
      };
      const { text, internals } = await runSubagent(dedent`
        You are an exploration agent. Your job is to investigate and gather information across the organization's tools.

        You have access to specialized agents:
        • linear_agent — search issues, projects, activity
        • slack_agent — read channels, threads
        • github_agent — search PRs, commits, repo activity
        • google_calendar_agent — search events, meeting notes
        • database_agent — query the org's database for data-driven answers
        • notion_agent — search and read Notion pages and databases

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
      return { answer: text, internals };
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

      const subResult = await runSubagent(dedent`
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

      const answer = extractTag(subResult.text, "answer") ?? subResult.text;
      const internals = extractTag(subResult.text, "internals");
      const learningsRaw = extractTag(subResult.text, "learnings");

      if (learningsRaw && config.ai.supermemoryApiKey) {
        const learnings = learningsRaw.split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean);
        for (const learning of learnings) {
          try { await sm.addMemory(learning, sm.dbSchemaTag()); } catch {}
        }
      }

      const newArtifactIds = ctx.artifacts?.popRecent() ?? [];
      const result: Record<string, any> = { answer, internals: subResult.internals };
      if (internals) result.queryInternals = internals;

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

const LOCAL_CODEBASE_WORKSPACES: Record<string, { path: string; description: string }> = {
  cx: {
    path: `${process.env.HOME}/workspace/chatarmin/cx`,
    description: "Main Chatarmin CX application — handles conversations, AI agents, workflows, contacts, organizations, billing, messaging (WhatsApp/SMS/email)",
  },
};

function createCodebaseExploreAgentTool(ctx: SubagentContext) {
  const { slackUserId, teamId } = ctx;
  const useRunner = slackUserId && teamId && isRunnerConnected(slackUserId, teamId);
  const runnerDirs = useRunner ? getConnectedRunnerDirectories(slackUserId!, teamId!) : [];

  const workspaces: Record<string, { path: string; description: string }> = useRunner
    ? Object.fromEntries(runnerDirs.map((d) => [d.name, { path: d.path, description: d.description ?? d.name }]))
    : LOCAL_CODEBASE_WORKSPACES;

  const workspaceNames = Object.keys(workspaces);
  const workspaceList = Object.entries(workspaces)
    .map(([name, ws]) => `• ${name}: ${ws.description}`)
    .join("\n");

  if (workspaceNames.length === 0) {
    return tool({
      description: "Explore the product codebase. Currently unavailable — no workspaces connected.",
      inputSchema: z.object({ question: z.string() }),
      execute: async () => ({ error: "No codebase workspaces available. The user needs to connect a runner with /setup-runner." }),
    });
  }

  return tool({
    description: `Explore the product codebase to understand domain concepts, data models, business logic, or code structure. Read-only — no modifications. Use when domain knowledge is missing. Checks known codebase guidelines first, then explores code if needed. Heavyweight (~1-3 min).${useRunner ? " Running on user's connected machine." : ""}\n\nAvailable codebases:\n${workspaceList}`,
    inputSchema: z.object({
      question: z.string().describe("What you want to understand about the codebase"),
      workspace: z.enum(workspaceNames as [string, ...string[]]).default(workspaceNames[0]).describe(`Which codebase to explore`),
    }),
    execute: async ({ question, workspace }) => {
      workspace = workspace ?? workspaceNames[0];
      let guidelines = "";
      if (config.ai.supermemoryApiKey) {
        try {
          const results = await sm.searchMemories(question, [sm.codebaseTag()], 5);
          if (results.length > 0) {
            guidelines = results.map(r => r.chunks?.map(c => c.content).join("\n") ?? r.summary).join("\n---\n");
          }
        } catch {}
      }

      const ws = workspaces[workspace];
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
        let stdout: string;

        if (useRunner) {
          stdout = await sendTaskToRunner(slackUserId!, teamId!, instruction, ws.path);
        } else {
          stdout = await new Promise<string>((resolve, reject) => {
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
        }

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
        const advisor = SUBAGENT_MODEL;

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
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError") {
            console.warn("[subagent] second opinion aborted (timeout)");
          }
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
    notion_agent: createNotionAgentTool(ctx),
    codebase_explore: createCodebaseExploreAgentTool(ctx),
  };
  const memory = createMemoryTools(ctx);
  for (const [k, v] of Object.entries(memory)) base[k] = v;
  const tasks = createTaskTools(ctx);
  for (const [k, v] of Object.entries(tasks)) base[k] = v;
  const claudeCode = createClaudeCodeTools(ctx);
  for (const [k, v] of Object.entries(claudeCode)) base[k] = v;
  const org = createOrgTools(ctx.teamId);
  for (const [k, v] of Object.entries(org)) base[k] = v;
  const http = createHttpRequestTools(ctx);
  for (const [k, v] of Object.entries(http)) base[k] = v;
  const skillTools = createSkillTools(ctx);
  for (const [k, v] of Object.entries(skillTools)) base[k] = v;
  return base;
}
