import { tool } from "ai";
import { z } from "zod";
import type { App } from "@slack/bolt";
import * as linear from "../integrations/linear.js";
import * as github from "../integrations/github.js";
import * as googleCal from "../integrations/google.js";
import {
  getChannelHistory,
  getThreadReplies,
  createCanvas,
  createChannelCanvas,
  editCanvas,
  lookupCanvasSections,
} from "../integrations/slack.js";
import * as sm from "../integrations/supermemory.js";
import { config } from "../config.js";

export function createTools(app: App, slackUserId?: string, teamId?: string) {
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

    // Slack canvas tools
    // NOTE: Canvas content uses STANDARD MARKDOWN, not Slack mrkdwn.
    // Use ## headings, - bullets, **bold**, [text](url).
    // User mentions: ![](@U08PH00GP9Q) — NOT <@U08PH00GP9Q>.
    // Channel mentions: ![](#C123ABC456).
    slack_create_canvas: tool({
      description: "Create a standalone Slack canvas. Content must be standard markdown (NOT Slack mrkdwn): use ## headings, - bullets, **bold**, [text](url). For user mentions use ![](@UXXXXXXXX), for channels use ![](#CXXXXXXXX).",
      inputSchema: z.object({
        title: z.string().optional(),
        markdown: z.string().optional().describe("Initial canvas content in standard markdown"),
      }),
      execute: async ({ title, markdown }) =>
        createCanvas(app, title, markdown),
    }),
    slack_create_channel_canvas: tool({
      description: "Create a canvas pinned to a Slack channel. Content must be standard markdown (NOT Slack mrkdwn): use ## headings, - bullets, **bold**, [text](url). For user mentions use ![](@UXXXXXXXX), for channels use ![](#CXXXXXXXX).",
      inputSchema: z.object({
        channel: z.string().describe("Channel ID"),
        title: z.string().optional(),
        markdown: z.string().optional().describe("Initial canvas content in standard markdown"),
      }),
      execute: async ({ channel, title, markdown }) =>
        createChannelCanvas(app, channel, title, markdown),
    }),
    slack_edit_canvas: tool({
      description:
        "Edit a Slack canvas. Use slack_lookup_canvas_sections first to get section IDs for targeted edits. Content must be standard markdown (NOT Slack mrkdwn): use ## headings, - bullets, **bold**, [text](url). For user mentions use ![](@UXXXXXXXX), for channels use ![](#CXXXXXXXX).",
      inputSchema: z.object({
        canvasId: z.string(),
        operation: z.enum([
          "insert_at_start",
          "insert_at_end",
          "insert_after",
          "insert_before",
          "replace",
          "delete",
          "rename",
        ]),
        markdown: z.string().optional().describe("Content for insert/replace operations"),
        sectionId: z.string().optional().describe("Target section for positional operations"),
        title: z.string().optional().describe("New title for rename operation"),
      }),
      execute: async ({ canvasId, operation, markdown, sectionId, title }) =>
        editCanvas(app, canvasId, operation, { markdown, sectionId, title }),
    }),
    slack_lookup_canvas_sections: tool({
      description: "Find sections in a Slack canvas by heading type or text content",
      inputSchema: z.object({
        canvasId: z.string(),
        sectionTypes: z.array(z.enum(["h1", "h2", "h3", "any_header"])).optional(),
        containsText: z.string().optional(),
      }),
      execute: async ({ canvasId, sectionTypes, containsText }) =>
        lookupCanvasSections(app, canvasId, { sectionTypes, containsText }),
    }),

    // Google Calendar tools
    ...(slackUserId
      ? {
          google_search_events: tool({
            description:
              "Search Google Calendar events. Use to find meetings, check schedules, or look up past/upcoming events.",
            inputSchema: z.object({
              query: z.string().optional().describe("Text to search for in event titles/descriptions"),
              daysBack: z.number().optional().describe("How many days in the past to search (default 7)"),
              daysForward: z.number().optional().describe("How many days in the future to search (default 0)"),
            }),
            execute: async ({ query, daysBack, daysForward }) =>
              googleCal.searchEvents(slackUserId, { query, daysBack, daysForward }),
          }),
          google_get_meeting_notes: tool({
            description:
              "Get notes/transcripts from Google Docs attached to calendar events. Use for meeting deliverables, action items, or summaries.",
            inputSchema: z.object({
              query: z.string().optional().describe("Text to search for in event titles (e.g. 'AI meeting')"),
              daysBack: z.number().optional().describe("How many days back to search (default 7)"),
            }),
            execute: async ({ query, daysBack }) =>
              googleCal.getEventNotes(slackUserId, { query, daysBack }),
          }),
        }
      : {}),

    // Memory tools
    ...(config.ai.supermemoryApiKey && slackUserId
      ? {
          memory_search: tool({
            description:
              "Search saved memories. Use to recall preferences, past decisions, or any stored context about the user or their team.",
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
            description:
              "Save a new memory. Use when the user explicitly asks you to remember something, or when they share a clear preference/decision worth persisting.",
            inputSchema: z.object({
              content: z.string().describe("The memory content to save"),
              scope: z
                .enum(["user", "org"])
                .describe("'user' for personal memories, 'org' for team-wide memories"),
            }),
            execute: async ({ content, scope }) => {
              const tag =
                scope === "user"
                  ? sm.userTag(slackUserId)
                  : teamId
                    ? sm.orgTag(teamId)
                    : sm.userTag(slackUserId);
              return sm.addMemory(content, tag);
            },
          }),
        }
      : {}),
  };
}
