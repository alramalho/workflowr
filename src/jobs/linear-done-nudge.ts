import type { App } from "@slack/bolt";
import { scheduleJob } from "../db/delayed-jobs.js";
import { registerJobHandler } from "./job-runner.js";
import { getThreadReplies } from "../integrations/slack.js";
import { getIssueByIdentifier } from "../integrations/linear.js";
import {
  linkIssueToThread,
  getUnresolvedLinks,
  markResolved,
} from "../db/issue-thread-links.js";
import { ADMIN_USERS } from "../listeners/events.js";
import { getAllOrgMembers } from "../db/org-members.js";

const JOB_TYPE = "linear-done-nudge";
const NUDGE_DELAY_MS = 60 * 60 * 1000; // 1 hour
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const TICKET_PATTERN = /([A-Z]{2,}-\d+)/;

function extractText(message: any): string {
  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  if (Array.isArray(message.attachments)) {
    for (const att of message.attachments) {
      if (att.text) parts.push(att.text);
      if (att.fallback) parts.push(att.fallback);
    }
  }
  return parts.join(" ");
}

function isLinearBot(message: any): boolean {
  const name = (
    message.username ||
    message.bot_profile?.name ||
    ""
  ).toLowerCase();
  return name.includes("linear");
}

export function setupLinearDoneNudge(app: App) {
  registerJobHandler(JOB_TYPE, handleNudge);

  // Capture ALL Linear bot ticket mentions as links (not just "Done")
  app.event("message", async ({ event }) => {
    const msg = event as any;
    if (!msg.bot_id && !msg.bot_profile) return;
    if (!isLinearBot(msg)) return;

    const text = extractText(msg);
    const match = text.match(TICKET_PATTERN);
    if (!match) return;

    const issueIdentifier = match[1];
    const channel = msg.channel;
    const threadTs = msg.thread_ts ?? msg.ts;

    const linked = linkIssueToThread(issueIdentifier, channel, threadTs);
    if (linked) {
      console.log(`Linked ${issueIdentifier} → thread ${threadTs} in <#${channel}>`);
    }
  });

  // Poll linked issues for Done status
  const interval = setInterval(() => {
    pollLinkedIssues(app).catch(console.error);
  }, POLL_INTERVAL_MS);

  // Also poll on startup (after a short delay to let app initialize)
  setTimeout(() => pollLinkedIssues(app).catch(console.error), 10_000);

  return () => clearInterval(interval);
}

async function pollLinkedIssues(app: App) {
  const links = getUnresolvedLinks();
  if (!links.length) return;

  for (const link of links) {
    try {
      const issue = await getIssueByIdentifier(link.issue_identifier);
      if (!issue) continue;
      if (!issue.state || issue.state.name.toLowerCase() !== "done") continue;

      // Issue is Done — schedule a nudge (dedup by issue identifier)
      const key = `${JOB_TYPE}:${link.issue_identifier}`;
      const runAt = new Date(Date.now() + NUDGE_DELAY_MS);

      scheduleJob(JOB_TYPE, key, {
        channel: link.channel_id,
        threadTs: link.thread_ts,
        issueIdentifier: link.issue_identifier,
        linkId: link.id,
      }, runAt);
    } catch (err) {
      console.error(`Failed to check linked issue ${link.issue_identifier}:`, err);
    }
  }
}

async function handleNudge(app: App, payload: Record<string, unknown>) {
  const { channel, threadTs, issueIdentifier, linkId } = payload as {
    channel: string;
    threadTs: string;
    issueIdentifier: string;
    linkId: number;
  };

  const replies = await getThreadReplies(app, channel, threadTs);

  // Find the most recent Linear bot "Done" message timestamp in this thread
  const doneMsg = [...replies].reverse().find((msg: any) => {
    if (!msg.bot_id && !msg.bot_profile) return false;
    const text = extractText(msg);
    return /changed status to Done/i.test(text) && text.includes(issueIdentifier);
  });
  const doneTs = doneMsg ? parseFloat((doneMsg as any).ts) : 0;

  const hasHumanReply = replies.some((msg: any) => {
    if (doneTs > 0 && parseFloat(msg.ts) <= doneTs) return false;
    if (msg.subtype || msg.bot_id) return false;
    return !!msg.user;
  });

  // Mark link as resolved regardless — we've processed it
  if (linkId) markResolved(linkId);

  if (hasHumanReply) {
    console.log(`${JOB_TYPE}: human replied for ${issueIdentifier}, skipping`);
    return;
  }

  const issue = await getIssueByIdentifier(issueIdentifier);
  if (!issue) return;
  if (!issue.assignee) {
    console.log(`${JOB_TYPE}: ${issueIdentifier} has no assignee`);
    return;
  }

  // Only nudge about issues assigned to admin users
  const orgMembers = getAllOrgMembers();
  const assigneeMember = orgMembers.find(m => m.linear_id === issue.assignee!.id);
  if (!assigneeMember || !ADMIN_USERS[assigneeMember.slack_id]) {
    console.log(`${JOB_TYPE}: ${issueIdentifier} assignee (${issue.assignee.name}) is not an admin, skipping`);
    return;
  }

  let threadLink = "";
  try {
    const permalink = await app.client.chat.getPermalink({
      channel,
      message_ts: threadTs,
    });
    threadLink = permalink.permalink ?? "";
  } catch {
    threadLink = `https://slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
  }

  const assigneeName = issue.assignee.name;
  const msg = `Hey! <${issue.url}|${issueIdentifier}> (assigned to ${assigneeName}) was marked as Done but nobody followed up in <${threadLink}|the thread>. Was this intentional?`;

  // DM admin users only
  for (const adminId of Object.keys(ADMIN_USERS)) {
    await app.client.chat.postMessage({ channel: adminId, text: msg });
  }

  console.log(`${JOB_TYPE}: nudged admins about ${issueIdentifier} (${assigneeName})`);
}
