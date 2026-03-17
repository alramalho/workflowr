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
import { getSlackToken } from "../../db/slack-tokens.js";
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
    slack_upload_file: tool({
      description: "Upload a file to a Slack channel or thread. Either provide content directly OR reference an artifactId from another agent (e.g. database_agent) to upload its stored file.",
      inputSchema: z.object({
        content: z.string().optional().describe("File content as a string. Not needed if artifactId is provided."),
        artifactId: z.string().optional().describe("Artifact ID from another agent. If provided, file content is loaded automatically."),
        filename: z.string().optional().describe("Filename with extension. Falls back to artifact filename if artifactId is used."),
        title: z.string().optional().describe("Human-readable title shown in Slack"),
        channel: z.string().optional().describe("Channel ID to upload to. Falls back to current channel."),
        threadTs: z.string().optional().describe("Thread timestamp to upload into. Falls back to current thread."),
      }),
      execute: async ({ content, artifactId, filename, title, channel, threadTs }) => {
        let fileBytes: Buffer;
        let resolvedFilename: string;

        if (artifactId && ctx.artifacts) {
          const artifact = ctx.artifacts.get(artifactId);
          if (!artifact) return { error: `Artifact "${artifactId}" not found.` };
          fileBytes = artifact.content;
          resolvedFilename = filename || artifact.filename;
        } else if (content) {
          fileBytes = Buffer.from(content, "utf-8");
          resolvedFilename = filename || "file.txt";
        } else {
          return { error: "Provide either content or artifactId." };
        }

        const targetChannel = channel || ctx.channelId;
        if (!targetChannel) return { error: "No channel specified and no current channel context available." };

        if (conversationHistory) {
          const gate = await hasExplicitConfirmation(conversationHistory, `Upload file "${resolvedFilename}" to channel`);
          if (!gate.confirmed) return { error: `Operation blocked: ${gate.reason}. Ask the user to confirm.` };
        }

        const targetThread = threadTs || ctx.threadTs;

        const { upload_url, file_id } = await app.client.files.getUploadURLExternal({
          filename: resolvedFilename,
          length: fileBytes.length,
        }) as any;

        await fetch(upload_url, { method: "POST", body: new Uint8Array(fileBytes) });

        const completeArgs: Record<string, any> = {
          files: [{ id: file_id, title: title || resolvedFilename }],
          channel_id: targetChannel,
        };
        if (targetThread) completeArgs.thread_ts = targetThread;
        await app.client.files.completeUploadExternal(completeArgs as any);

        return { ok: true, filename: resolvedFilename, channel: targetChannel };
      },
    }),
    slack_search_messages: tool({
      description:
        "Search Slack messages using the authenticated user's token. Supports Slack search modifiers: " +
        "from:@user, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD, has:link, has:reaction, etc. " +
        "Useful for finding threads by participant, keyword, or date range.",
      inputSchema: z.object({
        query: z.string().describe("Slack search query (e.g. 'from:@alice from:@bob deployment')"),
        sort: z.enum(["score", "timestamp"]).optional().describe("Sort by relevance or recency"),
        count: z.number().optional().describe("Number of results (default 20, max 100)"),
      }),
      execute: async ({ query, sort, count }) => {
        const userId = ctx.slackUserId;
        if (!userId) return { error: "No user context available." };

        const userToken = getSlackToken(userId);
        if (!userToken) {
          return {
            error:
              "No Slack user token found. Ask the user to run /slack-auth to connect their account for search.",
          };
        }

        try {
          const params = new URLSearchParams({
            query,
            sort: sort ?? "timestamp",
            count: String(count ?? 20),
          });

          const resp = await fetch(`https://slack.com/api/search.messages?${params}`, {
            headers: { Authorization: `Bearer ${userToken}` },
          });

          const data = (await resp.json()) as any;

          if (!data.ok) {
            if (data.error === "invalid_auth" || data.error === "token_revoked") {
              return { error: "Slack token expired or revoked. Ask the user to run /slack-auth again." };
            }
            return { error: `Slack search failed: ${data.error}` };
          }

          const matches = data.messages?.matches ?? [];
          return {
            total: data.messages?.total ?? 0,
            results: matches.map((m: any) => ({
              text: m.text,
              user: m.user ?? m.username,
              channel: m.channel?.name,
              channelId: m.channel?.id,
              ts: m.ts,
              threadTs: m.thread_ts,
              permalink: m.permalink,
            })),
          };
        } catch (err: any) {
          return { error: `Search request failed: ${err.message}` };
        }
      },
    }),
  };
}
