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

export async function searchEvents(
  slackUserId: string,
  opts: { query?: string; daysBack?: number; daysForward?: number; calendarId?: string } = {}
) {
  const { query, daysBack = 7, daysForward = 0, calendarId = "primary" } = opts;
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const timeMax = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000);

  const { data } = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: query,
  });

  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    description: e.description,
    attendees: e.attendees?.map((a) => a.email),
    hasAttachments: !!e.attachments?.length,
  }));
}

export async function createEvent(
  slackUserId: string,
  opts: {
    summary: string;
    startTime: string;
    endTime: string;
    description?: string;
    attendees?: string[];
    calendarId?: string;
  }
) {
  const { summary, startTime, endTime, description, attendees, calendarId = "primary" } = opts;
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });

  const { data } = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
      attendees: attendees?.map((email) => ({ email })),
    },
  });

  return {
    id: data.id,
    summary: data.summary,
    start: data.start?.dateTime,
    end: data.end?.dateTime,
    htmlLink: data.htmlLink,
  };
}

export async function updateEvent(
  slackUserId: string,
  opts: {
    eventId: string;
    summary?: string;
    startTime?: string;
    endTime?: string;
    description?: string;
    attendees?: string[];
    calendarId?: string;
  }
) {
  const { eventId, summary, startTime, endTime, description, attendees, calendarId = "primary" } = opts;
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });

  const requestBody: Record<string, any> = {};
  if (summary !== undefined) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (startTime !== undefined) requestBody.start = { dateTime: startTime };
  if (endTime !== undefined) requestBody.end = { dateTime: endTime };
  if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));

  const { data } = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody,
  });

  return {
    id: data.id,
    summary: data.summary,
    start: data.start?.dateTime,
    end: data.end?.dateTime,
    htmlLink: data.htmlLink,
  };
}

export async function deleteEvent(
  slackUserId: string,
  opts: { eventId: string; calendarId?: string }
) {
  const { eventId, calendarId = "primary" } = opts;
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });

  await calendar.events.delete({ calendarId, eventId });
  return { deleted: true };
}

export async function getEventNotes(
  slackUserId: string,
  opts: { query?: string; daysBack?: number; calendarId?: string } = {}
) {
  const { query, daysBack = 7, calendarId = "primary" } = opts;
  const auth = getAuthClient(slackUserId);
  const calendar = google.calendar({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const { data: events } = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: query,
  });

  const results: Array<{ event: string; date: string | undefined; transcript: string }> = [];

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

        results.push({
          event: event.summary ?? "Untitled",
          date: event.start?.dateTime ?? event.start?.date ?? undefined,
          transcript: text,
        });
      }
    }
  }

  return results;
}
