import type { App as SlackApp } from "@slack/bolt";
import express from "express";
import { google } from "googleapis";
import { config } from "./config.js";
import { upsertToken } from "./db/tokens.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";
import { getAllOrgMembers } from "./db/org-members.js";
import { clearThreadLocks } from "./db/thread-reads.js";
import { analyzeThread } from "./jobs/org-awareness.js";

interface ServerOptions {
  slackApp: SlackApp;
  channel: string;
  repos: { owner: string; repo: string }[];
}

export function startOAuthServer(port: number, opts: ServerOptions) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.send("ok");
  });

  app.post("/trigger/weekly-report", async (_req, res) => {
    try {
      await sendWeeklyReport(opts.slackApp, opts.channel, opts.repos);
      res.send("Weekly report sent.");
    } catch (err) {
      console.error("Manual weekly report error:", err);
      res.status(500).send("Failed to send weekly report.");
    }
  });

  app.get("/debug/org", (_req, res) => {
    const members = getAllOrgMembers();
    const hierarchy = members.map((m) => {
      const manager = m.reports_to
        ? members.find((o) => o.slack_id === m.reports_to)?.name ?? m.reports_to
        : null;
      return {
        name: m.name,
        slackId: m.slack_id,
        role: m.role,
        reportsTo: manager,
        writingStyle: m.writing_style,
        representativeExampleMessage: m.representative_example_message,
        updatedAt: m.updated_at,
      };
    });
    res.json(hierarchy);
  });

  app.post("/trigger/org-rewatch", express.json(), async (req, res) => {
    const { slackId, days = 7 } = req.body ?? {};
    if (!slackId) {
      res.status(400).json({ error: "slackId is required" });
      return;
    }

    const oldest = String(
      Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000),
    );

    res.json({ status: "started", slackId, days });

    // fire-and-forget: scan channels for threads involving this user
    const CONCURRENCY = 5;
    (async () => {
      try {
        const channels = await opts.slackApp.client.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 200,
        });

        // phase 1: collect all candidate threads (sequential — Slack rate limits)
        const candidates: { channelId: string; threadTs: string }[] = [];
        const threadsSeen = new Set<string>();

        for (const ch of channels.channels ?? []) {
          if (!ch.id || !ch.is_member) continue;

          const history = await opts.slackApp.client.conversations.history({
            channel: ch.id,
            oldest,
            limit: 200,
          });

          for (const msg of history.messages ?? []) {
            const m = msg as any;
            if (!m.reply_count || m.reply_count === 0) continue;

            const threadKey = `${ch.id}:${m.ts}`;
            if (threadsSeen.has(threadKey)) continue;
            threadsSeen.add(threadKey);

            const replies = await opts.slackApp.client.conversations.replies({
              channel: ch.id,
              ts: m.ts,
              limit: 200,
            });
            const hasUser = (replies.messages ?? []).some(
              (r: any) => r.user === slackId,
            );
            if (!hasUser) continue;

            candidates.push({ channelId: ch.id, threadTs: m.ts });
          }
        }

        console.log(`[org-rewatch] Found ${candidates.length} threads for ${slackId}, analyzing ${CONCURRENCY} at a time...`);

        // phase 2: analyze in parallel batches
        let analyzed = 0;
        for (let i = 0; i < candidates.length; i += CONCURRENCY) {
          const batch = candidates.slice(i, i + CONCURRENCY);
          await Promise.all(
            batch.map(async ({ channelId, threadTs }) => {
              clearThreadLocks(channelId);
              await analyzeThread(opts.slackApp, channelId, threadTs);
              analyzed++;
            }),
          );
        }

        console.log(`[org-rewatch] Done: analyzed ${analyzed} threads for ${slackId} (past ${days} days)`);
      } catch (err) {
        console.error("[org-rewatch] Error:", err);
      }
    })();
  });

  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        config.google.clientId,
        config.google.clientSecret,
        config.google.redirectUri
      );

      const { tokens } = await oauth2.getToken(code);

      if (!tokens.refresh_token) {
        res.status(400).send(
          "No refresh token received. You may have already authorized this app. " +
          "Revoke access at https://myaccount.google.com/permissions and try again."
        );
        return;
      }

      let email: string | undefined;
      try {
        oauth2.setCredentials(tokens);
        const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
        const { data } = await oauth2Api.userinfo.get();
        email = data.email ?? undefined;
      } catch {
        // non-critical, continue without email
      }

      upsertToken(state, tokens.refresh_token, email);

      res.send("Google account connected successfully! You can close this tab and return to Slack.");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Failed to connect Google account. Please try again.");
    }
  });

  app.listen(port, () => {
    console.log(`OAuth callback server listening on port ${port}`);
  });
}
