import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { hasExplicitConfirmation } from "../confirmation.js";
import type { SubagentContext } from "./types.js";

const ALLOWED_CWDS: Record<string, string> = {
  cx: `${process.env.HOME}/workspace/chatarmin/cx`,
};

const ALLOWED_CWD_NAMES = Object.keys(ALLOWED_CWDS);

export function createClaudeCodeTools(ctx: SubagentContext) {
  const { conversationHistory } = ctx;

  return {
    claude_code: tool({
      description: `[EXPERIMENTAL] Offload a well-defined coding task to a local Claude Code CLI agent. It can read/write files, run commands, create PRs, etc. The instruction must be specific and self-contained — include all context needed (ticket description, expected behavior, file paths, etc). Allowed workspaces: ${ALLOWED_CWD_NAMES.join(", ")}. This is a heavyweight operation that can take several minutes.`,
      inputSchema: z.object({
        workspace: z
          .enum(ALLOWED_CWD_NAMES as [string, ...string[]])
          .describe(`Which workspace to run in. Options: ${ALLOWED_CWD_NAMES.join(", ")}`),
        instruction: z
          .string()
          .describe(
            "Detailed, self-contained instruction. Must include ALL context: what to fix/build, relevant ticket info, file paths if known, expected behavior, acceptance criteria. Do NOT be vague.",
          ),
      }),
      execute: async ({ workspace, instruction }) => {
        const cwd = ALLOWED_CWDS[workspace];
        if (!cwd) {
          return { error: `Unknown workspace "${workspace}". Allowed: ${ALLOWED_CWD_NAMES.join(", ")}` };
        }

        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(
            conversationHistory,
            `Run Claude Code in "${workspace}" workspace with instruction: "${instruction.slice(0, 100)}..."`,
          );
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }

        const timeout = 10 * 60 * 1000; // 10 minutes

        try {
          const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
              "claude",
              ["-p", "--dangerously-skip-permissions", "--output-format", "text", instruction],
              {
                cwd,
                timeout,
                maxBuffer: 5 * 1024 * 1024,
                env: { ...process.env },
              },
              (err, stdout, stderr) => {
                if (err) {
                  reject(new Error(`Claude Code failed: ${err.message}\nstderr: ${stderr}`));
                } else {
                  resolve(stdout);
                }
              },
            );
          });

          return {
            status: "completed",
            workspace,
            report: stdout,
          };
        } catch (err: any) {
          return {
            status: "failed",
            workspace,
            error: err.message,
          };
        }
      },
    }),
  };
}
