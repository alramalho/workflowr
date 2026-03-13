import { tool } from "ai";
import { z } from "zod";
import {
  getChannelHistory,
  getThreadReplies,
  createCanvas,
  createChannelCanvas,
  editCanvas,
  listChannelCanvases,
  lookupCanvasSections,
} from "../../integrations/slack.js";
import { hasExplicitConfirmation } from "../confirmation.js";
import type { SubagentContext } from "./types.js";

export function createSlackTools(ctx: SubagentContext) {
  const { app, conversationHistory } = ctx;
  const readCanvases = new Set<string>();
  const listedChannels = new Set<string>();

  return {
    slack_get_channel_history: tool({
      description: "Read recent messages from a Slack channel",
      inputSchema: z.object({
        channel: z.string(),
        limit: z.number().optional(),
      }),
      execute: async ({ channel, limit }) => getChannelHistory(app, channel, limit),
    }),
    slack_get_thread: tool({
      description: "Read replies in a Slack thread",
      inputSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
      }),
      execute: async ({ channel, threadTs }) => getThreadReplies(app, channel, threadTs),
    }),
    slack_list_channel_canvases: tool({
      description: "List canvases (tabs) attached to a Slack channel. Returns canvas IDs, titles, and human-readable channel name.",
      inputSchema: z.object({
        channel: z.string().describe("Channel ID"),
      }),
      execute: async ({ channel }) => {
        listedChannels.add(channel);
        return listChannelCanvases(app, channel);
      },
    }),
    slack_create_canvas: tool({
      description: "Create a standalone Slack canvas. Content uses standard markdown.",
      inputSchema: z.object({
        title: z.string().optional(),
        markdown: z.string().optional().describe("Initial canvas content in standard markdown"),
      }),
      execute: async ({ title, markdown }) => {
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Create canvas${title ? ` "${title}"` : ""}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return createCanvas(app, title, markdown);
      },
    }),
    slack_create_channel_canvas: tool({
      description: "Create a canvas pinned to a Slack channel. Content uses standard markdown.",
      inputSchema: z.object({
        channel: z.string().describe("Channel ID"),
        title: z.string().optional(),
        markdown: z.string().optional().describe("Initial canvas content in standard markdown"),
      }),
      execute: async ({ channel, title, markdown }) => {
        if (!listedChannels.has(channel)) {
          return { error: "You must call slack_list_channel_canvases first to check for existing canvases." };
        }
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Create channel canvas${title ? ` "${title}"` : ""} on channel ${channel}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return createChannelCanvas(app, channel, title, markdown);
      },
    }),
    slack_edit_canvas: tool({
      description: "Edit a Slack canvas. Use slack_lookup_canvas_sections first to get section IDs. Content uses standard markdown.",
      inputSchema: z.object({
        canvasId: z.string(),
        operation: z.enum(["insert_at_start", "insert_at_end", "insert_after", "insert_before", "replace", "delete", "rename"]),
        markdown: z.string().optional().describe("Content for insert/replace operations"),
        sectionId: z.string().optional().describe("Target section for positional operations"),
        title: z.string().optional().describe("New title for rename operation"),
      }),
      execute: async ({ canvasId, operation, markdown, sectionId, title }) => {
        if (!readCanvases.has(canvasId)) {
          return { error: "You must call slack_lookup_canvas_sections first to read the canvas before editing." };
        }
        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Edit canvas ${canvasId}: ${operation}`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }
        return editCanvas(app, canvasId, operation, { markdown, sectionId, title });
      },
    }),
    slack_lookup_canvas_sections: tool({
      description: "Find sections in a Slack canvas by heading type or text content",
      inputSchema: z.object({
        canvasId: z.string(),
        sectionTypes: z.array(z.enum(["h1", "h2", "h3", "any_header"])).optional(),
        containsText: z.string().optional(),
      }),
      execute: async ({ canvasId, sectionTypes, containsText }) => {
        readCanvases.add(canvasId);
        return lookupCanvasSections(app, canvasId, { sectionTypes, containsText });
      },
    }),
  };
}
