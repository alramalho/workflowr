import type { App } from "@slack/bolt";
import { google } from "googleapis";
import { config } from "../config.js";
import { getToken, deleteToken } from "../db/tokens.js";
import { getSlackToken, deleteSlackToken } from "../db/slack-tokens.js";
import { sendWeeklyReport } from "../jobs/weekly-report.js";
import * as sm from "../integrations/supermemory.js";
import { buildMemoryBlocks, buildTaskBlocks } from "./actions.js";
import { getOrgByTeamId, createOrg, updateOrg } from "../db/orgs.js";
import { enrichOrgFromUrl } from "../org/awareness.js";
import { cat } from "../org/tree.js";
import { ALLOWED_USERS, ADMIN_USERS } from "./events.js";
import { bootstrapOrgAwareness } from "../org/awareness.js";
import { countFiles } from "../org/tree.js";
import { logUsage, getUsageSummary } from "../db/usage-log.js";
import { createRunner, getRunnerForUser } from "../db/runners.js";
import { upsertSecret, deleteSecret as removeSecret, listSecrets } from "../db/secrets.js";
import { listSkills, deleteSkill } from "../db/skills.js";
import { parseSkillDescription } from "../agent/skills-parser.js";

const REPOS = [{ owner: "chatarmin", repo: "slack-workflows" }];

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function registerCommands(app: App) {
  const logCmd = (command: { user_id: string; team_id: string; channel_id: string }, name: string) =>
    logUsage({
      userId: command.user_id,
      userName: ALLOWED_USERS[command.user_id],
      teamId: command.team_id,
      invocationType: `command:${name}`,
      channelId: command.channel_id,
    });

  app.command("/google-auth", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/google-auth");

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
    logCmd(command, "/google-disconnect");

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

  app.command("/slack-auth", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/slack-auth");

    if (!config.slack.clientId || !config.slack.clientSecret || !config.slack.redirectUri) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Slack user OAuth is not configured on this bot.",
      });
      return;
    }

    const existing = getSlackToken(command.user_id);
    if (existing) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You already have a Slack user token connected. Use `/slack-disconnect` first to reconnect.",
      });
      return;
    }

    const params = new URLSearchParams({
      client_id: config.slack.clientId,
      user_scope: "search:read",
      redirect_uri: config.slack.redirectUri,
      state: command.user_id,
    });

    const authUrl = `https://slack.com/oauth/v2/authorize?${params}`;

    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `<${authUrl}|Click here to connect your Slack account for search>`,
    });
  });

  app.command("/slack-disconnect", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/slack-disconnect");

    const existing = getSlackToken(command.user_id);
    if (!existing) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "No Slack user token connected.",
      });
      return;
    }

    deleteSlackToken(command.user_id);
    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Slack user token disconnected.",
    });
  });

  app.command("/remember", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/remember");

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
      const rephrased = await sm.rephraseMemory(content);
      await sm.addMemory(rephrased, sm.userTag(command.user_id));
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Remembered: _${rephrased}_`,
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

  app.command("/org-setup", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/org-setup");

    if (!("trigger_id" in command)) return;

    const existing = command.team_id ? getOrgByTeamId(command.team_id) : undefined;

    if (existing?.url && existing?.description) {
      // org already set up — show current info + org chart with edit/delete options
      const chart = command.team_id
        ? [cat(command.team_id, "teams/_index.mdx"), cat(command.team_id, "people/_index.mdx")].filter(Boolean).join("\n\n")
        : "";
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
          ...(chart ? [
            { type: "divider" as const },
            {
              type: "section" as const,
              text: { type: "mrkdwn" as const, text: chart },
            },
          ] : []),
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

  app.command("/create-task", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/create-task");

    if (!("trigger_id" in command)) return;

    if (!(command.user_id in ALLOWED_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You're not allowed to use this. Talk to <@U08PH00GP9Q> if you want access.",
      });
      return;
    }

    await app.client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: "modal",
        callback_id: "create_task_modal",
        private_metadata: JSON.stringify({ team_id: command.team_id }),
        title: { type: "plain_text", text: "Create Task" },
        submit: { type: "plain_text", text: "Create" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "task_goal_block",
            label: { type: "plain_text", text: "What do you want me to help with?" },
            element: {
              type: "plain_text_input",
              action_id: "task_goal",
              multiline: true,
              placeholder: { type: "plain_text", text: "e.g. Help me keep deliverables updated after the AI sync meeting" },
            },
          },
        ],
      },
    });
  });

  app.command("/my-workflowr", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/my-workflowr");

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

  app.command("/setup-workflowr", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/setup-workflowr");

    if (!(command.user_id in ALLOWED_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You're not allowed to use this. Talk to <@U08PH00GP9Q> if you want access.",
      });
      return;
    }

    const teamId = command.team_id;
    if (!teamId || !getOrgByTeamId(teamId)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Organization is not set up yet. Run `/org-setup` first.",
      });
      return;
    }

    const statusMsg = await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: ":hourglass_flowing_sand: Running backfill — scanning Slack threads...",
    });

    const filesBefore = countFiles(teamId);
    bootstrapOrgAwareness(app, teamId).then((threadsAnalyzed) => {
      const filesAfter = countFiles(teamId);
      const newFiles = filesAfter - filesBefore;
      app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `:white_check_mark: Backfill complete — ${threadsAnalyzed} threads analyzed, ${filesAfter} files in tree (${newFiles >= 0 ? "+" : ""}${newFiles} net).`,
      });
    }).catch((err) => {
      console.error("[setup-workflowr] Backfill failed:", err);
      app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: ":x: Backfill failed. Check logs.",
      });
    });
  });

  app.command("/memories", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/memories");

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

  app.command("/usage", async ({ command, ack }) => {
    await ack();

    if (!(command.user_id in ADMIN_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You're not authorized to use this.",
      });
      return;
    }

    const daysArg = parseInt(command.text?.trim() || "30", 10);
    const days = Number.isNaN(daysArg) || daysArg < 1 ? 30 : daysArg;
    const summary = getUsageSummary(days);

    const userLines = summary.byUser
      .map((u, i) => `${i + 1}. <@${u.user_id}> — ${u.count} calls`)
      .join("\n");

    const typeLines = summary.byType
      .map((t) => `• \`${t.invocation_type}\` — ${t.count}`)
      .join("\n");

    const activityLines = summary.recentActivity
      .map((a) => `${a.date}: ${a.count}`)
      .join("\n");

    const cetNote = "_Times stored in UTC. Dates shown as UTC days._";

    const text = [
      `*Usage Summary (last ${days} days)*`,
      "",
      `*Total invocations:* ${summary.totalCalls}`,
      `*Total tool calls:* ${summary.totalToolCalls}`,
      "",
      `*Top Users:*`,
      userLines || "_No activity_",
      "",
      `*By Invocation Type:*`,
      typeLines || "_No activity_",
      "",
      `*Daily Activity (last 14 days):*`,
      activityLines ? `\`\`\`${activityLines}\`\`\`` : "_No activity_",
      "",
      cetNote,
    ].join("\n");

    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text,
    });
  });

  app.command("/setup-daemon", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/setup-daemon");

    if (!(command.user_id in ALLOWED_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You're not allowed to use this. Talk to <@U08PH00GP9Q> if you want access.",
      });
      return;
    }

    const existing = getRunnerForUser(command.user_id, command.team_id);
    if (existing && existing.status === "connected") {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "You already have a runner connected. To set up a new one, disconnect the existing one first.",
      });
      return;
    }

    const runner = existing ?? createRunner(command.user_id, command.team_id);
    const serverUrl = config.oauthServerUrl ?? `http://localhost:${config.oauthPort}`;
    const installCmd = `curl -fsSL ${serverUrl}/runner/install.sh | bash -s ${runner.token}`;

    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: [
        "👾 *Daemon Setup*",
        "",
        "Run this on your machine from the directory where your projects live (e.g. `~/workspace`):",
        "",
        `\`\`\`${installCmd}\`\`\``,
        "",
        "It will ask which directory to use, then install a background service that auto-starts on login. Once connected, workflowr can explore your code when you ask questions.",
      ].join("\n"),
    });
  });

  app.command("/set-secret", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/set-secret");

    if (!(command.user_id in ADMIN_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Only admins can manage secrets.",
      });
      return;
    }

    const parts = command.text?.trim().split(/\s+/);
    if (!parts || parts.length < 2) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/set-secret <name> <value>`",
      });
      return;
    }

    const [name, ...rest] = parts;
    const value = rest.join(" ");
    upsertSecret(command.team_id, name, value, command.user_id);

    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Secret \`${name}\` saved.`,
    });
  });

  app.command("/delete-secret", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/delete-secret");

    if (!(command.user_id in ADMIN_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Only admins can manage secrets.",
      });
      return;
    }

    const name = command.text?.trim();
    if (!name) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/delete-secret <name>`",
      });
      return;
    }

    const deleted = removeSecret(command.team_id, name);
    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: deleted ? `Secret \`${name}\` deleted.` : `Secret \`${name}\` not found.`,
    });
  });

  app.command("/list-secrets", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/list-secrets");

    if (!(command.user_id in ADMIN_USERS)) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Only admins can manage secrets.",
      });
      return;
    }

    const secrets = listSecrets(command.team_id);
    if (secrets.length === 0) {
      await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "No secrets configured.",
      });
      return;
    }

    const lines = secrets.map((s) => `• \`${s.name}\` — set ${s.created_at}${s.created_by ? ` by <@${s.created_by}>` : ""}`);
    await app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `*Secrets:*\n${lines.join("\n")}`,
    });
  });

  app.command("/skills", async ({ command, ack }) => {
    await ack();
    logCmd(command, "/skills");

    const text = command.text?.trim() ?? "";
    const spaceIdx = text.indexOf(" ");
    const subcommand = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const arg = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    switch (subcommand) {
      case "new": {
        if (!(command.user_id in ALLOWED_USERS)) {
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "You're not allowed to use this. Talk to <@U08PH00GP9Q> if you want access.",
          });
          return;
        }

        if (!arg) {
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Usage: `/skills new <describe your skill in natural language>`",
          });
          return;
        }

        await app.client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `> ${arg}\n:hourglass_flowing_sand: Parsing your skill description...`,
        });

        try {
          const parsed = await parseSkillDescription(arg);

          const previewLines = [
            `*Skill Preview*`,
            "",
            `*Name:* \`${parsed.name}\``,
            `*Description:* ${parsed.description}`,
            `*Content:*`,
            parsed.content,
          ];

          const payload = JSON.stringify({
            teamId: command.team_id,
            userId: command.user_id,
            skill: parsed,
          });

          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: previewLines.join("\n"),
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: previewLines.join("\n") },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Create" },
                    action_id: "skill_confirm",
                    style: "primary",
                    value: payload,
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Correct" },
                    action_id: "skill_correct",
                    value: payload,
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Reject" },
                    action_id: "skill_cancel",
                    style: "danger",
                  },
                ],
              },
            ],
          });
        } catch (error) {
          console.error("Skill parsing error:", error);
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Something went wrong parsing that skill description. Try rephrasing it.",
          });
        }
        return;
      }

      case "list": {
        const skills = listSkills(command.team_id);
        if (skills.length === 0) {
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "No skills configured. Use `/skills new <description>` to create one.",
          });
          return;
        }

        const lines = skills.map((s) => {
          return `• \`${s.name}\` — ${s.description}${s.created_by ? ` | _by_ <@${s.created_by}>` : ""}`;
        });
        await app.client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `*Skills:*\n${lines.join("\n")}`,
        });
        return;
      }

      case "delete": {
        if (!(command.user_id in ALLOWED_USERS)) {
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "You're not allowed to use this.",
          });
          return;
        }

        if (!arg) {
          await app.client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Usage: `/skills delete <name>`",
          });
          return;
        }

        const deleted = deleteSkill(command.team_id, arg);
        await app.client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: deleted ? `Skill \`${arg}\` deleted.` : `Skill \`${arg}\` not found.`,
        });
        return;
      }

      case "help":
      default: {
        await app.client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: [
            "*Skills* — custom automations the bot can trigger",
            "",
            "`/skills new <description>` — Create a skill from a natural language description",
            "`/skills list` — List all skills for your team",
            "`/skills delete <name>` — Delete a skill",
            "`/skills help` — Show this help",
            "",
            "*Example:*",
            "`/skills new trigger AI evals via https://api.example.com/evals with my-key as auth header when someone asks to run evals`",
          ].join("\n"),
        });
        return;
      }
    }
  });
}
