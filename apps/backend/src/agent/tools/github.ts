import { tool } from "ai";
import { z } from "zod";
import * as github from "../../integrations/github.js";
import { hasExplicitConfirmation } from "../confirmation.js";
import type { SubagentContext } from "./types.js";

export function createGithubTools(ctx: SubagentContext) {
  const { conversationHistory } = ctx;

  return {
    github_get_recent_prs: tool({
      description: "Get recent pull requests for a GitHub repo",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        sinceDaysAgo: z.number().optional(),
      }),
      execute: async ({ owner, repo, sinceDaysAgo }) => {
        const since = sinceDaysAgo ? new Date(Date.now() - sinceDaysAgo * 86400000) : undefined;
        const prs = await github.getRecentPRs(owner, repo, since);
        return prs.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          user: pr.user?.login,
          url: pr.html_url,
          updatedAt: pr.updated_at,
          mergedAt: pr.merged_at,
        }));
      },
    }),
    github_get_recent_commits: tool({
      description: "Get recent commits for a GitHub repo",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        sinceDaysAgo: z.number().optional(),
      }),
      execute: async ({ owner, repo, sinceDaysAgo }) => {
        const since = sinceDaysAgo ? new Date(Date.now() - sinceDaysAgo * 86400000) : undefined;
        const commits = await github.getRecentCommits(owner, repo, since);
        return commits.map((c) => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message,
          author: c.commit.author?.name,
          date: c.commit.author?.date,
        }));
      },
    }),
    github_get_repo_activity: tool({
      description: "Get a weekly activity summary for a GitHub repo (PRs + commits from the last 7 days)",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
      }),
      execute: async ({ owner, repo }) => {
        const { prs, commits } = await github.getRepoActivity(owner, repo);
        return {
          prs: prs.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, user: pr.user?.login })),
          commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message, author: c.commit.author?.name })),
        };
      },
    }),
    github_create_pr: tool({
      description: "Create a pull request on a GitHub repo",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string().describe("PR title"),
        head: z.string().describe("Branch to merge from"),
        base: z.string().describe("Branch to merge into"),
        body: z.string().optional().describe("PR description/body"),
      }),
      execute: async ({ owner, repo, title, head, base, body }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Create GitHub PR "${title}" (${head} → ${base}) on ${owner}/${repo}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        const pr = await github.createPR(owner, repo, title, head, base, body);
        return { number: pr.number, title: pr.title, url: pr.html_url, state: pr.state, head: pr.head.ref, base: pr.base.ref };
      },
    }),
  };
}
