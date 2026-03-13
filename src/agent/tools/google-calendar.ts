import { tool } from "ai";
import { z } from "zod";
import * as googleCal from "../../integrations/google.js";
import { hasExplicitConfirmation } from "../confirmation.js";
import type { SubagentContext } from "./types.js";

export function createGoogleCalendarTools(ctx: SubagentContext) {
  const { slackUserId, conversationHistory } = ctx;
  if (!slackUserId) return {};

  return {
    google_search_events: tool({
      description: "Search Google Calendar events",
      inputSchema: z.object({
        query: z.string().optional().describe("Text to search for in event titles/descriptions"),
        daysBack: z.number().optional().describe("Days in the past to search (default 7)"),
        daysForward: z.number().optional().describe("Days in the future to search (default 0)"),
      }),
      execute: async ({ query, daysBack, daysForward }) =>
        googleCal.searchEvents(slackUserId, { query, daysBack, daysForward }),
    }),
    google_create_event: tool({
      description: "Create a Google Calendar event",
      inputSchema: z.object({
        summary: z.string().describe("Event title"),
        startTime: z.string().describe("Start time in ISO 8601 format"),
        endTime: z.string().describe("End time in ISO 8601 format"),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      }),
      execute: async ({ summary, startTime, endTime, description, attendees }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Create calendar event "${summary}"`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return googleCal.createEvent(slackUserId, { summary, startTime, endTime, description, attendees });
      },
    }),
    google_update_event: tool({
      description: "Update an existing Google Calendar event. Search first to find the event ID.",
      inputSchema: z.object({
        eventId: z.string().describe("The event ID to update"),
        summary: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional(),
      }),
      execute: async ({ eventId, ...fields }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Update calendar event ${eventId}: ${JSON.stringify(fields)}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return googleCal.updateEvent(slackUserId, { eventId, ...fields });
      },
    }),
    google_delete_event: tool({
      description: "Delete a Google Calendar event. Search first to find the event ID.",
      inputSchema: z.object({
        eventId: z.string().describe("The event ID to delete"),
      }),
      execute: async ({ eventId }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Delete calendar event ${eventId}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return googleCal.deleteEvent(slackUserId, { eventId });
      },
    }),
    google_get_meeting_notes: tool({
      description: "Get notes/transcripts from Google Docs attached to calendar events",
      inputSchema: z.object({
        query: z.string().optional().describe("Text to search for in event titles"),
        daysBack: z.number().optional().describe("Days back to search (default 7)"),
      }),
      execute: async ({ query, daysBack }) =>
        googleCal.getEventNotes(slackUserId, { query, daysBack }),
    }),
  };
}
