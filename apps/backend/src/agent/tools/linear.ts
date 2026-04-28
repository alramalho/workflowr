import { tool } from "ai";
import { z } from "zod";
import * as linear from "../../integrations/linear.js";
import { hasExplicitConfirmation } from "../confirmation.js";
import { allFilesInDir } from "../../org/tree.js";
import { propagatePerson, findPersonBySlackId } from "../../org/propagate.js";
import { downloadSlackImage } from "../../integrations/translate.js";
import { getOrgByTeamId } from "../../db/orgs.js";
import type { SubagentContext } from "./types.js";

export function createLinearTools(ctx: SubagentContext) {
  const { app, teamId, conversationHistory, channelId, threadTs } = ctx;

  return {
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
    linear_list_issues: tool({
      description: "List Linear issues with filters (assignee, team, state, activity). Use this instead of search when filtering by structured fields.",
      inputSchema: z.object({
        assigneeName: z.string().optional().describe("Filter by assignee display name"),
        teamId: z.string().optional().describe("Filter by team ID"),
        stateId: z.string().optional().describe("Filter by workflow state ID"),
        stateName: z.string().optional().describe("Filter by state name (e.g. 'In Progress', 'Done')"),
        updatedBefore: z.string().optional().describe("Only issues last updated before this ISO date"),
        limit: z.number().optional().describe("Max results to return (default 20)"),
      }),
      execute: async (filters) => linear.listIssues(filters),
    }),
    linear_create_issue: tool({
      description: "Create a new Linear issue. Pass assigneeId if the user wants it assigned. Use linear_list_labels / linear_list_projects to resolve IDs. Automatically syncs the current Slack thread.",
      inputSchema: z.object({
        teamId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.number().min(0).max(4).optional(),
        assigneeId: z.string().optional().describe("Linear user ID to assign the issue to"),
        labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
        projectId: z.string().optional().describe("Project ID to add the issue to"),
      }),
      execute: async ({ teamId: tId, title, description, priority, assigneeId, labelIds, projectId }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Create Linear issue "${title}"`);
          if (!gate.confirmed) return { error: `Operation blocked: user did not provide explicit confirmation. ${gate.reason}. Ask the user to confirm before retrying.` };
        }
        const issue = await linear.createIssue(tId, title, description, priority, assigneeId, labelIds, projectId);
        if (issue && channelId && threadTs) {
          try {
            let threadUrl: string;
            try {
              const permalink = await app.client.chat.getPermalink({ channel: channelId, message_ts: threadTs });
              threadUrl = permalink.permalink!;
            } catch {
              const domain = teamId ? getOrgByTeamId(teamId)?.slack_domain : undefined;
              threadUrl = `https://${domain ?? "slack"}.slack.com/archives/${channelId}/p${threadTs.replace(".", "")}`;
            }
            await linear.attachSlackThread(issue.id, threadUrl);
          } catch (e) {
            console.error("Failed to link Slack thread to Linear issue:", e);
          }
        }
        return issue;
      },
    }),
    linear_list_labels: tool({
      description: "List available Linear issue labels (optionally filtered by team)",
      inputSchema: z.object({ teamId: z.string().optional() }),
      execute: async ({ teamId: tId }) => linear.listLabels(tId),
    }),
    linear_list_projects: tool({
      description: "List available Linear projects",
      inputSchema: z.object({}),
      execute: async () => linear.listProjects(),
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
      execute: async ({ issueId, ...fields }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Update Linear issue ${issueId}: ${JSON.stringify(fields)}`);
          if (!gate.confirmed) return { error: `Operation blocked: user did not provide explicit confirmation. ${gate.reason}. Ask the user to confirm before retrying.` };
        }
        return linear.updateIssue(issueId, fields);
      },
    }),
    linear_add_comment: tool({
      description: "Add a comment to a Linear issue",
      inputSchema: z.object({
        issueId: z.string(),
        body: z.string(),
      }),
      execute: async ({ issueId, body }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Add comment to Linear issue ${issueId}`);
          if (!gate.confirmed) return { error: `Operation blocked: user did not provide explicit confirmation. ${gate.reason}. Ask the user to confirm before retrying.` };
        }
        return linear.addComment(issueId, body);
      },
    }),
    linear_list_teams: tool({
      description: "List all available Linear teams",
      inputSchema: z.object({}),
      execute: async () => linear.listTeams(),
    }),
    linear_get_workflow_states: tool({
      description: "Get available workflow statuses for a Linear team",
      inputSchema: z.object({ teamId: z.string() }),
      execute: async ({ teamId: tId }) => linear.getWorkflowStates(tId),
    }),
    linear_list_members: tool({
      description: "List Linear workspace members. Also syncs Linear IDs to org members by matching emails with Slack profiles.",
      inputSchema: z.object({}),
      execute: async () => {
        const members = await linear.listMembers();
        try {
          if (teamId) {
            const people = (await allFilesInDir(teamId, "people")).filter((f) => f.name !== "_index.mdx" && !f.frontmatter.linear_id);
            if (people.length > 0) {
              const slackEmails = new Map<string, string>();
              for (const p of people) {
                try {
                  const info = await app.client.users.info({ user: p.frontmatter.slack_id });
                  const email = info.user?.profile?.email;
                  if (email) slackEmails.set(email.toLowerCase(), p.frontmatter.slack_id);
                } catch {}
              }
              for (const lm of members) {
                if (!lm.email) continue;
                const slackId = slackEmails.get(lm.email.toLowerCase());
                if (slackId) {
                  const person = await findPersonBySlackId(teamId, slackId);
                  if (person) {
                    await propagatePerson(teamId, { slackId, name: person.frontmatter.name, linearId: lm.id });
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error("Linear→Slack email sync failed:", e);
        }
        return members;
      },
    }),
    linear_upload_slack_image: tool({
      description: "Download an image from Slack and upload it to Linear. Returns a Linear-hosted URL for embedding in issue descriptions as markdown: ![alt](url). Use the slack_url from thread context file annotations.",
      inputSchema: z.object({
        slackUrl: z.string().describe("Slack url_private for the image"),
        filename: z.string().describe("Original filename"),
        mimeType: z.string().describe("MIME type (e.g. image/png, image/jpeg)"),
      }),
      execute: async ({ slackUrl, filename, mimeType }) => {
        const imageData = await downloadSlackImage(slackUrl);
        const assetUrl = await linear.uploadImage(imageData, filename, mimeType);
        return { assetUrl, markdown: `![${filename}](${assetUrl})` };
      },
    }),
  };
}
