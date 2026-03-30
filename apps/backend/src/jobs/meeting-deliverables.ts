import type { App } from "@slack/bolt";
import { getEventNotes } from "../integrations/google.js";
import { postMessage } from "../integrations/slack.js";
import { getAllTokens } from "../db/tokens.js";

export async function sendMeetingDeliverables(app: App, channel: string, slackUserId?: string) {
  if (slackUserId) {
    const notes = await getEventNotes(slackUserId, { daysBack: 1 });
    if (notes.length === 0) return;

    for (const { event, transcript } of notes) {
      const summary = transcript.slice(0, 2000);
      await postMessage(app, channel, `*Meeting notes from: ${event}*\n\n${summary}`);
    }
  } else {
    const users = getAllTokens();
    for (const { slack_user_id } of users) {
      try {
        const notes = await getEventNotes(slack_user_id, { daysBack: 1 });
        if (notes.length === 0) continue;

        for (const { event, transcript } of notes) {
          const summary = transcript.slice(0, 2000);
          await postMessage(app, channel, `*Meeting notes from: ${event}* (via <@${slack_user_id}>)\n\n${summary}`);
        }
      } catch (err) {
        console.error(`Failed to get meeting notes for user ${slack_user_id}:`, err);
      }
    }
  }
}
