import type { App } from "@slack/bolt";
import { google } from "googleapis";
import { config } from "../config.js";
import { getToken, deleteToken } from "../db/tokens.js";
import { sendWeeklyReport } from "../jobs/weekly-report.js";
import * as sm from "../integrations/supermemory.js";
import { buildMemoryBlocks, buildTaskBlocks } from "./actions.js";
import { getOrgByTeamId, createOrg, updateOrg } from "../db/orgs.js";
import { enrichOrgFromUrl } from "../jobs/org-awareness.js";

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

  app.command("/remember", async ({ command, ack }) => {
    await ack();

    if (!config.ai.supermemoryApiKey) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Memory is not configured on this bot.",
      });
      return;
    }

    const content = command.text?.trim();
    if (!content) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/remember something you want me to remember`",
      });
      return;
    }

    try {
      await sm.addMemory(content, sm.userTag(command.user_id));
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Remembered: _${content}_`,
      });
    } catch (error) {
      console.error("Remember command error:", error);
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Something went wrong saving that memory.",
      });
    }
  });

  app.command("/setup-org", async ({ command, ack }) => {
    await ack();

    if (!("trigger_id" in command)) return;

    const existing = command.team_id ? getOrgByTeamId(command.team_id) : undefined;

    if (existing?.url && existing?.description) {
      // org already set up — show current info with edit/delete options
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Current organization setup",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*${existing.name}*`,
                existing.url ? `URL: ${existing.url}` : null,
                existing.description ? `> ${existing.description}` : null,
                existing.industry ? `Industry: ${existing.industry}` : null,
                existing.location ? `Location: ${existing.location}` : null,
              ].filter(Boolean).join("\n"),
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Edit" },
                action_id: "setup_org_edit",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Delete" },
                action_id: "setup_org_delete",
                style: "danger",
                confirm: {
                  title: { type: "plain_text", text: "Delete organization?" },
                  text: { type: "plain_text", text: "This will remove all organization data. Member profiles will be kept." },
                  confirm: { type: "plain_text", text: "Delete" },
                  deny: { type: "plain_text", text: "Cancel" },
                },
              },
            ],
          },
        ],
      });
      return;
    }

    await app.client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: "modal",
        callback_id: "setup_org_modal",
        title: { type: "plain_text", text: "Setup Organization" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "org_url_block",
            label: { type: "plain_text", text: "Organization URL" },
            element: {
              type: "plain_text_input",
              action_id: "org_url",
              placeholder: { type: "plain_text", text: "e.g. chatarmin.com" },
              ...(existing?.url ? { initial_value: existing.url } : {}),
            },
          },
        ],
      },
    });
  });

  app.command("/my-workflowr", async ({ command, ack }) => {
    await ack();

    try {
      const blocks = buildTaskBlocks(command.user_id, command.team_id);

      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Your tasks",
        blocks,
      });
    } catch (error) {
      console.error("My workflowr command error:", error);
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Something went wrong fetching your tasks.",
      });
    }
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
