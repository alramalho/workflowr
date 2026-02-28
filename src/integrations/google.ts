import { google } from "googleapis";
import { config } from "../config.js";
import { getToken } from "../db/tokens.js";

function getAuthClient(slackUserId: string) {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error("Google client credentials not configured");
  }

  const stored = getToken(slackUserId);
  if (!stored) {
    throw new Error(
      "Google account not connected. Use /google-auth to connect your account."
    );
  }

  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret
  );
  auth.setCredentials({ refresh_token: stored.refresh_token });
  return auth;
}

export async function getUpcomingEvents(slackUserId: string, calendarId = "primary", days = 7) {
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const { data } = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return data.items ?? [];
}

export async function getRecentMeetingNotes(slackUserId: string, calendarId = "primary") {
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();

  const { data: events } = await calendar.events.list({
    calendarId,
    timeMin: yesterday.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const results: Array<{ event: string; transcript: string }> = [];

  for (const event of events.items ?? []) {
    if (!event.attachments) continue;

    for (const attachment of event.attachments) {
      if (attachment.mimeType === "application/vnd.google-apps.document") {
        const { data: doc } = await docs.documents.get({
          documentId: attachment.fileId!,
        });

        const text = doc.body?.content
          ?.map((el) =>
            el.paragraph?.elements?.map((e) => e.textRun?.content).join("")
          )
          .join("")
          ?? "";

        results.push({ event: event.summary ?? "Untitled", transcript: text });
      }
    }
  }

  return results;
}
