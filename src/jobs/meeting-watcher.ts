import type { App } from "@slack/bolt";
import { getUpcomingEvents } from "../integrations/google.js";
import { getAllTokens } from "../db/tokens.js";
import { sendMeetingDeliverables } from "./meeting-deliverables.js";

const MEETING_KEYWORD = process.env.MEETING_KEYWORD ?? "AI dev sync";
const POST_DELAY_MS = 10 * 60 * 1000; // 10 min after meeting ends

const scheduledMeetings = new Map<string, NodeJS.Timeout>();

export function startMeetingWatcher(app: App, channel: string) {
  // Check calendar every 15 minutes
  const interval = setInterval(() => {
    checkForMeetings(app, channel).catch(console.error);
  }, 15 * 60 * 1000);

  // Also check immediately on startup
  checkForMeetings(app, channel).catch(console.error);

  return () => {
    clearInterval(interval);
    for (const timer of scheduledMeetings.values()) clearTimeout(timer);
    scheduledMeetings.clear();
  };
}

async function checkForMeetings(app: App, channel: string) {
  const users = getAllTokens();

  for (const { slack_user_id } of users) {
    try {
      const events = await getUpcomingEvents(slack_user_id, "primary", 1);

      const match = events.find((e) =>
        e.summary?.toLowerCase().includes(MEETING_KEYWORD.toLowerCase())
      );

      if (!match || !match.end?.dateTime || !match.id) continue;

      const meetingKey = `${match.id}-${match.end.dateTime}`;

      // Already scheduled for this exact time
      if (scheduledMeetings.has(meetingKey)) continue;

      // Cancel any previously scheduled version (meeting was rescheduled)
      for (const [key, timer] of scheduledMeetings) {
        if (key.startsWith(match.id + "-") && key !== meetingKey) {
          clearTimeout(timer);
          scheduledMeetings.delete(key);
          console.log(`Rescheduled: cancelled old timer for ${key}`);
        }
      }

      const endTime = new Date(match.end.dateTime).getTime();
      const fireAt = endTime + POST_DELAY_MS;
      const delay = fireAt - Date.now();

      if (delay < 0) continue; // meeting already passed

      console.log(
        `Scheduled deliverables post for "${match.summary}" at ${new Date(fireAt).toISOString()}`
      );

      const timer = setTimeout(async () => {
        console.log(`Firing deliverables post for "${match.summary}"`);
        await sendMeetingDeliverables(app, channel).catch(console.error);
        scheduledMeetings.delete(meetingKey);
      }, delay);

      scheduledMeetings.set(meetingKey, timer);
    } catch (err) {
      console.error(`Failed to check calendar for user ${slack_user_id}:`, err);
    }
  }
}
