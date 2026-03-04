import type { App } from "@slack/bolt";
import { google } from "googleapis";
import { config } from "../config.js";
import { getToken, deleteToken } from "../db/tokens.js";
import { sendWeeklyReport } from "../jobs/weekly-report.js";
import * as sm from "../integrations/supermemory.js";
import { buildMemoryBlocks } from "./actions.js";

const REPOS = [{ owner: "chatarmin", repo: "slack-workflows" }];

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function registerCommands(app: App) {
  app.command("/google-auth", async ({ command, ack }) => {
    await ack();

    if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Google OAuth is not configured on this bot.",
      });
      return;
    }

    const existing = getToken(command.user_id);
    if (existing) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `You already have a Google account connected (${existing.email ?? "unknown email"}). Use \`/google-disconnect\` first to reconnect a different account.`,
      });
      return;
    }

    const oauth2 = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri
    );

    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: GOOGLE_SCOPES,
      state: command.user_id,
      prompt: "consent",
    });

    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `<${authUrl}|Click here to connect your Google account>`,
    });
  });

  app.command("/google-disconnect", async ({ command, ack }) => {
    await ack();

    const existing = getToken(command.user_id);
    if (!existing) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "No Google account connected.",
      });
      return;
    }

    deleteToken(command.user_id);
    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Google account disconnected.",
    });
  });

  app.command("/memory", async ({ command, ack }) => {
    await ack();

    if (!config.ai.supermemoryApiKey) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Memory is not configured on this bot.",
      });
      return;
    }

    try {
      const [userRes, orgRes] = await Promise.all([
        sm.listMemories(sm.userTag(command.user_id)),
        command.team_id
          ? sm.listMemories(sm.orgTag(command.team_id))
          : Promise.resolve({ memories: [] }),
      ]);

      const blocks = buildMemoryBlocks(
        userRes.memories,
        orgRes.memories,
      );

      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Your memories",
        blocks,
      });
    } catch (error) {
      console.error("Memory command error:", error);
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Something went wrong fetching memories.",
      });
    }
  });
}
