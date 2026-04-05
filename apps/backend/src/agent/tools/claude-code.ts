import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { hasExplicitConfirmation } from "../confirmation.js";
import { isRunnerConnected, sendTaskToRunner, getConnectedRunnerDirectories } from "../../runner/server.js";
import type { SubagentContext } from "./types.js";

const LOCAL_CWDS: Record<string, string> = {
  cx: `${process.env.HOME}/workspace/chatarmin/cx`,
};

export function createClaudeCodeTools(ctx: SubagentContext) {
  const { conversationHistory, slackUserId, teamId } = ctx;

  const useRunner = slackUserId && teamId && isRunnerConnected(slackUserId, teamId);
  const runnerDirs = useRunner ? getConnectedRunnerDirectories(slackUserId!, teamId!) : [];
  const runnerWorkspaceNames = runnerDirs.map((d) => d.name);

  const allWorkspaceNames = useRunner
    ? runnerWorkspaceNames
    : Object.keys(LOCAL_CWDS);

  const workspaceDesc = useRunner
    ? runnerDirs.map((d) => `• ${d.name}${d.description ? `: ${d.description}` : ""}`).join("\n")
    : allWorkspaceNames.map((n) => `• ${n}`).join("\n");

  return {
    claude_code: tool({
      description: `[EXPERIMENTAL] Offload a well-defined coding task to a Claude Code agent. It can read/write files, run commands, create PRs, etc. The instruction must be specific and self-contained. ${useRunner ? "Running on user's connected machine." : "Running locally on server."} Available workspaces:\n${workspaceDesc}`,
      inputSchema: z.object({
        workspace: z
          .enum(allWorkspaceNames as [string, ...string[]])
          .describe(`Which workspace to run in`),
        instruction: z
          .string()
          .describe(
            "Detailed, self-contained instruction. Must include ALL context: what to fix/build, relevant ticket info, file paths if known, expected behavior, acceptance criteria.",
          ),
      }),
      execute: async ({ workspace, instruction }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(
            conversationHistory,
            `Run Claude Code in "${workspace}" workspace with instruction: "${instruction.slice(0, 100)}..."`,
          );
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }

        if (useRunner) {
          try {
            const cwd = runnerDirs.find((d) => d.name === workspace)?.path;
            const result = await sendTaskToRunner(slackUserId!, teamId!, instruction, cwd ?? workspace);
            return { status: "completed", workspace, report: result };
          } catch (err: any) {
            return { status: "failed", workspace, error: err.message };
          }
        }

        const cwd = LOCAL_CWDS[workspace];
        if (!cwd) {
          return { error: `Unknown workspace "${workspace}". Available: ${allWorkspaceNames.join(", ")}` };
        }

        try {
          const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
              "claude",
              ["-p", "--dangerously-skip-permissions", "--output-format", "text", instruction],
              { cwd, timeout: 10 * 60 * 1000, maxBuffer: 5 * 1024 * 1024, env: { ...process.env } },
              (err, stdout, stderr) => {
                if (err) reject(new Error(`Claude Code failed: ${err.message}\nstderr: ${stderr}`));
                else resolve(stdout);
              },
            );
          });
          return { status: "completed", workspace, report: stdout };
        } catch (err: any) {
          return { status: "failed", workspace, error: err.message };
        }
      },
    }),
  };
}
