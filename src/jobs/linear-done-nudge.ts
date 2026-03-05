import type { App } from "@slack/bolt";
import { scheduleJob } from "../db/delayed-jobs.js";
import { registerJobHandler } from "./job-runner.js";
import { getThreadReplies } from "../integrations/slack.js";
import { searchIssues, getIssue } from "../integrations/linear.js";
import { getUserByLinearId } from "../db/users.js";
import { ALLOWED_USERS } from "../listeners/events.js";

const JOB_TYPE = "linear-done-nudge";
const DELAY_MS = 60 * 60 * 1000; // 1 hour
const DONE_PATTERN = /changed status to Done for.*?([A-Z]+-\d+)/i;

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

  // app.event('message') receives ALL messages including bot messages
  // (unlike app.message() which filters them out)
  app.event("message", async ({ event }) => {
    const msg = event as any;
    if (!msg.bot_id && !msg.bot_profile) return;
    if (!isLinearBot(msg)) return;

    const text = extractText(msg);
    const match = text.match(DONE_PATTERN);
    if (!match) return;

    const issueIdentifier = match[1];
    const channel = msg.channel;
    const threadTs = msg.thread_ts ?? msg.ts;

    const key = `${JOB_TYPE}:${channel}:${threadTs}`;
    const runAt = new Date(Date.now() + DELAY_MS);

    const scheduled = scheduleJob(JOB_TYPE, key, {
      channel,
      threadTs,
      issueIdentifier,
      triggerTs: msg.ts,
    }, runAt);

    if (scheduled) {
      console.log(
        `Scheduled ${JOB_TYPE} for ${issueIdentifier} in 1h (thread ${threadTs})`,
      );
    }
  });
}

function resolveSlackUser(
  assignee: { id: string; name: string },
): string | null {
  // 1. Try users table (linear_id -> slack_id)
  const user = getUserByLinearId(assignee.id);
  if (user?.slack_id) return user.slack_id;

  // 2. Fallback: match assignee name against ALLOWED_USERS
  const nameLower = assignee.name.toLowerCase();
  for (const [slackId, name] of Object.entries(ALLOWED_USERS)) {
    if (name.toLowerCase() === nameLower) return slackId;
  }

  return null;
}

async function handleNudge(app: App, payload: Record<string, unknown>) {
  const { channel, threadTs, issueIdentifier, triggerTs } = payload as {
    channel: string;
    threadTs: string;
    issueIdentifier: string;
    triggerTs: string;
  };

  const replies = await getThreadReplies(app, channel, threadTs);

  const hasHumanReply = replies.some((msg: any) => {
    if (parseFloat(msg.ts) <= parseFloat(triggerTs)) return false;
    if (msg.subtype || msg.bot_id) return false;
    return !!msg.user;
  });

  if (hasHumanReply) {
    console.log(
      `${JOB_TYPE}: human replied in thread for ${issueIdentifier}, skipping`,
    );
    return;
  }

  // Look up issue assignee
  const results = await searchIssues(issueIdentifier);
  const found = results[0];
  if (!found) {
    console.log(`${JOB_TYPE}: could not find issue ${issueIdentifier}`);
    return;
  }

  const issue = await getIssue(found.id);
  if (!issue.assignee) {
    console.log(`${JOB_TYPE}: ${issueIdentifier} has no assignee`);
    return;
  }

  const slackUserId = resolveSlackUser(issue.assignee);
  if (!slackUserId) {
    console.log(
      `${JOB_TYPE}: no Slack user for Linear assignee ${issue.assignee.name}`,
    );
    return;
  }

  // Get thread permalink for the DM
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

  await app.client.chat.postMessage({
    channel: slackUserId,
    text: `Hey! <${issue.url}|${issueIdentifier}> was marked as Done but nobody followed up in <${threadLink}|the thread>. Was this intentional?`,
  });

  console.log(`${JOB_TYPE}: nudged ${issue.assignee.name} about ${issueIdentifier}`);
}
