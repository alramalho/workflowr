import { tool } from "ai";
import { z } from "zod";
import type { App } from "@slack/bolt";
import * as linear from "../integrations/linear.js";
import * as github from "../integrations/github.js";
import { getChannelHistory, getThreadReplies } from "../integrations/slack.js";

export function createTools(app: App) {
  return {
    // Linear tools
    linear_search_issues: tool({
      description: "Search Linear issues by query string",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => linear.searchIssues(query),
    }),
    linear_get_issue: tool({
      description: "Get a Linear issue by its identifier (e.g. TEAM-123)",
      inputSchema: z.object({ issueId: z.string() }),
      execute: async ({ issueId }) => linear.getIssue(issueId),
    }),
    linear_create_issue: tool({
      description: "Create a new Linear issue",
      inputSchema: z.object({
        teamId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.number().min(0).max(4).optional(),
      }),
      execute: async ({ teamId, title, description, priority }) =>
        linear.createIssue(teamId, title, description, priority),
    }),
    linear_update_issue: tool({
      description: "Update fields on a Linear issue",
      inputSchema: z.object({
        issueId: z.string(),
        stateId: z.string().optional(),
        assigneeId: z.string().optional(),
        priority: z.number().min(0).max(4).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async ({ issueId, ...fields }) =>
        linear.updateIssue(issueId, fields),
    }),
    linear_add_comment: tool({
      description: "Add a comment to a Linear issue",
      inputSchema: z.object({
        issueId: z.string(),
        body: z.string(),
      }),
      execute: async ({ issueId, body }) => linear.addComment(issueId, body),
    }),
    linear_list_teams: tool({
      description: "List all available Linear teams",
      inputSchema: z.object({}),
      execute: async () => linear.listTeams(),
    }),
    linear_get_workflow_states: tool({
      description: "Get available workflow statuses for a Linear team",
      inputSchema: z.object({ teamId: z.string() }),
      execute: async ({ teamId }) => linear.getWorkflowStates(teamId),
    }),

    // GitHub tools
    github_get_recent_prs: tool({
      description: "Get recent pull requests for a GitHub repo",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        sinceDaysAgo: z.number().optional(),
      }),
      execute: async ({ owner, repo, sinceDaysAgo }) => {
        const since = sinceDaysAgo
          ? new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000)
          : undefined;
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
        const since = sinceDaysAgo
          ? new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000)
          : undefined;
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
          prs: prs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            user: pr.user?.login,
          })),
          commits: commits.map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message,
            author: c.commit.author?.name,
          })),
        };
      },
    }),

    // Slack tools
    slack_get_channel_history: tool({
      description: "Read recent messages from a Slack channel",
      inputSchema: z.object({
        channel: z.string(),
        limit: z.number().optional(),
      }),
      execute: async ({ channel, limit }) =>
        getChannelHistory(app, channel, limit),
    }),
    slack_get_thread: tool({
      description: "Read replies in a Slack thread",
      inputSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
      }),
      execute: async ({ channel, threadTs }) =>
        getThreadReplies(app, channel, threadTs),
    }),
  };
}
