import type { App as SlackApp } from "@slack/bolt";
import express from "express";
import { google } from "googleapis";
import { config } from "./config.js";
import { upsertToken } from "./db/tokens.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";

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
