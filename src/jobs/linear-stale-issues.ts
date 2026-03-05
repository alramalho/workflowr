import type { App } from "@slack/bolt";
import cron from "node-cron";
import { listStaleIssues } from "../integrations/linear.js";
import { getUserByLinearId } from "../db/users.js";
import { ALLOWED_USERS, ADMIN_USERS } from "../listeners/events.js";

const STALE_DAYS = 15;

function resolveSlackUser(
  assignee: { id: string; name: string },
): string | null {
  const user = getUserByLinearId(assignee.id);
  if (user?.slack_id) return user.slack_id;

  const nameLower = assignee.name.toLowerCase();
  for (const [slackId, name] of Object.entries(ALLOWED_USERS)) {
    if (name.toLowerCase() === nameLower) return slackId;
  }
  return null;
}

export function setupStaleIssuesReporter(app: App) {
  // Daily at 9:00 AM, Monday–Friday
  cron.schedule("0 9 * * 1-5", () => {
    sendStaleIssueDigests(app).catch(console.error);
  });
}

export async function sendStaleIssueDigests(app: App) {
  const issues = await listStaleIssues(STALE_DAYS);
  if (!issues.length) return;

  // Group by assignee slack ID
  const byAssignee = new Map<string, typeof issues>();

  for (const issue of issues) {
    if (!issue.assignee) continue;
    const slackId = resolveSlackUser(issue.assignee);
    if (!slackId) continue;

    const list = byAssignee.get(slackId) ?? [];
    list.push(issue);
    byAssignee.set(slackId, list);
  }

  // Also send a full digest to admin users
  const adminDigest = issues
    .map((i) => {
      const daysSince = Math.floor(
        (Date.now() - new Date(i.updatedAt).getTime()) / (1000 * 60 * 60 * 24),
      );
      const assigneeName = i.assignee?.name ?? "Unassigned";
      return `• <${i.url}|${i.identifier}> ${i.title} — *${assigneeName}* (${daysSince}d idle)`;
    })
    .join("\n");

  for (const adminId of Object.keys(ADMIN_USERS)) {
    await app.client.chat.postMessage({
      channel: adminId,
      text: `*Stale issues (>${STALE_DAYS} days without activity):*\n${adminDigest}`,
    });
  }

  // DM each assignee their own stale issues (skip if they're already an admin — they got the full digest)
  for (const [slackId, assigneeIssues] of byAssignee) {
    if (slackId in ADMIN_USERS) continue;

    const lines = assigneeIssues
      .map((i) => {
        const daysSince = Math.floor(
          (Date.now() - new Date(i.updatedAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        return `• <${i.url}|${i.identifier}> ${i.title} (${daysSince}d idle)`;
      })
      .join("\n");

    await app.client.chat.postMessage({
      channel: slackId,
      text: `Hey, you have ${assigneeIssues.length} stale issue${assigneeIssues.length > 1 ? "s" : ""} (>${STALE_DAYS} days without activity):\n${lines}`,
    });
  }

  console.log(
    `Sent stale issue digests: ${issues.length} issues, ${byAssignee.size} assignees`,
  );
}
